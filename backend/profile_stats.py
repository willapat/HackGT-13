"""Profile highlights: your towns ranked by activity and size, the people you're closest to, and townmates
you haven't crossed paths with lately. Everything is counted from stored rows (agent actions, brain news,
friendship scores, confirmed plans), never generated. `build_stats` is pure; `GET /me/stats` does the queries.
"""

from datetime import datetime

from backend.identity import member_name
from backend.status import effective_status

WEEK_DAYS = 7
RECONNECT_AFTER_DAYS = 7


def _days_between(then: str | None, now: datetime) -> float | None:
    if not then:
        return None
    return (now - datetime.fromisoformat(then.replace("Z", "+00:00"))).total_seconds() / 86400


def build_stats(uid: str, towns: dict[str, str], members: list[dict], actions: list[dict], runs: list[dict],
                friendships: list[dict], hangouts: int, shared: int, now: datetime, busy: dict[str, dict] | None = None) -> dict:
    """towns: {town_id: name}. members: town_members rows (with profiles) of those towns. actions / runs:
    agent_actions and brain_runs from the last week. friendships: your rows. Returns the profile highlights."""
    activity = {tid: 0 for tid in towns}
    for a in actions:
        activity[a["town_id"]] = activity.get(a["town_id"], 0) + 1
    for r in runs:
        activity[r["town_id"]] = activity.get(r["town_id"], 0) + len((r.get("output") or {}).get("news") or [])

    town_rows = []
    for tid, name in towns.items():
        residents = sum(1 for m in members if m["town_id"] == tid)
        town_rows.append({"id": tid, "name": name, "residents": residents, "activity_week": activity.get(tid, 0)})
    most_active = max((t for t in town_rows if t["activity_week"]), key=lambda t: t["activity_week"], default=None)
    biggest = max(town_rows, key=lambda t: t["residents"], default=None)

    # Everyone you share a town with, once, with the first town you share
    mates: dict[str, dict] = {}
    for m in members:
        if m["user_id"] != uid and m["user_id"] not in mates:
            mates[m["user_id"]] = {"user_id": m["user_id"], "name": member_name(m) or "Someone", "color": m.get("color"),
                                   "status": effective_status(m.get("profiles"), now, (busy or {}).get(m["user_id"])),
                                   "photo": ((m.get("profiles") or {}).get("avatar") or {}).get("photo"),
                                   "town": {"id": m["town_id"], "name": towns.get(m["town_id"], "Town")}}
    bonds = {}
    for f in friendships:
        other = f["user_b"] if f["user_a"] == uid else f["user_a"]
        bonds[other] = f

    people = []
    for other, mate in mates.items():
        f = bonds.get(other) or {}
        days = _days_between(f.get("last_interaction_at"), now)
        people.append({**mate, "score": round(float(f.get("path_score", 0.0)), 2) if f else None,
                       "last_at": f.get("last_interaction_at"), "days_since": None if days is None else int(days)})

    closest = sorted((p for p in people if p["score"] is not None), key=lambda p: -p["score"])[:5]
    # Longest gap first; people you've never crossed paths with come after the ones you've drifted from
    reconnect = sorted((p for p in people if p["days_since"] is None or p["days_since"] >= RECONNECT_AFTER_DAYS),
                       key=lambda p: (p["days_since"] is None, -(p["days_since"] or 0)))[:3]

    return {"towns": town_rows, "most_active": most_active, "biggest": biggest, "closest": closest,
            "reconnect": reconnect, "hangouts": hangouts, "shared": shared, "townmates": len(mates)}
