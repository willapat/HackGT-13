"""Town Brain: one pass over a town. Writes only after validation + visibility."""

from datetime import datetime, timezone

from backend.agent.validate import parse_raw_json, validate_brain_output
from backend.brain.prompt import build_brain_system_prompt, build_brain_user_prompt
from backend.brain.visibility import apply_visibility
from backend.config import settings
from backend.connections.detector import ACTIVE_STATUSES, find_connection_candidates
from backend.db import get_client
from backend.models.enums import EventCreator, EventStatus, EventType, ParticipantStatus
from backend.models.facts import BrainOutput, QuestCandidate


def _anthropic_client():
    import anthropic

    return anthropic.Anthropic(api_key=settings.ANTHROPIC_API_KEY)


def gather_brain_input(town_id: str, db) -> dict:
    members = (
        db.table("town_members")
        .select("user_id, house_x, house_y, mood, activity, state, profiles(display_name, interests)")
        .eq("town_id", town_id)
        .execute()
        .data
        or []
    )
    user_ids = [m["user_id"] for m in members]
    last_run = (
        db.table("brain_runs")
        .select("created_at")
        .eq("town_id", town_id)
        .order("created_at", desc=True)
        .limit(1)
        .execute()
        .data
        or []
    )
    since = last_run[0]["created_at"] if last_run else "1970-01-01T00:00:00Z"
    signals = []
    if user_ids:
        signals = (
            db.table("signals")
            .select("*")
            .in_("user_id", user_ids)
            .gt("created_at", since)
            .execute()
            .data
            or []
        )
    facts = (
        db.table("facts").select("*").eq("town_id", town_id).order("created_at", desc=True).limit(80).execute().data
        or []
    )
    candidates = find_connection_candidates(town_id, db)
    return {
        "members": members,
        "signals": signals,
        "facts": facts,
        "connection_candidates": candidates,
        "member_ids": set(user_ids),
    }


def pair_has_active_quest(db, town_id: str, user_ids: list[str]) -> bool:
    wanted = set(user_ids)
    events = (
        db.table("events")
        .select("id, event_participants(user_id)")
        .eq("town_id", town_id)
        .eq("type", EventType.quest.value)
        .in_("status", list(ACTIVE_STATUSES))
        .execute()
        .data
        or []
    )
    for ev in events:
        ids = {p["user_id"] for p in (ev.get("event_participants") or [])}
        if wanted <= ids and len(wanted) >= 2:
            return True
    return False


def persist_brain_output(town_id: str, output: BrainOutput, db, member_ids: set[str] | None = None) -> None:
    for fact in output.facts:
        if member_ids is not None and fact.user_id not in member_ids:
            continue
        db.table("facts").insert(
            {
                "user_id": fact.user_id,
                "town_id": fact.town_id or town_id,
                "category": fact.category,
                "fact": fact.fact,
                "source_signal_ids": fact.source_signal_ids,
                "confidence": fact.confidence,
                "visibility": fact.visibility,
            }
        ).execute()
    for state in output.member_states:
        if member_ids is not None and state.user_id not in member_ids:
            continue
        prev = (
            db.table("town_members")
            .select("state")
            .eq("town_id", town_id)
            .eq("user_id", state.user_id)
            .limit(1)
            .execute()
            .data
            or [{}]
        )
        merged = dict((prev[0] or {}).get("state") or {})
        merged.update(state.props)
        if state.location_building_id:
            merged["location_building_id"] = state.location_building_id
        db.table("town_members").update(
            {
                "mood": state.weather,
                "activity": state.activity,
                "state": merged,
                "updated_at": datetime.now(timezone.utc).isoformat(),
            }
        ).eq("town_id", town_id).eq("user_id", state.user_id).execute()
    for item in output.news:
        db.table("news").insert({"town_id": town_id, "text": item.text, "event_id": item.event_id}).execute()
    for quest in output.quest_candidates:
        create_quest_from_candidate(quest, db, member_ids or set())


def create_quest_from_candidate(quest: QuestCandidate, db, member_ids: set[str]) -> str | None:
    uids = [u for u in quest.participant_user_ids if u in member_ids]
    if len(uids) < 2:
        return None
    if pair_has_active_quest(db, quest.town_id, uids):
        return None
    inserted = (
        db.table("events")
        .insert(
            {
                "town_id": quest.town_id,
                "type": EventType.quest.value,
                "title": quest.title,
                "text": quest.text,
                "status": EventStatus.suggested.value,
                "details": {
                    "building_id": quest.building_id,
                    "fact_ids": quest.fact_ids,
                    "created_by": EventCreator.brain.value,
                },
            }
        )
        .execute()
        .data
        or []
    )
    if not inserted:
        return None
    event_id = inserted[0]["id"]
    for uid in uids:
        db.table("event_participants").insert(
            {"event_id": event_id, "user_id": uid, "status": ParticipantStatus.suggested.value}
        ).execute()
        db.table("notifications").insert(
            {
                "user_id": uid,
                "town_id": quest.town_id,
                "text": f"New quest: {quest.title}",
                "payload": {"event_id": event_id},
            }
        ).execute()
    return event_id


def call_brain_model(system: str, user: str) -> str:
    client = _anthropic_client()
    msg = client.messages.create(
        model=settings.BRAIN_MODEL,
        max_tokens=4096,
        system=system,
        messages=[{"role": "user", "content": user}],
    )
    return "".join(block.text for block in msg.content if getattr(block, "type", None) == "text")


async def run_brain_for_town(town_id: str) -> BrainOutput | None:
    db = get_client()
    gathered = gather_brain_input(town_id, db)
    payload = {
        "signals": gathered["signals"],
        "facts": gathered["facts"],
        "members": gathered["members"],
        "connection_candidates": gathered["connection_candidates"],
    }
    run_row = db.table("brain_runs").insert({"town_id": town_id, "input": payload}).execute().data or []
    run_id = run_row[0]["id"] if run_row else None
    try:
        if not settings.ANTHROPIC_API_KEY:
            raise RuntimeError("ANTHROPIC_API_KEY is not set")
        raw_text = call_brain_model(
            build_brain_system_prompt(),
            build_brain_user_prompt(
                town_id,
                gathered["signals"],
                gathered["facts"],
                gathered["members"],
                gathered["connection_candidates"],
            ),
        )
        parsed = parse_raw_json(raw_text)
        validated = validate_brain_output(parsed) if parsed else None
        if validated is None:
            raise RuntimeError("brain output failed validation")
        filtered = apply_visibility(validated, town_id, db)
        persist_brain_output(town_id, filtered, db, gathered["member_ids"])
        if run_id:
            db.table("brain_runs").update({"output": filtered.model_dump()}).eq("id", run_id).execute()
        return filtered
    except Exception as exc:
        print(f"[brain] town={town_id} error={exc!r}", flush=True)
        if run_id:
            db.table("brain_runs").update({"error": str(exc)}).eq("id", run_id).execute()
        return None
