"""Stub planner: drafts a plan once every participant accepted a quest. No model call yet, so don't
pitch it as an agent. Nothing is sent anywhere; a participant approves the plan.
"""

# ponytail: stub tools are deterministic, so the draft is recomputed on read instead of stored.
# Once a model or real calendar drives it, persist the draft (needs a column or table: a migration).

from backend.action_agent.tools import find_time_slots, suggest_place


def draft_plan(event: dict, participant_user_ids: list[str]) -> dict:
    title = event.get("title") or "hang out"
    return {
        "event_id": event["id"],
        "title": title,
        "text": event.get("text"),
        "place": suggest_place(f"{title} {event.get('text') or ''}"),
        "time_slots": find_time_slots(participant_user_ids),
        "invite_copy": f"Want to {title[:1].lower() + title[1:]}? Nothing is sent until you approve.",
        "stub": True,
    }
