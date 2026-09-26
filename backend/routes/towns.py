from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id, require_member
from backend.db import get_client, now_iso
from backend.models.api import EventCreate, HouseUpdate, JoinTown, TownCreate, TownUpdate
from backend.models.enums import EventStatus, EventType, ParticipantStatus

router = APIRouter(prefix="/towns", tags=["towns"])


def load_town(db, town_id: str) -> dict:
    rows = db.table("towns").select("*").eq("id", town_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="town not found")
    return rows[0]


@router.post("", status_code=201)
def create_town(body: TownCreate, uid: str = Depends(current_user_id)):
    """You become its first member (and get a character) via DB triggers."""
    rows = get_client().table("towns").insert({"name": body.name.strip(), "tiles": body.tiles, "created_by": uid}).execute().data
    return rows[0]


@router.post("/join")
def join_town(body: JoinTown, uid: str = Depends(current_user_id)):
    db = get_client()
    rows = db.table("towns").select("*").eq("invite_code", body.invite_code.strip()).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="invalid invite code")
    town = rows[0]
    db.table("town_members").upsert(
        {"town_id": town["id"], "user_id": uid}, on_conflict="town_id,user_id", ignore_duplicates=True
    ).execute()
    return town


@router.get("/{town_id}")
def get_town(town_id: UUID, uid: str = Depends(current_user_id)):
    """Everything needed to render the town: map, members (with profile and AI-set mood/activity/state), agents."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    members = (
        db.table("town_members").select("*, profiles(id, display_name, avatar, interests)")
        .eq("town_id", tid).order("joined_at").execute().data or []
    )
    agents = db.table("agents").select("*").eq("town_id", tid).execute().data or []
    return {"town": load_town(db, tid), "members": members, "agents": agents}


@router.patch("/{town_id}")
def update_town(town_id: UUID, body: TownUpdate, uid: str = Depends(current_user_id)):
    """Rename the town or replace its tile map. Creator only."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    if load_town(db, tid)["created_by"] != uid:
        raise HTTPException(status_code=403, detail="only the town's creator can edit it")
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    return db.table("towns").update(changes).eq("id", tid).execute().data[0]


@router.patch("/{town_id}/members/me")
def place_house(town_id: UUID, body: HouseUpdate, uid: str = Depends(current_user_id)):
    """Put your house on a tile. Your character moves there too."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    tiles = load_town(db, tid)["tiles"]
    if tiles and not (body.house_y < len(tiles) and body.house_x < len(tiles[body.house_y])):
        raise HTTPException(status_code=422, detail="house is outside the town map")
    row = (
        db.table("town_members").update({"house_x": body.house_x, "house_y": body.house_y, "updated_at": now_iso()})
        .eq("town_id", tid).eq("user_id", uid).execute().data[0]
    )
    db.table("agents").update({"x": body.house_x, "y": body.house_y, "updated_at": now_iso()}).eq("town_id", tid).eq(
        "user_id", uid
    ).execute()
    return row


@router.delete("/{town_id}/members/me", status_code=204)
def leave_town(town_id: UUID, uid: str = Depends(current_user_id)):
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    db.table("town_members").delete().eq("town_id", tid).eq("user_id", uid).execute()


@router.get("/{town_id}/events")
def list_events(
    town_id: UUID,
    event_type: str | None = Query(None, alias="type", description="quest, storyline, town_event, news"),
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    uid: str = Depends(current_user_id),
):
    """Quests, news, etc., newest first, each with its participants."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    q = db.table("events").select("*, event_participants(user_id, status)").eq("town_id", tid)
    if event_type:
        q = q.eq("type", event_type)
    if status:
        q = q.eq("status", status)
    return q.order("created_at", desc=True).limit(limit).execute().data or []


@router.post("/{town_id}/events", status_code=201)
def propose_event(town_id: UUID, body: EventCreate, uid: str = Depends(current_user_id)):
    """A person suggests a plan to townmates. The proposer counts as accepted; others must accept."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    invitees = {str(p) for p in body.participant_ids} - {uid}
    if not invitees:
        raise HTTPException(status_code=422, detail="invite at least one townmate")
    members = {m["user_id"] for m in db.table("town_members").select("user_id").eq("town_id", tid).execute().data or []}
    if not invitees <= members:
        raise HTTPException(status_code=422, detail="every participant must be in this town")
    event = (
        db.table("events").insert(
            {"town_id": tid, "type": EventType.quest.value, "title": body.title.strip(), "text": body.text,
             "status": EventStatus.suggested.value}
        ).execute().data[0]
    )
    participants = [{"event_id": event["id"], "user_id": uid, "status": ParticipantStatus.accepted.value}] + [
        {"event_id": event["id"], "user_id": i, "status": ParticipantStatus.suggested.value} for i in invitees
    ]
    db.table("event_participants").insert(participants).execute()
    return {**event, "event_participants": [{"user_id": p["user_id"], "status": p["status"]} for p in participants]}


@router.get("/{town_id}/activity")
def town_activity(
    town_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    after_id: int | None = Query(None, description="only actions newer than this id (for polling)"),
    uid: str = Depends(current_user_id),
):
    """Character decisions, newest first. Chat bubbles are in details.lines."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    q = db.table("agent_actions").select("*").eq("town_id", tid)
    if after_id is not None:
        q = q.gt("id", after_id)
    return q.order("id", desc=True).limit(limit).execute().data or []
