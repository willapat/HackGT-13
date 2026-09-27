"""Posts people write themselves (signals with `value.audience`), as feed cards. Shown word for word: the
author chose to share them, so nothing is generated. Who sees what:

- "town": people in that town;
- "friends": the author's friends (in any town or none);
- "private": only the author (nobody else, ever; the town may only change their character's mood from it).

Anyone who can see a town or friends post can react to it (one emoji each) and comment under it. Private posts
take neither: nobody else sees them.
"""

from datetime import datetime
from typing import Callable

from backend.status import active_status

REACTIONS = ("❤️", "😂", "🎉", "😮", "😢", "👏")  # matches the post_reactions.emoji check


def is_post(signal: dict) -> bool:
    """A post someone wrote in the composer. It already shows on the feed word for word, so the town
    brain never turns it into news (one post read by six towns' brains made six paraphrased copies)."""
    return bool((signal.get("value") or {}).get("audience"))


def can_see(uid: str, sig: dict, town_ids, friend_ids) -> bool:
    """Whether `uid` may see this post. town_ids: towns uid is in. friend_ids: uid's friends."""
    v = sig.get("value") or {}
    audience, who = v.get("audience"), sig["user_id"]
    if audience == "private":
        return who == uid
    if audience == "town":
        return v.get("town_id") in town_ids
    return audience == "friends" and (who == uid or who in friend_ids)


def can_respond(uid: str, sig: dict, town_ids, friend_ids) -> bool:
    """Reacting and commenting: any post you can see, except private ones (only their author sees those)."""
    return (sig.get("value") or {}).get("audience") in ("town", "friends") and can_see(uid, sig, town_ids, friend_ids)


def with_responses(items: list[dict], reactions: list[dict], comments: list[dict], uid: str,
                   authors: Callable[[str, str | None], dict]) -> list[dict]:
    """Adds `reactions` ([{emoji, count}], most first), `my_reaction` and `comments` (oldest first) to post items.
    reactions/comments: post_reactions/post_comments rows for these posts. authors(user_id, town_id) gives
    {name, photo, color} for a commenter (their name in the post's town when it has one)."""
    for it in items:
        if it.get("kind") != "post" or it.get("audience") == "private":
            continue
        sid = it["id"].removeprefix("post:")
        mine = [r for r in reactions if str(r["signal_id"]) == sid]
        counts = {}
        for r in mine:
            counts[r["emoji"]] = counts.get(r["emoji"], 0) + 1
        it["reactions"] = [{"emoji": e, "count": n} for e, n in
                           sorted(counts.items(), key=lambda kv: (-kv[1], REACTIONS.index(kv[0]) if kv[0] in REACTIONS else 99))]
        it["my_reaction"] = next((r["emoji"] for r in mine if r["user_id"] == uid), None)
        town_id = (it.get("town") or {}).get("id")
        rows = sorted((c for c in comments if str(c["signal_id"]) == sid), key=lambda c: c["created_at"])
        who = {c["user_id"]: authors(c["user_id"], town_id) for c in rows}
        it["comments"] = [comment_item(c, uid, it["mine"], who) for c in rows]
    return items


def comment_item(c: dict, uid: str, post_is_mine: bool, authors: dict[str, dict]) -> dict:
    who = authors.get(c["user_id"]) or {}
    return {"id": c["id"], "at": c["created_at"], "text": c["text"], "mine": c["user_id"] == uid,
            "can_delete": c["user_id"] == uid or post_is_mine,  # your own comment, or anything under your post
            "author": {"user_id": c["user_id"], "name": who.get("name") or "Someone",
                       "photo": who.get("photo"), "color": who.get("color")}}


def post_items(uid: str, signals: list[dict], towns: dict[str, str], people: dict[tuple[str, str], dict],
               friends: dict[str, dict], now: datetime) -> list[dict]:
    """signals: recent manual signals from you, your friends and your townmates. towns: {town_id: name} you're in.
    people: {(town_id, user_id): person} for your townmates. friends: {user_id: profile} of your friends."""
    def author(sig: dict, town_id: str | None) -> dict | None:
        who = sig["user_id"]
        if town_id and (town_id, who) in people:
            return people[(town_id, who)]
        mate = next((p for (t, u), p in people.items() if u == who), None)
        if mate:
            return mate
        prof = friends.get(who)
        if prof:
            return {"user_id": who, "name": prof.get("display_name") or "Someone", "color": None,
                    "photo": (prof.get("avatar") or {}).get("photo"), "status": active_status(prof, now)}
        return None

    items = []
    for sig in signals:
        v = sig.get("value") or {}
        audience, who = v.get("audience"), sig["user_id"]
        text = (v.get("text") or "").strip()
        if not audience or not (text or v.get("mood")):
            continue
        town_id = v.get("town_id") if audience == "town" else None
        if not can_see(uid, sig, towns, friends):
            continue
        actor = author(sig, town_id)
        if not actor:
            continue
        items.append({"id": f"post:{sig['id']}", "kind": "post", "audience": audience, "at": sig["created_at"],
                      "town": {"id": town_id, "name": towns[town_id]} if town_id else None,
                      "actor": actor, "mine": who == uid, "text": text, "mood": v.get("mood")})
    return items
