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
        db.table("town_members").select("house_x, house_y, joined_at, towns(id, name, invite_code, created_by)")
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
    try:
        rows = get_client().table("profiles").update(changes).eq("id", uid).execute().data
    except APIError as e:
        if e.code == "23505":  # unique_violation: only the username column is unique here
            raise HTTPException(status_code=409, detail="username is taken")
        raise
    if not rows:
        raise HTTPException(status_code=404, detail="profile not found")
    return rows[0]


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
