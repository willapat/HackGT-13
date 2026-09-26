from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from postgrest.exceptions import APIError

from backend.auth import current_user_id
from backend.db import get_client
from backend import photos
from backend.feed import SOCIAL_VERBS, TODAY_WINDOW, build_feed, town_layout
from backend.profile_stats import WEEK_DAYS, build_stats
from backend.status import MAX_LENGTH, active_status, calendar_busy
from backend.models.api import ProfileUpdate, StatusIn

router = APIRouter(prefix="/me", tags=["me"])


@router.get("")
def get_me(uid: str = Depends(current_user_id)):
    """Your profile plus every town you're in."""
    db = get_client()
    profile = db.table("profiles").select("*").eq("id", uid).limit(1).execute().data
    if not profile:
        raise HTTPException(status_code=404, detail="profile not found")
    towns = (
        db.table("town_members").select("house_x, house_y, home, joined_at, name, color, towns(id, name, invite_code, created_by)")
        .eq("user_id", uid).order("joined_at").execute().data or []
    )
    return {"profile": profile[0], "towns": towns}


@router.patch("")
def update_me(body: ProfileUpdate, uid: str = Depends(current_user_id)):
    changes = body.model_dump(exclude_none=True)
    if "display_name" in changes:
        changes["display_name"] = changes["display_name"].strip()
    if "bio" in changes:
        changes["bio"] = " ".join(changes["bio"].split())  # one line, no stray whitespace
    if "interests" in changes:
        changes["interests"] = list(dict.fromkeys(i.strip().lower() for i in changes["interests"] if i.strip()))
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    db = get_client()
    if "avatar" in changes:  # the photo inside avatar is server-owned (PUT /me/photo); keep the stored one
        stored = db.table("profiles").select("avatar").eq("id", uid).limit(1).execute().data
        kept = {k: v for k, v in ((stored[0]["avatar"] if stored else None) or {}).items() if k in photos.PHOTO_KEYS}
        changes["avatar"] = {**{k: v for k, v in changes["avatar"].items() if k not in photos.PHOTO_KEYS}, **kept}
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


@router.get("/feed")
def my_feed(uid: str = Depends(current_user_id)):
    """What's happening across your towns: news, visits and chats, plans. Plus today's calendar and plans waiting on you."""
    db = get_client()
    mine = db.table("town_members").select("town_id, towns(name, tiles, map)").eq("user_id", uid).execute().data or []
    towns = {m["town_id"]: (m.get("towns") or {}).get("name") or "Town" for m in mine}
    if not towns:
        return {"towns": [], "items": [], "today": [], "inbox": [], "free_now": []}
    ids = list(towns)
    members = (db.table("town_members").select("town_id, user_id, name, color, house_x, house_y, home, profiles(*)")
               .in_("town_id", ids).execute().data or [])
    runs = (db.table("brain_runs").select("id, town_id, output, created_at").in_("town_id", ids)
            .not_.is_("output", "null").order("created_at", desc=True).limit(15).execute().data or [])
    actions = (db.table("agent_actions").select("id, town_id, user_id, action, details, created_at").in_("town_id", ids)
               .in_("action", list(SOCIAL_VERBS)).order("id", desc=True).limit(40).execute().data or [])
    now = datetime.now(timezone.utc)
    stamp = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")  # no "+00:00": a "+" in the filter reads as a space
    soon = stamp(now + TODAY_WINDOW)
    events = (db.table("events").select("*, event_participants(user_id, status)").in_("town_id", ids)
              .or_(f"status.in.(suggested,scheduled,confirmed),and(start_at.gte.{stamp(now)},start_at.lte.{soon})")
              .order("created_at", desc=True).limit(200).execute().data or [])
    busy = calendar_busy(db, list({m["user_id"] for m in members}), now)
    feed = build_feed(uid, towns, members, runs, actions, events, now, busy=busy)
    feed["my_calendar_busy"] = busy.get(uid)  # your own ring when you haven't set a status
    # The real layout, so town cards can draw each town as it is (roads, parks, friends' houses in their colors)
    layouts = {m["town_id"]: town_layout((m.get("towns") or {}), [x for x in members if x["town_id"] == m["town_id"]]) for m in mine}
    for t in feed["towns"]:
        t["layout"] = layouts.get(t["id"])
    return feed


@router.get("/stats")
def my_stats(uid: str = Depends(current_user_id)):
    """Profile highlights: most active and biggest town, closest people, who to reconnect with, plans that happened."""
    db = get_client()
    mine = db.table("town_members").select("town_id, towns(name)").eq("user_id", uid).execute().data or []
    towns = {m["town_id"]: (m.get("towns") or {}).get("name") or "Town" for m in mine}
    ids = list(towns)
    since = (datetime.now(timezone.utc) - timedelta(days=WEEK_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
    members = actions = runs = []
    if ids:
        members = (db.table("town_members").select("town_id, user_id, name, color, profiles(*)")
                   .in_("town_id", ids).execute().data or [])
        actions = (db.table("agent_actions").select("town_id").in_("town_id", ids).neq("action", "idle")
                   .gte("created_at", since).limit(2000).execute().data or [])
        runs = (db.table("brain_runs").select("town_id, output").in_("town_id", ids).not_.is_("output", "null")
                .gte("created_at", since).limit(200).execute().data or [])
    friendships = db.table("friendships").select("*").or_(f"user_a.eq.{uid},user_b.eq.{uid}").execute().data or []
    mine_going = (db.table("event_participants").select("event_id, events(status)").eq("user_id", uid)
                  .eq("status", "accepted").execute().data or [])
    hangouts = sum(1 for p in mine_going if (p.get("events") or {}).get("status") == "confirmed")
    shared = db.table("signals").select("id", count="exact").eq("user_id", uid).limit(1).execute().count or 0
    now = datetime.now(timezone.utc)
    busy = calendar_busy(db, list({m["user_id"] for m in members}), now)
    return build_stats(uid, towns, members, actions, runs, friendships, hangouts, shared, now, busy=busy)


@router.put("/status")
def set_status(body: StatusIn, uid: str = Depends(current_user_id)):
    """Free or busy until a time (at most 48h out), or clear it. Friends and townmates see it as a ring on your avatar."""
    now = datetime.now(timezone.utc)
    if body.status is None:
        change = {"status": None, "status_until": None}
    else:
        until = body.until.astimezone(timezone.utc) if body.until and body.until.tzinfo else None
        if until is None or not now < until <= now + MAX_LENGTH:
            raise HTTPException(status_code=422, detail="until must be a time in the next 48 hours, with a timezone")
        change = {"status": body.status, "status_until": until.isoformat()}
    rows = get_client().table("profiles").update(change).eq("id", uid).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="profile not found")
    return {**rows[0], "active_status": active_status(rows[0], now)}


def _replace_photo(uid: str, photo: dict | None) -> dict:
    """Point the profile at a new photo (or none) and delete the old file."""
    db = get_client()
    row = db.table("profiles").select("avatar").eq("id", uid).limit(1).execute().data
    if not row:
        raise HTTPException(status_code=404, detail="profile not found")
    avatar = {k: v for k, v in (row[0]["avatar"] or {}).items() if k not in photos.PHOTO_KEYS}
    old_path = (row[0]["avatar"] or {}).get("photo_path")
    updated = db.table("profiles").update({"avatar": {**avatar, **(photo or {})}}).eq("id", uid).execute().data
    photos.remove(db, old_path)
    return updated[0]


@router.put("/photo")
async def set_photo(request: Request, uid: str = Depends(current_user_id)):
    """Upload a profile photo as the raw request body (JPEG, PNG or WebP, up to 2 MB)."""
    data = await request.body()
    if len(data) > photos.MAX_BYTES:
        raise HTTPException(status_code=413, detail="photo must be 2 MB or smaller")
    ext = photos.sniff(data)
    if not ext:
        raise HTTPException(status_code=415, detail="photo must be a JPEG, PNG or WebP image")

    def save():
        db = get_client()
        photos.ensure_bucket(db)
        url, path = photos.store(db, uid, data, ext)
        return _replace_photo(uid, {"photo": url, "photo_path": path})

    return await run_in_threadpool(save)


@router.delete("/photo")
def delete_photo(uid: str = Depends(current_user_id)):
    """Remove your profile photo; your initials show again."""
    return _replace_photo(uid, None)
