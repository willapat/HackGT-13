"""Account-level friends, found by username. Separate from `friendships` (the in-town path score).

One friend_requests row per pair: pending → accepted (friends) or declined. Unfriending deletes it.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id
from backend.db import get_client, now_iso
from backend.models.api import FriendRequestIn, Respond, Username

router = APIRouter(tags=["friends"])

PUBLIC_PROFILE = "id, username, display_name, avatar"


def pair_row(db, a: str, b: str) -> dict | None:
    rows = (
        db.table("friend_requests").select("*")
        .or_(f"and(from_user.eq.{a},to_user.eq.{b}),and(from_user.eq.{b},to_user.eq.{a})")
        .limit(1).execute().data
    )
    return rows[0] if rows else None


def are_friends(db, a: str, b: str) -> bool:
    row = pair_row(db, a, b)
    return bool(row and row["status"] == "accepted")


def _profiles(db, ids: list[str]) -> dict[str, dict]:
    if not ids:
        return {}
    return {p["id"]: p for p in db.table("profiles").select(PUBLIC_PROFILE).in_("id", ids).execute().data or []}


def _my_rows(db, uid: str, status: str) -> list[dict]:
    return (
        db.table("friend_requests").select("*").or_(f"from_user.eq.{uid},to_user.eq.{uid}")
        .eq("status", status).order("created_at", desc=True).execute().data or []
    )


@router.get("/users/search")
def search_users(username: Username = Query(), uid: str = Depends(current_user_id)):
    """Exact username match (case-insensitive). Returns public fields only; [] if nobody has it."""
    rows = get_client().table("profiles").select(PUBLIC_PROFILE).eq("username", username).neq("id", uid).execute().data
    return rows or []


@router.get("/friends")
def list_friends(uid: str = Depends(current_user_id)):
    db = get_client()
    rows = _my_rows(db, uid, "accepted")
    other = {r["id"]: r["to_user"] if r["from_user"] == uid else r["from_user"] for r in rows}
    profiles = _profiles(db, list(other.values()))
    return [{**profiles.get(other[r["id"]], {"id": other[r["id"]]}), "friends_since": r["responded_at"]} for r in rows]


@router.delete("/friends/{user_id}", status_code=204)
def unfriend(user_id: UUID, uid: str = Depends(current_user_id)):
    db = get_client()
    row = pair_row(db, uid, str(user_id))
    if not row or row["status"] != "accepted":
        raise HTTPException(status_code=404, detail="not friends")
    db.table("friend_requests").delete().eq("id", row["id"]).execute()


@router.get("/friends/requests")
def list_requests(uid: str = Depends(current_user_id)):
    """Pending requests: incoming (to you) and outgoing (from you), each with the other person's profile."""
    db = get_client()
    rows = _my_rows(db, uid, "pending")
    profiles = _profiles(db, [r["to_user"] if r["from_user"] == uid else r["from_user"] for r in rows])
    incoming = [{**r, "from_profile": profiles.get(r["from_user"])} for r in rows if r["to_user"] == uid]
    outgoing = [{**r, "to_profile": profiles.get(r["to_user"])} for r in rows if r["from_user"] == uid]
    return {"incoming": incoming, "outgoing": outgoing}


@router.post("/friends/requests", status_code=201)
def send_request(body: FriendRequestIn, uid: str = Depends(current_user_id)):
    """Send by username. If they already asked you, this accepts their request instead."""
    db = get_client()
    target = db.table("profiles").select(PUBLIC_PROFILE).eq("username", body.username).limit(1).execute().data
    if not target:
        raise HTTPException(status_code=404, detail="no user with that username")
    to = target[0]["id"]
    if to == uid:
        raise HTTPException(status_code=422, detail="you can't friend yourself")
    row = pair_row(db, uid, to)
    if row and row["status"] == "accepted":
        raise HTTPException(status_code=409, detail="already friends")
    if row and row["status"] == "pending" and row["from_user"] == uid:
        raise HTTPException(status_code=409, detail="request already sent")
    if row and row["status"] == "pending":  # they asked first
        change = {"status": "accepted", "responded_at": now_iso()}
    elif row:  # declined earlier: start over with you as the sender
        change = {"from_user": uid, "to_user": to, "status": "pending", "created_at": now_iso(), "responded_at": None}
    if row:
        saved = db.table("friend_requests").update(change).eq("id", row["id"]).execute().data[0]
    else:
        saved = db.table("friend_requests").insert({"from_user": uid, "to_user": to}).execute().data[0]
    return {**saved, "to_profile": target[0]}


@router.post("/friends/requests/{request_id}/respond")
def respond_request(request_id: UUID, body: Respond, uid: str = Depends(current_user_id)):
    db = get_client()
    rows = db.table("friend_requests").select("*").eq("id", str(request_id)).eq("to_user", uid).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="request not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"request is already {rows[0]['status']}")
    return (
        db.table("friend_requests").update({"status": body.status, "responded_at": now_iso()})
        .eq("id", str(request_id)).execute().data[0]
    )
