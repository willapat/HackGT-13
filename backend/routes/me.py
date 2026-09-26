from fastapi import APIRouter, Depends, HTTPException
from postgrest.exceptions import APIError

from backend.auth import current_user_id
from backend.db import get_client
from backend.models.api import ProfileUpdate

router = APIRouter(prefix="/me", tags=["me"])


@router.get("")
def get_me(uid: str = Depends(current_user_id)):
    """Your profile plus every town you're in."""
    db = get_client()
    profile = db.table("profiles").select("*").eq("id", uid).limit(1).execute().data
    if not profile:
        raise HTTPException(status_code=404, detail="profile not found")
    towns = (
        db.table("town_members").select("house_x, house_y, joined_at, name, color, towns(id, name, invite_code, created_by)")
        .eq("user_id", uid).order("joined_at").execute().data or []
    )
    return {"profile": profile[0], "towns": towns}


@router.patch("")
def update_me(body: ProfileUpdate, uid: str = Depends(current_user_id)):
    changes = body.model_dump(exclude_none=True)
    if "display_name" in changes:
        changes["display_name"] = changes["display_name"].strip()
    if "interests" in changes:
        changes["interests"] = list(dict.fromkeys(i.strip().lower() for i in changes["interests"] if i.strip()))
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    db = get_client()
    try:
        rows = db.table("profiles").update(changes).eq("id", uid).execute().data
    except APIError as e:
        if e.code == "23505":  # unique_violation: only the username column is unique here
            raise HTTPException(status_code=409, detail="username is taken")
        raise
    if not rows:
        raise HTTPException(status_code=404, detail="profile not found")
    return rows[0]


def plan_town_handoff(owned: list[str], others: list[dict]) -> tuple[dict[str, str], list[str]]:
    """For towns the leaving user created: hand each to its longest-standing other member, or delete it
    if nobody else is in it. `others` are town_members rows (town_id, user_id, joined_at) of everyone
    else. Returns ({town_id: new_owner_id}, [town_ids to delete])."""
    transfers, deletes = {}, []
    for tid in owned:
        members = sorted((m for m in others if m["town_id"] == tid), key=lambda m: m["joined_at"])
        if members:
            transfers[tid] = members[0]["user_id"]
        else:
            deletes.append(tid)
    return transfers, deletes


@router.delete("", status_code=204)
def delete_me(uid: str = Depends(current_user_id)):
    """Delete your account and everything tied to it. Deleting the auth user cascades to the profile and
    every row that references it; towns you created (whose creator can't cascade) pass to their oldest
    other member first, and empty ones are deleted."""
    db = get_client()
    owned = [t["id"] for t in db.table("towns").select("id").eq("created_by", uid).execute().data or []]
    others = []
    if owned:
        others = (
            db.table("town_members").select("town_id, user_id, joined_at").in_("town_id", owned)
            .neq("user_id", uid).execute().data or []
        )
    transfers, deletes = plan_town_handoff(owned, others)
    for tid, new_owner in transfers.items():
        db.table("towns").update({"created_by": new_owner}).eq("id", tid).execute()
    if deletes:
        db.table("towns").delete().in_("id", deletes).execute()
    # Friend requests and town invites point at profiles in both directions; clear them explicitly
    db.table("friend_requests").delete().or_(f"from_user.eq.{uid},to_user.eq.{uid}").execute()
    db.table("town_invites").delete().or_(f"from_user.eq.{uid},to_user.eq.{uid}").execute()
    db.auth.admin.delete_user(uid)


@router.get("/friendships")
def my_friendships(uid: str = Depends(current_user_id)):
    """Your friendships, strongest first, with the friend's id and name filled in."""
    db = get_client()
    rows = (
        db.table("friendships").select("*").or_(f"user_a.eq.{uid},user_b.eq.{uid}")
        .order("path_score", desc=True).execute().data or []
    )
    friend_ids = [r["user_b"] if r["user_a"] == uid else r["user_a"] for r in rows]
    names = {}
    if friend_ids:
        profiles = db.table("profiles").select("id, display_name").in_("id", friend_ids).execute().data or []
        names = {p["id"]: p["display_name"] for p in profiles}
    return [{**r, "friend_id": f, "friend_name": names.get(f)} for r, f in zip(rows, friend_ids)]
