"""Deterministic connection candidates. No model call."""

from backend.models.enums import EventStatus, EventType

ACTIVE_STATUSES = {EventStatus.suggested.value, EventStatus.scheduled.value, EventStatus.confirmed.value}


def find_connection_candidates(town_id: str, db) -> list[dict]:
    members = (
        db.table("town_members").select("user_id, profiles(id, display_name, interests)")
        .eq("town_id", town_id).execute().data or []
    )
    people = [
        {
            "user_id": row["user_id"],
            "display_name": (row.get("profiles") or {}).get("display_name") or "",
            "interests": set((row.get("profiles") or {}).get("interests") or []),
        }
        for row in members
    ]

    events = (
        db.table("events").select("id, type, status, event_participants(user_id)").eq("town_id", town_id)
        .eq("type", EventType.quest.value).in_("status", list(ACTIVE_STATUSES)).execute().data or []
    )
    cooldown_pairs: set[tuple[str, str]] = set()
    for ev in events:
        ids = sorted(p["user_id"] for p in (ev.get("event_participants") or []))
        for i, a in enumerate(ids):
            for b in ids[i + 1 :]:
                cooldown_pairs.add((a, b))

    candidates = []
    for i, a in enumerate(people):
        for b in people[i + 1 :]:
            shared = sorted(a["interests"] & b["interests"])
            pair = tuple(sorted((a["user_id"], b["user_id"])))
            if shared and pair not in cooldown_pairs:
                candidates.append(
                    {"user_ids": list(pair), "names": [a["display_name"], b["display_name"]], "shared_interests": shared}
                )
    return candidates
