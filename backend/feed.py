"""The home feed: what's happening across every town you're in, newest first.

Built from rows the town loops already wrote (brain news, character actions, calendar items), so nothing
here is generated. `build_feed` is pure; `GET /me/feed` does the queries.
"""

from datetime import datetime, timedelta

from backend.identity import member_name
from backend.models.enums import EventStatus, ParticipantStatus
from backend.status import effective_status

# Character actions worth a feed card. idle / walk_to / go_home are just movement.
SOCIAL_VERBS = {
    "chat": "chatted with",
    "visit": "stopped by to see",
    "knock": "knocked on the door of",
    "leave_gift": "left something at the door of",
    "propose_event": "suggested a plan with",
}
TODAY_WINDOW = timedelta(hours=24)


def _parse(ts: str | None) -> datetime | None:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")) if ts else None


def build_feed(uid: str, towns: dict[str, str], members: list[dict], runs: list[dict], actions: list[dict],
               events: list[dict], now: datetime, limit: int = 40, busy: dict[str, dict] | None = None,
               post_ids: set[str] = frozenset()) -> dict:
    """towns: {town_id: name}. members: town_members rows (with profiles) of those towns. runs: brain_runs.
    actions: agent_actions. events: events with event_participants. post_ids: ids of signals that are posts
    (posts.is_post). Returns {towns, items, today, inbox}."""
    people = {(m["town_id"], m["user_id"]): {"user_id": m["user_id"], "name": member_name(m) or "Someone", "color": m.get("color"),
                                              "status": effective_status(m.get("profiles"), now, (busy or {}).get(m["user_id"])),
                                              "photo": ((m.get("profiles") or {}).get("avatar") or {}).get("photo")} for m in members}

    def who(tid, user_id):
        return people.get((tid, user_id)) if user_id else None

    def town(tid):
        return {"id": tid, "name": towns.get(tid, "Town")}

    items = []
    for run in runs:
        tid = run["town_id"]
        read = set(((run.get("input") or {}).get("signal_ids")) or [])
        for i, n in enumerate(((run.get("output") or {}).get("news")) or []):
            # A post shows word for word, so skip news about one (runs from before news cited its signals
            # can't say which headline came from the post, so a run that read one shows no news)
            cited = set(n.get("source_signal_ids") or [])
            if post_ids & (cited or read):
                continue
            items.append({"id": f"news:{run['id']}:{i}", "kind": "news", "town": town(tid), "at": run["created_at"],
                          "actor": None, "title": n.get("title"), "text": n.get("text")})

    for a in actions:
        verb = SOCIAL_VERBS.get(a["action"])
        if not verb:
            continue
        tid, d = a["town_id"], a.get("details") or {}
        actor, target = who(tid, a["user_id"]), who(tid, d.get("target_user_id"))
        if not actor or not target:
            continue
        lines = []
        for ln in d.get("lines") or []:
            speaker = who(tid, ln.get("speaker_id")) or {}
            if ln.get("text"):
                lines.append({"name": speaker.get("name", ""), "color": speaker.get("color"), "text": ln["text"]})
        items.append({"id": f"action:{a['id']}", "kind": "chat" if lines else "social", "town": town(tid),
                      "at": a["created_at"], "action": a["action"], "actor": actor, "target": target,
                      "title": f"{actor['name']} {verb} {target['name']}", "text": None, "lines": lines})

    inbox, today = [], []
    for e in events:
        tid = e["town_id"]
        parts = {p["user_id"]: p["status"] for p in e.get("event_participants") or []}
        going = [who(tid, u) for u, s in parts.items() if s == ParticipantStatus.accepted.value and who(tid, u)]
        # Waiting on me: I haven't answered a suggestion yet, or everyone said yes and the plan needs approving
        needs_answer = e["status"] == EventStatus.suggested.value and parts.get(uid) == ParticipantStatus.suggested.value
        needs_approval = e["status"] == EventStatus.scheduled.value and uid in parts
        if needs_answer or needs_approval:
            inbox.append({"id": e["id"], "kind": "plan", "status": e["status"], "town": town(tid), "title": e.get("title"),
                          "text": e.get("text"), "start_at": e.get("start_at"), "going": going,
                          "people": [who(tid, u) for u in parts if u != uid and who(tid, u)]})
        start = _parse(e.get("start_at"))
        if start and now <= start <= now + TODAY_WINDOW and e["status"] != EventStatus.cancelled.value:
            today.append({"id": e["id"], "town": town(tid), "title": e.get("title"), "kind": e.get("kind"),
                          "start_at": e["start_at"], "end_at": e.get("end_at"), "people": going})
        if e["status"] == EventStatus.confirmed.value and going:
            items.append({"id": f"plan:{e['id']}", "kind": "plan", "town": town(tid), "at": e.get("created_at"),
                          "actor": going[0], "title": f"Plan on: {e.get('title') or 'hanging out'}", "text": e.get("text"),
                          "people": going, "start_at": e.get("start_at")})

    # Same headline from back-to-back brain runs shows once
    seen, deduped = set(), []
    for it in sorted(items, key=lambda it: it["at"] or "", reverse=True):
        key = (it["kind"], it["town"]["id"], it["title"])
        if it["kind"] == "news" and key in seen:
            continue
        seen.add(key)
        deduped.append(it)

    today.sort(key=lambda t: t["start_at"])
    # One card per town: who lives there, its latest headline, and how much happened in the last day
    since = now - TODAY_WINDOW
    summaries = []
    for tid, name in towns.items():
        mine = [it for it in deduped if it["town"]["id"] == tid]
        summaries.append({
            "id": tid, "name": name,
            "residents": [p for (t, _), p in people.items() if t == tid],
            "headline": mine[0]["title"] if mine else None,
            "new": sum(1 for it in mine if (_parse(it["at"]) or since) > since),
        })
    # Townmates who marked themselves free, once each, soonest-ending last so fresh ones lead
    free, seen_free = [], set()
    for (tid, user_id), p in people.items():
        if user_id != uid and user_id not in seen_free and (p["status"] or {}).get("status") == "free":
            seen_free.add(user_id)
            free.append({**p, "town": town(tid)})
    free.sort(key=lambda p: p["status"]["until"], reverse=True)
    return {"towns": summaries, "items": deduped[:limit], "today": today[:12], "inbox": inbox, "free_now": free}


def town_layout(town: dict, members: list[dict]) -> dict | None:
    """What a town card needs to draw the town: its tile grid, friends' homes (tile, plot, color) and the tint
    of the unowned background houses. None when the town has no stored map."""
    tiles = town.get("tiles")
    if not tiles:
        return None
    homes = [{"x": m["house_x"], "y": m["house_y"], "block": (m.get("home") or {}).get("block"), "color": m.get("color")}
             for m in members if m.get("house_x") is not None and m.get("house_y") is not None]
    town_map = town.get("map") or {}
    return {"tiles": tiles, "homes": homes, "background_color": (town_map.get("background_homes") or {}).get("color"),
            "landscape": town_map.get("landscape") or "green"}
