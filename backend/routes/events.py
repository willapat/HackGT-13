from fastapi import APIRouter, HTTPException

from backend.action_agent.action_agent import run_action_agent
from backend.db import get_client
from backend.models.enums import EventStatus, ParticipantStatus, TaskStatus
from backend.models.events import EventParticipantUpdate

router = APIRouter()


@router.post("/events/{event_id}/respond")
def respond(event_id: str, body: EventParticipantUpdate):
    if body.status not in {ParticipantStatus.accepted.value, ParticipantStatus.declined.value}:
        raise HTTPException(status_code=422, detail="status must be accepted or declined")
    if body.event_id != event_id:
        raise HTTPException(status_code=422, detail="event_id mismatch")
    db = get_client()
    ev = db.table("events").select("*").eq("id", event_id).limit(1).execute().data or []
    if not ev:
        raise HTTPException(status_code=404, detail="event not found")
    existing = (
        db.table("event_participants")
        .select("user_id")
        .eq("event_id", event_id)
        .eq("user_id", body.user_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not existing:
        raise HTTPException(status_code=404, detail="participant not found")
    db.table("event_participants").update({"status": body.status}).eq("event_id", event_id).eq(
        "user_id", body.user_id
    ).execute()
    db.table("notifications").insert(
        {
            "user_id": body.user_id,
            "town_id": ev[0]["town_id"],
            "text": f"You {body.status} '{ev[0]['title']}'",
            "payload": {"event_id": event_id, "status": body.status},
        }
    ).execute()
    parts = db.table("event_participants").select("status").eq("event_id", event_id).execute().data or []
    if body.status == ParticipantStatus.accepted.value and parts and all(
        p["status"] == ParticipantStatus.accepted.value for p in parts
    ):
        db.table("events").update({"status": EventStatus.scheduled.value}).eq("id", event_id).execute()
        db.table("action_tasks").insert(
            {"event_id": event_id, "status": TaskStatus.pending.value}
        ).execute()
        run_action_agent(event_id)
    return {"ok": True, "event_status": EventStatus.scheduled.value if all(
        p["status"] == ParticipantStatus.accepted.value for p in parts
    ) else ev[0]["status"]}


@router.post("/action_tasks/{task_id}/approve")
def approve_task(task_id: str):
    db = get_client()
    rows = db.table("action_tasks").select("*").eq("id", task_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="task not found")
    task = rows[0]
    if task["status"] != TaskStatus.needs_approval.value:
        raise HTTPException(status_code=409, detail="task is not waiting for approval")
    db.table("action_tasks").update({"status": TaskStatus.done.value}).eq("id", task_id).execute()
    ev = db.table("events").select("*").eq("id", task["event_id"]).limit(1).execute().data or []
    parts = db.table("event_participants").select("user_id").eq("event_id", task["event_id"]).execute().data or []
    ids = [p["user_id"] for p in parts]
    if len(ids) >= 2 and ev:
        from backend.interactions.path_score import record_interaction
        from backend.models.enums import InteractionType, InteractionVia

        record_interaction(
            db,
            ev[0]["town_id"],
            ids[0],
            ids[1],
            InteractionType.hangout.value,
            InteractionVia.real_life.value,
        )
    return {"ok": True, "status": TaskStatus.done.value}
