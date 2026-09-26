"""The approval gate. Nothing leaves the town until every participant accepts and one approves the plan."""

from itertools import combinations
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from backend.action_agent.action_agent import draft_plan
from backend.auth import current_user_id, require_member
from backend.db import get_client
from backend.interactions.path_score import record_interaction
from backend.models.api import Respond
from backend.models.enums import EventStatus, InteractionVia, ParticipantStatus

router = APIRouter(prefix="/events", tags=["events"])

PLAN_STATUSES = {EventStatus.scheduled.value, EventStatus.confirmed.value}


def _load(db, event_id: str) -> tuple[dict, dict[str, str]]:
    rows = db.table("events").select("*").eq("id", event_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="event not found")
    parts = db.table("event_participants").select("user_id, status").eq("event_id", event_id).execute().data or []
    return rows[0], {p["user_id"]: p["status"] for p in parts}


def _view(event: dict, parts: dict[str, str]) -> dict:
    view = {**event, "event_participants": [{"user_id": u, "status": s} for u, s in parts.items()]}
    if event["status"] in PLAN_STATUSES:
        view["plan"] = draft_plan(event, list(parts))
    return view


@router.get("/{event_id}")
def get_event(event_id: UUID, uid: str = Depends(current_user_id)):
    """Event with participants, plus the drafted plan once everyone has accepted."""
    db = get_client()
    event, parts = _load(db, str(event_id))
    require_member(db, event["town_id"], uid)
    return _view(event, parts)


@router.post("/{event_id}/respond")
def respond(event_id: UUID, body: Respond, uid: str = Depends(current_user_id)):
    """Accept or decline for yourself. All accepted → scheduled (plan drafted). Anyone declines → cancelled."""
    db, eid = get_client(), str(event_id)
    event, parts = _load(db, eid)
    if uid not in parts:
        raise HTTPException(status_code=404, detail="event not found")
    if event["status"] != EventStatus.suggested.value:
        raise HTTPException(status_code=409, detail=f"event is already {event['status']}")
    db.table("event_participants").update({"status": body.status}).eq("event_id", eid).eq("user_id", uid).execute()
    parts[uid] = body.status
    new_status = None
    if ParticipantStatus.declined.value in parts.values():
        new_status = EventStatus.cancelled.value
    elif all(s == ParticipantStatus.accepted.value for s in parts.values()):
        new_status = EventStatus.scheduled.value
    if new_status:
        db.table("events").update({"status": new_status}).eq("id", eid).execute()
        event["status"] = new_status
    return _view(event, parts)


@router.post("/{event_id}/approve")
def approve_plan(event_id: UUID, uid: str = Depends(current_user_id)):
    """A participant approves the drafted plan. Stub: nothing is actually sent or booked yet."""
    db, eid = get_client(), str(event_id)
    event, parts = _load(db, eid)
    if uid not in parts:
        raise HTTPException(status_code=404, detail="event not found")
    if event["status"] != EventStatus.scheduled.value:
        raise HTTPException(status_code=409, detail="plan is only approvable once everyone has accepted")
    db.table("events").update({"status": EventStatus.confirmed.value}).eq("id", eid).execute()
    event["status"] = EventStatus.confirmed.value
    for a, b in combinations(parts, 2):
        record_interaction(db, a, b, InteractionVia.real_life.value)
    return _view(event, parts)
