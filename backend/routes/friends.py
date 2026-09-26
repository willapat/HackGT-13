"""Account-level friends, found by username. Separate from `friendships` (the in-town path score).

One friend_requests row per pair: pending → accepted (friends) or declined. Unfriending deletes it.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id
from backend.db import get_client, now_iso
from backend.models.api import FriendRequestIn, Respond, Username
from backend.person import build_person
from backend.status import active_status

router = APIRouter(tags=["friends"])

PUBLIC_PROFILE = "id, username, display_name, avatar"
PUBLIC_FIELDS = [f.strip() for f in PUBLIC_PROFILE.split(",")]


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
    """Public fields plus bio and live free/busy status. Selects * so it works before and after those columns exist."""
    if not ids:
        return {}
    now = datetime.now(timezone.utc)
    rows = db.table("profiles").select("*").in_("id", ids).execute().data or []
    return {p["id"]: {**{k: p.get(k) for k in PUBLIC_FIELDS}, "bio": p.get("bio") or "",
                      "active_status": active_status(p, now)} for p in rows}


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


@router.get("/users/{user_id}/profile")
def person_profile(user_id: UUID, uid: str = Depends(current_user_id)):
    """Someone's profile as you're allowed to see it (see backend/person.py for what each relation gets)."""
    db, target = get_client(), str(user_id)
    rows = db.table("profiles").select("*").eq("id", target).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="no such person")
    mine = {m["town_id"]: (m.get("towns") or {}).get("name") or "Town"
            for m in db.table("town_members").select("town_id, towns(name)").eq("user_id", uid).execute().data or []}
    theirs = db.table("town_members").select("town_id, name, color").eq("user_id", target).execute().data or []
    shared = [t for t in theirs if t["town_id"] in mine]
    counts: dict[str, int] = {}
    if shared:
        for m in db.table("town_members").select("town_id").in_("town_id", [t["town_id"] for t in shared]).execute().data or []:
            counts[m["town_id"]] = counts.get(m["town_id"], 0) + 1
    shared_towns = [{"id": t["town_id"], "name": mine[t["town_id"]], "residents": counts.get(t["town_id"], 1),
                     "their_name": t.get("name"), "their_color": t.get("color")} for t in shared]

    def friend_ids(person: str) -> set[str]:
        return {r["to_user"] if r["from_user"] == person else r["from_user"] for r in _my_rows(db, person, "accepted")}

    mutual_ids = (friend_ids(uid) & friend_ids(target)) - {uid, target} if target != uid else set()
    mutual = list(_profiles(db, sorted(mutual_ids)).values())
    a, b = sorted((uid, target))
    bond = db.table("friendships").select("*").eq("user_a", a).eq("user_b", b).limit(1).execute().data
    me_row = db.table("profiles").select("interests").eq("id", uid).limit(1).execute().data
    return build_person(uid, rows[0], pair_row(db, uid, target), shared_towns,
                        (me_row[0].get("interests") if me_row else None) or [], mutual, bond[0] if bond else None,
                        datetime.now(timezone.utc))
