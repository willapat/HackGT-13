"""Runs after events.status → scheduled. Stubs calendar/places; result needs human approval."""

from backend.action_agent.tools import find_time_slots, suggest_place
from backend.config import settings
from backend.db import get_client
from backend.models.enums import TaskStatus


def run_action_agent(event_id: str) -> dict:
    db = get_client()
    ev_rows = db.table("events").select("*").eq("id", event_id).limit(1).execute().data or []
    if not ev_rows:
        return {"error": "event not found"}
    event = ev_rows[0]
    parts = db.table("event_participants").select("user_id").eq("event_id", event_id).execute().data or []
    user_ids = [p["user_id"] for p in parts]
    building_id = (event.get("details") or {}).get("building_id")
    slots = find_time_slots(user_ids)
    place = suggest_place(building_id, event.get("title") or "hangout")
    result = {
        "draft": {
            "title": event.get("title"),
            "text": event.get("text"),
            "place": place,
            "time_slots": slots,
            "invite_copy": f"Want to {event.get('title', 'hang out').lower()}? Nothing is sent until you approve.",
        },
        "model": settings.ACTION_AGENT_MODEL,
        "stub": True,
    }
    tasks = db.table("action_tasks").select("id").eq("event_id", event_id).execute().data or []
    if tasks:
        db.table("action_tasks").update(
            {"status": TaskStatus.needs_approval.value, "result": result}
        ).eq("id", tasks[0]["id"]).execute()
    else:
        db.table("action_tasks").insert(
            {"event_id": event_id, "status": TaskStatus.needs_approval.value, "result": result}
        ).execute()
    return result
