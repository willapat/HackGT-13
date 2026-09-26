"""People you may know (GET /friends/suggestions), counted from stored rows, nothing generated:

- friends of your friends, ranked by how many friends you share;
- people in a town with you who aren't your friends yet.

Nobody you already have a request with, in either direction or any status, is suggested: not your friends,
not pending requests, and not someone who declined (or whom you declined).
"""

MUTUAL_WEIGHT, TOWN_WEIGHT = 3, 2


def suggest(uid: str, pairs: list[dict], friend_pairs: list[dict], townmates: dict[str, list[str]],
            limit: int = 12) -> list[dict]:
    """pairs: every friend_requests row involving you. friend_pairs: accepted rows involving any of your friends.
    townmates: {user_id: [names of towns you share]} for people in a town with you.
    Returns [{id, mutual_ids, towns}] best first."""
    friends = {r["to_user"] if r["from_user"] == uid else r["from_user"] for r in pairs if r["status"] == "accepted"}
    known = {uid} | {r["to_user"] if r["from_user"] == uid else r["from_user"] for r in pairs}
    mutual: dict[str, set[str]] = {}
    for r in friend_pairs:
        for friend, other in ((r["from_user"], r["to_user"]), (r["to_user"], r["from_user"])):
            if friend in friends and other not in known:
                mutual.setdefault(other, set()).add(friend)
    people = (set(mutual) | set(townmates)) - known
    ranked = sorted(people, key=lambda p: (-(MUTUAL_WEIGHT * len(mutual.get(p, ())) + TOWN_WEIGHT * len(townmates.get(p, ()))), p))
    return [{"id": p, "mutual_ids": sorted(mutual.get(p, ())), "towns": townmates.get(p, [])} for p in ranked[:limit]]
