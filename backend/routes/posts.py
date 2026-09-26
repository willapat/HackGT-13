"""Reactions and comments on posts. A post is a signal with `value.audience`; its feed id is `post:<signal id>`.
You can react to or comment on any town or friends post you can see (see backend/posts.py)."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from backend.auth import current_user_id
from backend.db import get_client
from backend.posts import REACTIONS, can_respond, comment_item

router = APIRouter(prefix="/posts", tags=["posts"])


class ReactionIn(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def known(cls, v: str) -> str:
        if v not in REACTIONS:
            raise ValueError(f"emoji must be one of {' '.join(REACTIONS)}")
        return v


class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=500)

    @field_validator("text")
    @classmethod
    def not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("write something first")
        return v.strip()


def friend_ids(db, uid: str) -> set[str]:
    rows = (db.table("friend_requests").select("from_user, to_user").or_(f"from_user.eq.{uid},to_user.eq.{uid}")
            .eq("status", "accepted").execute().data or [])
    return {r["to_user"] if r["from_user"] == uid else r["from_user"] for r in rows}


def load_post(db, signal_id: str, uid: str) -> dict:
    """The post, if uid may react to and comment on it; 404 otherwise (so nobody can probe private posts)."""
    rows = db.table("signals").select("id, user_id, value").eq("id", signal_id).limit(1).execute().data
    sig = rows[0] if rows else None
    if sig:
        towns = {m["town_id"] for m in db.table("town_members").select("town_id").eq("user_id", uid).execute().data or []}
        if can_respond(uid, sig, towns, friend_ids(db, uid)):
            return sig
    raise HTTPException(status_code=404, detail="post not found")


def author(db, sig: dict, user_id: str) -> dict:
    """How a commenter shows: their name in the post's town when it has one, else their account name."""
    prof = (db.table("profiles").select("display_name, avatar").eq("id", user_id).limit(1).execute().data or [{}])[0]
    out = {"name": prof.get("display_name"), "photo": (prof.get("avatar") or {}).get("photo"), "color": None}
    town_id = (sig.get("value") or {}).get("town_id")
    if town_id:
        m = (db.table("town_members").select("name, color").eq("town_id", town_id).eq("user_id", user_id)
             .limit(1).execute().data or [{}])[0]
        out = {**out, "name": m.get("name") or out["name"], "color": m.get("color")}
    return out


def reaction_summary(db, signal_id: str, uid: str) -> dict:
    rows = db.table("post_reactions").select("user_id, emoji").eq("signal_id", signal_id).execute().data or []
    counts = {}
    for r in rows:
        counts[r["emoji"]] = counts.get(r["emoji"], 0) + 1
    order = sorted(counts.items(), key=lambda kv: (-kv[1], REACTIONS.index(kv[0])))
    return {"reactions": [{"emoji": e, "count": n} for e, n in order],
            "my_reaction": next((r["emoji"] for r in rows if r["user_id"] == uid), None)}


@router.put("/{signal_id}/reaction")
def react(signal_id: str, body: ReactionIn, uid: str = Depends(current_user_id)):
    """React to a post (one reaction each; sending another replaces yours). Returns the post's reaction counts."""
    db = get_client()
    load_post(db, signal_id, uid)
    db.table("post_reactions").upsert({"signal_id": signal_id, "user_id": uid, "emoji": body.emoji,
                                       "created_at": datetime.now(timezone.utc).isoformat()},
                                      on_conflict="signal_id,user_id").execute()
    return reaction_summary(db, signal_id, uid)


@router.delete("/{signal_id}/reaction")
def unreact(signal_id: str, uid: str = Depends(current_user_id)):
    db = get_client()
    load_post(db, signal_id, uid)
    db.table("post_reactions").delete().eq("signal_id", signal_id).eq("user_id", uid).execute()
    return reaction_summary(db, signal_id, uid)


@router.get("/{signal_id}/comments")
def list_comments(signal_id: str, uid: str = Depends(current_user_id)):
    db = get_client()
    sig = load_post(db, signal_id, uid)
    rows = (db.table("post_comments").select("*").eq("signal_id", signal_id).order("created_at").execute().data or [])
    authors = {u: author(db, sig, u) for u in {r["user_id"] for r in rows}}
    return [comment_item(r, uid, sig["user_id"] == uid, authors) for r in rows]


@router.post("/{signal_id}/comments", status_code=201)
def add_comment(signal_id: str, body: CommentIn, uid: str = Depends(current_user_id)):
    """Comment under a post. The post's author gets an Inbox notice (unless it's their own comment)."""
    db = get_client()
    sig = load_post(db, signal_id, uid)
    rows = db.table("post_comments").insert({"signal_id": signal_id, "user_id": uid, "text": body.text}).execute().data
    if not rows:
        raise HTTPException(status_code=500, detail="insert failed")
    me = author(db, sig, uid)
    if sig["user_id"] != uid:
        post_text = ((sig.get("value") or {}).get("text") or "").strip()
        db.table("notifications").insert({"user_id": sig["user_id"], "kind": "post_comment", "payload": {
            "by_name": me["name"] or "Someone", "by_user_id": uid, "text": body.text[:140],
            "post_text": post_text[:80]}}).execute()
    return comment_item(rows[0], uid, sig["user_id"] == uid, {uid: me})


@router.delete("/{signal_id}/comments/{comment_id}", status_code=204)
def delete_comment(signal_id: str, comment_id: int, uid: str = Depends(current_user_id)):
    """Delete your own comment, or any comment under your own post."""
    db = get_client()
    sig = load_post(db, signal_id, uid)
    rows = (db.table("post_comments").select("user_id").eq("id", comment_id).eq("signal_id", signal_id)
            .limit(1).execute().data)
    if not rows:
        raise HTTPException(status_code=404, detail="comment not found")
    if rows[0]["user_id"] != uid and sig["user_id"] != uid:
        raise HTTPException(status_code=403, detail="you can only delete your own comments")
    db.table("post_comments").delete().eq("id", comment_id).execute()
