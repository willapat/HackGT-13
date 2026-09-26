"""Characters follow their own calendar: leave early enough to arrive, stay until it ends.

This is not an LLM decision. The times and places are what the person shared.
"""

from datetime import datetime, timedelta

from backend.db import iso_in, now_iso, parse_ts
from backend.models.enums import AgentAction
from backend.town_map import buildings, house_building_id

# Minutes to walk from a typical house when we don't have grid coordinates.
TRAVEL_MINUTES = {
    "cafe": 8,
    "gym": 12,
    "market": 10,
    "library": 12,
    "park": 10,
    "downtown": 15,
}
PLACE_FALLBACK = {"campus": "library", "home": None}


def estimate_travel_minutes(building_id: str | None, place: str | None = None) -> int:
    if place == "home" or (building_id or "").startswith("house:"):
        return 6
    if building_id in TRAVEL_MINUTES:
        return TRAVEL_MINUTES[building_id]
    if place == "campus":
        return 18
    return 12


def destination_for(event: dict, user_id: str) -> str | None:
    building = event.get("building_id")
    if building:
        return building
    place = (event.get("text") or event.get("place") or "").strip().lower()
    if place == "home":
        return house_building_id(user_id)
    if event.get("kind") == "appointment":
        return "downtown"
    return PLACE_FALLBACK.get(place)


def current_trip(events: list[dict], user_id: str, now: datetime) -> dict | None:
    """If this person should be walking to an event or already there, describe that trip."""
    ordered = sorted(events, key=lambda e: e.get("start_at") or "")
    for ev in ordered:
        try:
            start, end = parse_ts(ev["start_at"]), parse_ts(ev["end_at"])
        except (KeyError, TypeError, ValueError):
            continue
        dest = destination_for(ev, user_id)
        if not dest:
            continue
        travel = int(ev.get("travel_minutes") or estimate_travel_minutes(dest, ev.get("text")))
        leave = start - timedelta(minutes=travel)
        if leave <= now < end:
            phase = "walking" if now < start else "there"
            return {
                "event": ev,
                "phase": phase,
                "building_id": dest,
                "travel_minutes": travel,
                "leave_at": leave,
                "start_at": start,
                "end_at": end,
                "action": AgentAction.walk_to.value if phase == "walking" else AgentAction.idle.value,
                "until": start if phase == "walking" else end,
            }
    return None


def next_check_iso(until: datetime, now: datetime) -> str:
    seconds = (until - now).total_seconds()
    return iso_in(max(5.0, min(20.0, seconds)))


def snap_town_to_clock(db, town_id: str, now: datetime) -> list[dict]:
    """Put every character where their calendar says they are at `now`. Returns the new agent rows."""
    members = (
        db.table("town_members").select("user_id, house_x, house_y").eq("town_id", town_id).execute().data or []
    )
    tiles = (db.table("towns").select("tiles").eq("id", town_id).limit(1).execute().data or [{}])[0].get("tiles")
    spots = {b["id"]: b for b in buildings(tiles, members)}
    events = (
        db.table("events")
        .select("id, title, kind, start_at, end_at, building_id, text, travel_minutes, event_participants(user_id)")
        .eq("town_id", town_id).eq("type", "personal")
        .execute().data or []
    )
    agents = {a["user_id"]: a for a in db.table("agents").select("*").eq("town_id", town_id).execute().data or []}
    moved = []
    for m in members:
        uid = m["user_id"]
        mine = [e for e in events if uid in {p["user_id"] for p in (e.get("event_participants") or [])}]
        trip = current_trip(mine, uid, now)
        dest = trip["building_id"] if trip else house_building_id(uid)
        action = trip["action"] if trip else AgentAction.idle.value
        title = (trip["event"].get("title") if trip else None) or "home"
        if trip and trip["phase"] == "walking":
            reason = f"Leaving for {title} ({trip['travel_minutes']} min walk)."
        elif trip:
            reason = f"At {title}."
        else:
            reason = "Home — nothing on the calendar right now."
        spot = spots.get(dest) or {}
        target = {k: v for k, v in {"building_id": dest, "x": spot.get("x"), "y": spot.get("y")}.items() if v is not None}
        me = agents.get(uid) or {}
        already = (me.get("target") or {}).get("building_id") == dest and (me.get("action") or "") == action
        if already:
            continue
        db.table("agents").update(
            {"action": action, "target": target or None, "next_decision_at": now_iso(), "updated_at": now_iso()}
        ).eq("town_id", town_id).eq("user_id", uid).execute()
        moved.append({"user_id": uid, "action": action, "target": target, "reason": reason})
    return moved
