"""Town Brain: one pass over a town. Writes only after validation + visibility filtering.

Writes: brain_runs (input ids / filtered output / error) and town_members mood/activity/state.
Events are user calendars, so this loop does not insert news or quests there.
"""

from backend.identity import member_name
from backend.agent.validate import parse_raw_json, validate_brain_output
from backend.brain.prompt import build_brain_system_prompt, build_brain_user_prompt
from backend.brain.visibility import apply_visibility
from backend.config import settings
from backend.connections.detector import ACTIVE_STATUSES, find_connection_candidates
from backend.db import get_client, last_brain_run_at, now_iso, recent_facts
from backend.llm import complete
from backend.models.brain import BrainOutput, QuestCandidate
from backend.models.enums import EventStatus, EventType, ParticipantStatus


def pair_has_active_quest(db, town_id: str, user_ids: list[str]) -> bool:
    wanted = set(user_ids)
    events = (
        db.table("events").select("id, event_participants(user_id)").eq("town_id", town_id)
        .eq("type", EventType.quest.value).in_("status", list(ACTIVE_STATUSES)).execute().data or []
    )
    return any(wanted <= {p["user_id"] for p in (ev.get("event_participants") or [])} for ev in events)


def create_quest(db, town_id: str, quest: QuestCandidate) -> str | None:
    uids = list(dict.fromkeys(quest.participant_user_ids))
    if len(uids) < 2 or pair_has_active_quest(db, town_id, uids):
        return None
    rows = (
        db.table("events").insert(
            {"town_id": town_id, "type": EventType.quest.value, "title": quest.title, "text": quest.text,
             "status": EventStatus.suggested.value}
        ).execute().data or []
    )
    if not rows:
        return None
    event_id = rows[0]["id"]
    db.table("event_participants").insert(
        [{"event_id": event_id, "user_id": uid, "status": ParticipantStatus.suggested.value} for uid in uids]
    ).execute()
    return event_id


def persist_brain_output(db, town_id: str, output: BrainOutput, members: list[dict]) -> None:
    prev_state = {m["user_id"]: m.get("state") or {} for m in members}
    for s in output.member_states:
        db.table("town_members").update(
            {"mood": s.mood.value, "activity": s.activity, "state": {**prev_state.get(s.user_id, {}), **s.props},
             "updated_at": now_iso()}
        ).eq("town_id", town_id).eq("user_id", s.user_id).execute()


def run_brain_for_town(town_id: str) -> BrainOutput | None:
    db = get_client()
    since = last_brain_run_at(db, town_id)
    # Insert the run first: its created_at is the cutoff, so signals arriving mid-run go to the next run.
    run = db.table("brain_runs").insert({"town_id": town_id, "input": {}}).execute().data[0]
    try:
        members = (
            db.table("town_members").select("user_id, mood, activity, state, name, profiles(display_name, interests)")
            .eq("town_id", town_id).execute().data or []
        )
        for m in members:  # the brain knows people by the name they go by in this town
            m["profiles"] = {**(m.get("profiles") or {}), "display_name": member_name(m)}
            m.pop("name", None)
        q = (
            db.table("signals").select("*").in_("user_id", [m["user_id"] for m in members])
            .lte("created_at", run["created_at"]).order("created_at")
        )
        if since:
            q = q.gt("created_at", since)
        # A post to one town only reaches that town's brain
        signals = [s for s in q.execute().data or [] if (s.get("value") or {}).get("town_id") in (None, town_id)]
        facts = recent_facts(db, town_id)
        candidates = find_connection_candidates(town_id, db)
        # brain_runs is readable by every town member, so store ids only, never raw signal values.
        db.table("brain_runs").update(
            {"input": {"signal_ids": [s["id"] for s in signals], "member_ids": [m["user_id"] for m in members]}}
        ).eq("id", run["id"]).execute()

        raw = complete(
            settings.BRAIN_MODEL,
            build_brain_system_prompt(),
            build_brain_user_prompt(town_id, signals, facts, members, candidates),
            max_tokens=8192,
        )
        validated = validate_brain_output(parse_raw_json(raw))
        if validated is None:
            raise RuntimeError("brain output failed validation")
        filtered = apply_visibility(validated, signals, members)
        persist_brain_output(db, town_id, filtered, members)
        db.table("brain_runs").update({"output": filtered.model_dump(mode="json")}).eq("id", run["id"]).execute()
        return filtered
    except Exception as exc:
        print(f"[brain] town={town_id} error={exc!r}", flush=True)
        db.table("brain_runs").update({"error": str(exc)}).eq("id", run["id"]).execute()
        return None
