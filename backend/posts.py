"""Posts people write themselves (signals with `value.audience`), as feed cards. Shown word for word: the
author chose to share them, so nothing is generated. Who sees what:

- "town": people in that town;
- "friends": the author's friends (in any town or none);
- "private": only the author (nobody else, ever; the town may only change their character's mood from it).
"""

from datetime import datetime

from backend.status import active_status


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
        visible = (who == uid if audience == "private"
                   else town_id in towns if audience == "town"
                   else who == uid or who in friends)
        if not visible:
            continue
        actor = author(sig, town_id)
        if not actor:
            continue
        items.append({"id": f"post:{sig['id']}", "kind": "post", "audience": audience, "at": sig["created_at"],
                      "town": {"id": town_id, "name": towns[town_id]} if town_id else None,
                      "actor": actor, "mine": who == uid, "text": text, "mood": v.get("mood")})
    return items
