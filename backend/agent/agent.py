"""Character agent: one decision. Fail closed to idle. Never crash the loop."""

from datetime import datetime, timedelta, timezone
from random import uniform

from backend.agent.conversation import maybe_write_conversation
from backend.agent.gifting import apply_gift
from backend.agent.prompt import build_agent_system_prompt, build_agent_user_prompt
from backend.agent.validate import parse_raw_json, validate_agent_decision
from backend.config import settings
from backend.db import buildings_for_town, get_client, house_building_id, now_iso
from backend.interactions.path_score import record_interaction
from backend.models.agents import (
    ActiveEventSummary,
    AgentDecisionInput,
    AgentDecisionOutput,
    NearbyCharacter,
    RelevantFact,
)
from backend.models.enums import AgentAction, EventStatus, VisibilityLevel

COMMITTED_ACTIONS = {AgentAction.walk_to.value, AgentAction.visit.value}


def _anthropic_client():
    import anthropic

    return anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


def jittered_next_decision() -> str:
    seconds = 20 + uniform(0, 15)
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def write_idle(db, town_id: str, user_id: str, reason: str) -> None:
    db.table("agents").update(
        {
            "action": AgentAction.idle.value,
            "next_decision_at": jittered_next_decision(),
            "updated_at": now_iso(),
        }
    ).eq("town_id", town_id).eq("user_id", user_id).execute()
    db.table("agent_actions").insert(
        {
            "town_id": town_id,
            "user_id": user_id,
            "action": AgentAction.idle.value,
            "details": {"reasoning": reason},
        }
    ).execute()


def still_committed(db, town_id: str, user_id: str, current_action: str) -> bool:
    if current_action not in COMMITTED_ACTIONS:
        return False
    rows = (
        db.table("agent_actions")
        .select("created_at")
        .eq("town_id", town_id)
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        return False
    created = datetime.fromisoformat(rows[0]["created_at"].replace("Z", "+00:00"))
    age = (datetime.now(timezone.utc) - created).total_seconds()
    return age < settings.MIN_COMMITMENT_SECONDS


def load_snapshot(db, town_id: str, user_id: str) -> AgentDecisionInput | None:
    agent_rows = (
        db.table("agents").select("*").eq("town_id", town_id).eq("user_id", user_id).limit(1).execute().data or []
    )
    if not agent_rows:
        return None
    agent = agent_rows[0]
    members = (
        db.table("town_members")
        .select("user_id, mood, activity, state, profiles(display_name)")
        .eq("town_id", town_id)
        .execute()
        .data
        or []
    )
    member_ids = [m["user_id"] for m in members]
    me = next((m for m in members if m["user_id"] == user_id), None)
    profile = (me or {}).get("profiles") or {}
    display_name = profile.get("display_name") or "Friend"
    my_loc = ((me or {}).get("state") or {}).get("location_building_id")

    nearby = []
    for m in members:
        loc = (m.get("state") or {}).get("location_building_id")
        nearby.append(
            NearbyCharacter(
                user_id=m["user_id"],
                display_name=((m.get("profiles") or {}).get("display_name") or "Friend"),
                location_building_id=loc,
                busy=False,
            )
        )

    facts_rows = db.table("facts").select("*").eq("town_id", town_id).order("created_at", desc=True).limit(40).execute().data or []
    relevant = []
    for f in facts_rows:
        if f.get("visibility") == VisibilityLevel.hidden.value and f.get("user_id") != user_id:
            continue
        if f.get("visibility") == VisibilityLevel.vague.value and f.get("user_id") != user_id:
            continue
        relevant.append(RelevantFact(id=f["id"], category=f["category"], fact=f["fact"]))

    events = (
        db.table("events")
        .select("id, title, status")
        .eq("town_id", town_id)
        .in_("status", [EventStatus.suggested.value, EventStatus.active.value, EventStatus.scheduled.value])
        .execute()
        .data
        or []
    )
    inv_rows = db.table("inventory").select("item_type, qty").eq("user_id", user_id).execute().data or []
    inventory = {r["item_type"]: r["qty"] for r in inv_rows}

    ctx = AgentDecisionInput(
        character_id=user_id,
        town_id=town_id,
        current_location_building_id=my_loc,
        current_action=agent.get("action") or AgentAction.idle.value,
        nearby_characters=nearby,
        relevant_facts=relevant,
        active_events=[ActiveEventSummary(id=e["id"], title=e["title"], status=e["status"]) for e in events],
        known_connections=[],
        available_actions=[a.value for a in AgentAction],
        available_buildings=buildings_for_town(member_ids),
        inventory=inventory,
    )
    ctx._display_name = display_name  # type: ignore[attr-defined]
    return ctx


def freshness_downgrade(decision: AgentDecisionOutput, fresh: AgentDecisionInput) -> AgentDecisionOutput:
    if not decision.target_user_id:
        return decision
    target = next((c for c in fresh.nearby_characters if c.user_id == decision.target_user_id), None)
    if decision.action == AgentAction.visit.value and target and target.location_building_id:
        home = house_building_id(decision.target_user_id)
        if target.location_building_id == home and decision.target_building_id != home:
            print(f"[agent] downgrade visit→walk_to for {fresh.character_id}: target went home", flush=True)
            return decision.model_copy(
                update={"action": AgentAction.walk_to.value, "target_building_id": target.location_building_id}
            )
    return decision


def commit_decision(db, town_id: str, user_id: str, decision: AgentDecisionOutput, loc: str | None) -> None:
    target = {}
    if decision.target_user_id:
        target["user_id"] = decision.target_user_id
    if decision.target_building_id:
        target["building_id"] = decision.target_building_id
    elif decision.action == AgentAction.go_home.value:
        target["building_id"] = house_building_id(user_id)

    db.table("agents").update(
        {
            "action": decision.action,
            "target": target or None,
            "next_decision_at": jittered_next_decision(),
            "updated_at": now_iso(),
        }
    ).eq("town_id", town_id).eq("user_id", user_id).execute()

    new_loc = decision.target_building_id or loc
    if decision.action == AgentAction.go_home.value:
        new_loc = house_building_id(user_id)
    if new_loc:
        member = (
            db.table("town_members")
            .select("state")
            .eq("town_id", town_id)
            .eq("user_id", user_id)
            .limit(1)
            .execute()
            .data
            or [{}]
        )
        state = dict((member[0] or {}).get("state") or {})
        state["location_building_id"] = new_loc
        db.table("town_members").update({"state": state, "updated_at": now_iso()}).eq("town_id", town_id).eq(
            "user_id", user_id
        ).execute()

    db.table("agent_actions").insert(
        {
            "town_id": town_id,
            "user_id": user_id,
            "action": decision.action,
            "details": {
                "reasoning": decision.reason,
                "target_user_id": decision.target_user_id,
                "target_building_id": decision.target_building_id,
                "fact_ids": decision.fact_ids,
            },
        }
    ).execute()

    if decision.action == AgentAction.leave_gift.value and decision.target_user_id:
        apply_gift(db, town_id, user_id, decision.target_user_id)
        record_interaction(db, town_id, user_id, decision.target_user_id, "gift", "in_town")
    elif decision.action in {AgentAction.visit.value, AgentAction.chat.value, AgentAction.knock.value} and decision.target_user_id:
        record_interaction(db, town_id, user_id, decision.target_user_id, decision.action, "in_town")


def call_agent_model(system: str, user: str) -> str:
    client = _anthropic_client()
    msg = client.messages.create(
        model=settings.AGENT_MODEL,
        max_tokens=512,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(block.text for block in msg.content if getattr(block, "type", None) == "text")


async def decide_for_character(town_id: str, user_id: str) -> AgentDecisionOutput | None:
    db = get_client()
    try:
        ctx = load_snapshot(db, town_id, user_id)
        if ctx is None:
            return None
        if still_committed(db, town_id, user_id, ctx.current_action):
            db.table("agents").update({"next_decision_at": jittered_next_decision(), "updated_at": now_iso()}).eq(
                "town_id", town_id
            ).eq("user_id", user_id).execute()
            return None
        if not settings.ANTHROPIC_API_KEY:
            write_idle(db, town_id, user_id, "ANTHROPIC_API_KEY missing")
            return None
        raw = call_agent_model(
            build_agent_system_prompt(getattr(ctx, "_display_name", "Friend")),
            build_agent_user_prompt(ctx),
        )
        parsed = parse_raw_json(raw)
        decision = validate_agent_decision(parsed, ctx) if parsed else None
        if decision is None:
            write_idle(db, town_id, user_id, "validation failed or invalid JSON")
            return None
        fresh = load_snapshot(db, town_id, user_id)
        if fresh:
            decision = freshness_downgrade(decision, fresh)
        commit_decision(db, town_id, user_id, decision, ctx.current_location_building_id)
        maybe_write_conversation(db, town_id, user_id, decision)
        return decision
    except Exception as exc:
        print(f"[agent] town={town_id} user={user_id} error={exc!r}", flush=True)
        try:
            write_idle(db, town_id, user_id, f"exception: {exc}")
        except Exception as inner:
            print(f"[agent] idle fallback failed: {inner!r}", flush=True)
        return None
