"""Character agent: one decision. Fail closed to idle. Never crash the loop.

Where a character is = agents.target.building_id (kept across actions that don't move them).
Writes: agents, agent_actions (chat bubbles in details.lines), friendships.path_score.
"""

from datetime import datetime, timezone
from random import uniform

from backend.agent.conversation import generate_lines
from backend.agent.prompt import build_agent_system_prompt, build_agent_user_prompt
from backend.agent.validate import parse_raw_json, validate_agent_decision
from backend.config import settings
from backend.db import get_client, iso_in, now_iso, parse_ts, recent_facts
from backend.interactions.path_score import record_interaction
from backend.llm import complete
from backend.calendar_drive import current_trip, next_check_iso
from backend.schedules import label, local_now
from backend.models.agents import (
    ActiveEventSummary,
    AgentDecisionInput,
    AgentDecisionOutput,
    NearbyCharacter,
    RelevantFact,
)
from backend.models.enums import AgentAction, EventStatus, InteractionVia
from backend.town_map import buildings, house_building_id

COMMITTED_ACTIONS = {AgentAction.walk_to.value, AgentAction.visit.value}
SOCIAL_ACTIONS = {AgentAction.visit.value, AgentAction.chat.value, AgentAction.knock.value, AgentAction.leave_gift.value}


def jittered_next_decision() -> str:
    return iso_in(20 + uniform(0, 15))


def location(agent_row: dict) -> str | None:
    return (agent_row.get("target") or {}).get("building_id")


def write_idle(db, town_id: str, user_id: str, reason: str) -> None:
    db.table("agents").update(
        {"action": AgentAction.idle.value, "next_decision_at": jittered_next_decision(), "updated_at": now_iso()}
    ).eq("town_id", town_id).eq("user_id", user_id).execute()
    db.table("agent_actions").insert(
        {"town_id": town_id, "user_id": user_id, "action": AgentAction.idle.value, "details": {"reasoning": reason}}
    ).execute()


def still_committed(agent_row: dict) -> bool:
    """Walking/visiting characters get MIN_COMMITMENT_SECONDS before a new decision can replace it."""
    if agent_row.get("action") not in COMMITTED_ACTIONS or not agent_row.get("updated_at"):
        return False
    age = (datetime.now(timezone.utc) - parse_ts(agent_row["updated_at"])).total_seconds()
    return age < settings.MIN_COMMITMENT_SECONDS


def load_snapshot(db, town_id: str, user_id: str) -> tuple[AgentDecisionInput, dict] | None:
    agents = {a["user_id"]: a for a in db.table("agents").select("*").eq("town_id", town_id).execute().data or []}
    me = agents.get(user_id)
    if me is None:
        return None
    members = (
        db.table("town_members").select("user_id, mood, activity, house_x, house_y, home, profiles(display_name)")
        .eq("town_id", town_id).execute().data or []
    )
    town_map = (db.table("towns").select("map").eq("id", town_id).limit(1).execute().data or [{}])[0].get("map")
    names = {m["user_id"]: (m.get("profiles") or {}).get("display_name") or "Friend" for m in members}
    events = (
        db.table("events")
        .select("id, title, status, kind, start_at, end_at, building_id, text, travel_minutes, event_participants(user_id)")
        .eq("town_id", town_id).eq("type", "personal").eq("status", EventStatus.active.value)
        .execute().data or []
    )
    mine = [
        e for e in events
        if user_id in {p["user_id"] for p in (e.get("event_participants") or [])}
    ]
    ctx = AgentDecisionInput(
        character_id=user_id,
        display_name=names.get(user_id, "Friend"),
        town_id=town_id,
        current_time=label(local_now()),
        current_location_building_id=location(me),
        current_action=me.get("action") or AgentAction.idle.value,
        nearby_characters=[
            NearbyCharacter(
                user_id=m["user_id"],
                display_name=names[m["user_id"]],
                location_building_id=location(agents.get(m["user_id"], {})),
                mood=m.get("mood"),
                activity=m.get("activity"),
            )
            for m in members
            if m["user_id"] != user_id
        ],
        # Brain runs only store fully shareable facts, so every fact here is town-visible.
        relevant_facts=[
            RelevantFact(id=f["id"], user_id=f["user_id"], category=f["category"], fact=f["fact"])
            for f in recent_facts(db, town_id)[:40]
        ],
        active_events=[
            ActiveEventSummary(
                id=e["id"],
                title=e["title"],
                status=e["status"],
                kind=e.get("kind"),
                start=e.get("start_at"),
                end=e.get("end_at"),
            )
            for e in mine
        ],
        available_actions=[a.value for a in AgentAction],
        available_buildings=buildings(town_map, members),
    )
    return ctx, me


def freshness_downgrade(decision: AgentDecisionOutput, fresh: AgentDecisionInput) -> AgentDecisionOutput:
    """If the visit target went home while the model was thinking, walk to where they are instead."""
    if decision.action != AgentAction.visit.value or not decision.target_user_id:
        return decision
    target = next((c for c in fresh.nearby_characters if c.user_id == decision.target_user_id), None)
    home = house_building_id(decision.target_user_id)
    if target and target.location_building_id == home and decision.target_building_id not in (None, home):
        print(f"[agent] downgrade visit→walk_to for {fresh.character_id}: target went home", flush=True)
        return decision.model_copy(update={"action": AgentAction.walk_to.value, "target_building_id": home})
    return decision


def next_building(decision: AgentDecisionOutput, user_id: str, current: str | None) -> str | None:
    if decision.target_building_id:
        return decision.target_building_id
    if decision.action == AgentAction.go_home.value:
        return house_building_id(user_id)
    if decision.action == AgentAction.knock.value and decision.target_user_id:
        return house_building_id(decision.target_user_id)
    return current


def commit_decision(
    db, town_id: str, user_id: str, decision: AgentDecisionOutput, ctx: AgentDecisionInput, lines: list[dict]
) -> None:
    building_id = next_building(decision, user_id, ctx.current_location_building_id)
    spot = next((b for b in ctx.available_buildings if b["id"] == building_id), {})
    # Same target shape as user moves (routes/towns.py move_me): building plus its tile, when known.
    target = {"building_id": building_id, "x": spot.get("x"), "y": spot.get("y"), "door": spot.get("door"),
              "user_id": decision.target_user_id}
    target = {k: v for k, v in target.items() if v is not None}
    change = {"action": decision.action, "target": target or None, "next_decision_at": jittered_next_decision(),
              "updated_at": now_iso()}
    # Clients animate each walk from (x, y): start it at the door of where they last went (assumed arrived).
    here = next((b for b in ctx.available_buildings if b["id"] == ctx.current_location_building_id), {})
    if here.get("door"):
        change["x"], change["y"] = here["door"]
    db.table("agents").update(change).eq("town_id", town_id).eq("user_id", user_id).execute()

    details = {
        "reasoning": decision.reason,
        "target_user_id": decision.target_user_id,
        "target_building_id": target.get("building_id"),
        "fact_ids": decision.fact_ids,
    }
    if lines:
        details["lines"] = lines
    db.table("agent_actions").insert(
        {"town_id": town_id, "user_id": user_id, "action": decision.action, "details": details}
    ).execute()

    if decision.action in SOCIAL_ACTIONS and decision.target_user_id:
        record_interaction(db, user_id, decision.target_user_id, InteractionVia.in_town.value)


def follow_calendar(db, town_id: str, user_id: str, ctx: AgentDecisionInput, me: dict) -> AgentDecisionOutput | None:
    """If this person has a calendar block now, walk there / stay there. Not an LLM call."""
    now = local_now()
    rows = (
        db.table("events")
        .select("id, title, start_at, end_at, building_id, text, travel_minutes, event_participants(user_id)")
        .eq("town_id", town_id).eq("type", "personal").eq("status", EventStatus.active.value)
        .execute().data or []
    )
    mine = [e for e in rows if user_id in {p["user_id"] for p in (e.get("event_participants") or [])}]
    trip = current_trip(mine, user_id, now)
    if trip is None:
        return None
    dest = trip["building_id"]
    if location(me) == dest and (me.get("action") or AgentAction.idle.value) == trip["action"]:
        db.table("agents").update({"next_decision_at": next_check_iso(trip["until"], now)}).eq("town_id", town_id).eq(
            "user_id", user_id
        ).execute()
        return None
    title = trip["event"].get("title") or "an event"
    if trip["phase"] == "walking":
        reason = f"Leaving for {title} ({trip['travel_minutes']} min walk, starts {label(trip['start_at'])})."
    else:
        reason = f"At {title} until {label(trip['end_at'])}."
    decision = AgentDecisionOutput(
        action=trip["action"], target_building_id=dest, reason=reason, fact_ids=[trip["event"]["id"]]
    )
    commit_decision(db, town_id, user_id, decision, ctx, [])
    db.table("agents").update({"next_decision_at": next_check_iso(trip["until"], now)}).eq("town_id", town_id).eq(
        "user_id", user_id
    ).execute()
    return decision


def decide_for_character(town_id: str, user_id: str) -> AgentDecisionOutput | None:
    db = get_client()
    try:
        snap = load_snapshot(db, town_id, user_id)
        if snap is None:
            return None
        ctx, me = snap
        trip = follow_calendar(db, town_id, user_id, ctx, me)
        if trip:
            return trip
        if still_committed(me):
            db.table("agents").update({"next_decision_at": jittered_next_decision()}).eq("town_id", town_id).eq(
                "user_id", user_id
            ).execute()
            return None
        if not settings.OPENROUTER_API_KEY:
            write_idle(db, town_id, user_id, "OPENROUTER_API_KEY missing")
            return None
        raw = complete(
            settings.AGENT_MODEL, build_agent_system_prompt(ctx.display_name), build_agent_user_prompt(ctx), 512
        )
        decision = validate_agent_decision(parse_raw_json(raw), ctx)
        if decision is None:
            write_idle(db, town_id, user_id, "validation failed or invalid JSON")
            return None
        fresh = load_snapshot(db, town_id, user_id)
        if fresh:
            decision = freshness_downgrade(decision, fresh[0])
        lines = generate_lines(ctx, decision) if decision.action == AgentAction.chat.value else []
        commit_decision(db, town_id, user_id, decision, ctx, lines)
        return decision
    except Exception as exc:
        print(f"[agent] town={town_id} user={user_id} error={exc!r}", flush=True)
        try:
            write_idle(db, town_id, user_id, f"exception: {exc}")
        except Exception as inner:
            print(f"[agent] idle fallback failed: {inner!r}", flush=True)
        return None
