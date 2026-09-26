"""Someone else's profile page. What you see depends on how you know them:

- friends and townmates: name, @username, photo, bio, interests (shared ones marked), live free/busy status,
  the towns you're both in, mutual friends, and your own connection with them (only you see that part);
- anyone else (e.g. from username search): name, @username and photo, so you can decide to add them.

Never included: email, invite codes, towns you aren't both in, signals, calendars, anyone's scores with others.
`build_person` is pure; `GET /users/{id}/profile` does the queries.
"""

from datetime import datetime

from backend.status import effective_status


def friend_state(uid: str, row: dict | None) -> dict:
    """friends / requested (you asked) / incoming (they asked; includes the request id to answer) / none."""
    if not row or row["status"] == "declined":
        return {"state": "none"}
    if row["status"] == "accepted":
        return {"state": "friends", "since": row.get("responded_at")}
    if row["from_user"] == uid:
        return {"state": "requested"}
    return {"state": "incoming", "request_id": row["id"]}


def build_person(uid: str, profile: dict, friend_row: dict | None, shared_towns: list[dict], my_interests: list[str],
                 mutual: list[dict], bond: dict | None, now: datetime, busy: dict | None = None) -> dict:
    """profile: their profiles row. shared_towns: [{id, name, residents, their_name, their_color}] for towns you're
    both in. mutual: public profiles of people you're both friends with. bond: your friendships row with them."""
    target = profile["id"]
    avatar = profile.get("avatar") or {}
    friendship = friend_state(uid, friend_row)
    relation = ("self" if target == uid else "friend" if friendship["state"] == "friends"
                else "townmate" if shared_towns else "stranger")
    card = {"id": target, "display_name": profile.get("display_name"), "username": profile.get("username"),
            "photo": avatar.get("photo"), "relation": relation, "friendship": friendship}
    if relation == "stranger":
        return card

    theirs = profile.get("interests") or []
    mine = set(my_interests)
    days = None
    if bond and bond.get("last_interaction_at"):
        then = datetime.fromisoformat(bond["last_interaction_at"].replace("Z", "+00:00"))
        days = int((now - then).total_seconds() // 86400)
    return {
        **card,
        "bio": profile.get("bio") or "",
        "character": avatar.get("character"),
        "status": effective_status(profile, now, busy),
        "interests": [{"name": i, "shared": i in mine} for i in sorted(theirs, key=lambda i: i not in mine)],
        "shared_towns": shared_towns,
        "mutual_friends": mutual[:12],
        "mutual_count": len(mutual),
        # Private to the viewer: how you two have been crossing paths
        "you_two": None if relation == "self" or not bond else {"score": round(float(bond.get("path_score", 0)), 2),
                                                                   "days_since": days},
    }
