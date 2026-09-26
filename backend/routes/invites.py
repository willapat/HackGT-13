"""Town invites: the town's creator invites a friend; accepting joins the town (and creates their character)."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from backend.auth import current_user_id, require_member
from backend.db import get_client, now_iso
from backend.models.api import Respond, TownInviteIn
from backend.routes.friends import PUBLIC_PROFILE, are_friends
from backend.routes.towns import load_town

router = APIRouter(tags=["invites"])


@router.post("/towns/{town_id}/invites", status_code=201)
def invite_friend(town_id: UUID, body: TownInviteIn, uid: str = Depends(current_user_id)):
    db, tid, to = get_client(), str(town_id), str(body.user_id)
    require_member(db, tid, uid)
    if load_town(db, tid)["created_by"] != uid:
        raise HTTPException(status_code=403, detail="only the town's creator can invite people")
    if not are_friends(db, uid, to):
        raise HTTPException(status_code=422, detail="you can only invite your friends")
    if db.table("town_members").select("user_id").eq("town_id", tid).eq("user_id", to).execute().data:
        raise HTTPException(status_code=409, detail="already in this town")
    existing = db.table("town_invites").select("*").eq("town_id", tid).eq("to_user", to).limit(1).execute().data
    if existing and existing[0]["status"] == "pending":
        raise HTTPException(status_code=409, detail="already invited")
    if existing:  # declined, or accepted and later left: invite again
        return (
            db.table("town_invites")
            .update({"from_user": uid, "status": "pending", "created_at": now_iso(), "responded_at": None})
            .eq("id", existing[0]["id"]).execute().data[0]
        )
    return db.table("town_invites").insert({"town_id": tid, "from_user": uid, "to_user": to}).execute().data[0]


@router.get("/towns/{town_id}/invites")
def list_town_invites(town_id: UUID, uid: str = Depends(current_user_id)):
    """All invites for a town, newest first, with the invitee's profile. Any member can see them."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    return (
        db.table("town_invites").select(f"*, to_profile:profiles!town_invites_to_user_fkey({PUBLIC_PROFILE})")
        .eq("town_id", tid).order("created_at", desc=True).execute().data or []
    )


@router.get("/me/invites")
def my_invites(uid: str = Depends(current_user_id)):
    """Your pending invites, with the town and who invited you."""
    return (
        get_client().table("town_invites")
        .select(f"*, towns(id, name), from_profile:profiles!town_invites_from_user_fkey({PUBLIC_PROFILE})")
        .eq("to_user", uid).eq("status", "pending").order("created_at", desc=True).execute().data or []
    )


@router.post("/invites/{invite_id}/respond")
def respond_invite(invite_id: UUID, body: Respond, uid: str = Depends(current_user_id)):
    db, iid = get_client(), str(invite_id)
    rows = db.table("town_invites").select("*").eq("id", iid).eq("to_user", uid).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="invite not found")
    if rows[0]["status"] != "pending":
        raise HTTPException(status_code=409, detail=f"invite is already {rows[0]['status']}")
    if body.status == "accepted":
        db.table("town_members").upsert(
            {"town_id": rows[0]["town_id"], "user_id": uid}, on_conflict="town_id,user_id", ignore_duplicates=True
        ).execute()
    return (
        db.table("town_invites").update({"status": body.status, "responded_at": now_iso()})
        .eq("id", iid).execute().data[0]
    )
