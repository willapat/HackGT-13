"""Characters follow their own calendar: leave early enough to arrive, stay until it ends.

This is not an LLM decision. The times and places are what the person shared.
"""

from datetime import datetime, timedelta

from backend.db import iso_in, now_iso, parse_ts, writer
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
PLACE_FALLBACK = {"campus": "library"}


def estimate_travel_minutes(building_id: str | None, place: str | None = None) -> int:
    if place == "home" or (building_id or "").startswith("house:"):
        return 6
    if building_id in TRAVEL_MINUTES:
        return TRAVEL_MINUTES[building_id]
    if place == "campus":
        return 18
    return 12


def destination_for(event: dict, user_id: str) -> str:
    """Always a walkable place. Infers from text/kind when the row left building_id empty."""
    building = (event.get("building_id") or "").strip()
    if building:
        return building
    place = (event.get("text") or event.get("place") or "").strip().lower()
    if place == "home":
        return house_building_id(user_id)
    if place == "campus" or event.get("kind") == "class":
        return "library"
    if event.get("kind") == "appointment":
        return "downtown"
    return PLACE_FALLBACK.get(place) or "downtown"


def _blocks(events: list[dict], user_id: str) -> list[dict]:
    out = []
    for ev in events:
        try:
            start, end = parse_ts(ev["start_at"]), parse_ts(ev["end_at"])
        except (KeyError, TypeError, ValueError):
            continue
        dest = destination_for(ev, user_id)
        travel = int(ev.get("travel_minutes") or estimate_travel_minutes(dest, ev.get("text")))
        out.append({
            "event": ev,
            "start": start,
            "end": end,
            "dest": dest,
            "travel": travel,
            "leave": start - timedelta(minutes=travel),
        })
    out.sort(key=lambda b: b["start"])
    return out


def _trip(
    block: dict, phase: str, building_id: str, action: str, until: datetime,
    travel: int | None = None, depart_at: datetime | None = None,
) -> dict:
    ev = block["event"]
    return {
        "event": ev,
        "phase": phase,
        "building_id": building_id,
        "travel_minutes": block["travel"] if travel is None else travel,
        "leave_at": block["leave"],
        "depart_at": depart_at or block["leave"],
        "start_at": block["start"],
        "end_at": block["end"],
        "action": action,
        "until": until,
    }


def current_trip(events: list[dict], user_id: str, now: datetime) -> dict | None:
    """Walk to the current event, stay until it ends, then walk home and wait there."""
    home = house_building_id(user_id)
    blocks = _blocks(events, user_id)
    for b in blocks:
        if b["leave"] <= now < b["end"]:
            if now < b["start"]:
                return _trip(b, "walking", b["dest"], AgentAction.walk_to.value, b["start"], depart_at=b["leave"])
            return _trip(b, "there", b["dest"], AgentAction.idle.value, b["end"])

    finished = [b for b in blocks if b["end"] <= now]
    if not finished:
        return None
    last = finished[-1]
    next_leave = next((b["leave"] for b in blocks if b["leave"] > now), None)
    arrive_home = last["end"] + timedelta(minutes=last["travel"] if last["dest"] != home else 0)
    if last["dest"] != home and now < arrive_home and (next_leave is None or now < next_leave):
        until = arrive_home if next_leave is None else min(arrive_home, next_leave)
        return _trip(last, "going_home", home, AgentAction.walk_to.value, until, depart_at=last["end"])
    return _trip(
        last, "home", home, AgentAction.idle.value,
        next_leave or now + timedelta(minutes=20), travel=0,
    )


def next_check_iso(until: datetime, now: datetime) -> str:
    seconds = (until - now).total_seconds()
    return iso_in(max(5.0, min(20.0, seconds)))


def _spot_xy(spot: dict | None) -> tuple[float, float] | None:
    """Door where a character stands, else the building tile."""
    if not spot:
        return None
    door = spot.get("door")
    if isinstance(door, (list, tuple)) and len(door) >= 2:
        return float(door[0]), float(door[1])
    if spot.get("x") is not None and spot.get("y") is not None:
        return float(spot["x"]), float(spot["y"])
    return None


def _near(a, b) -> bool:
    return a is not None and b is not None and abs(a[0] - b[0]) < 0.2 and abs(a[1] - b[1]) < 0.2


def snap_town_to_clock(db, town_id: str, now: datetime) -> list[dict]:
    """Start a walk to wherever the calendar says each person should be at `now`.

    agents.x/y is the curb they leave from. The client walks that to target over travel_minutes
    (one real second per minute while the slider is paused). People already standing there stay put.
    """
    members = (
        db.table("town_members").select("user_id, house_x, house_y, home").eq("town_id", town_id).execute().data or []
    )
    town = (db.table("towns").select("tiles, map").eq("id", town_id).limit(1).execute().data or [{}])[0]
    spots = {b["id"]: b for b in buildings(town.get("map"), members)}
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
        home_id = house_building_id(uid)
        mine = [e for e in events if uid in {p["user_id"] for p in (e.get("event_participants") or [])}]
        trip = current_trip(mine, uid, now)
        dest = trip["building_id"] if trip else home_id
        phase = trip["phase"] if trip else "home"
        title = (trip["event"].get("title") if trip else None) or "home"
        travel = int(trip["travel_minutes"]) if trip and trip.get("travel_minutes") else estimate_travel_minutes(dest)
        me = agents.get(uid) or {}
        old = me.get("target") or {}
        old_id = old.get("building_id")
        end = _spot_xy(spots.get(dest))
        here = (float(me["x"]), float(me["y"])) if me.get("x") is not None and me.get("y") is not None else None
        home_xy = _spot_xy(spots.get(home_id))
        # Where they should be standing comes from the clock, not from the last building they visited.
        # A leftover library coordinate was keeping people there hours before class.
        if phase == "walking":
            action = AgentAction.walk_to.value
            xy = home_xy or here
            reason = f"Leaving for {title} ({travel} min walk)."
        elif phase == "going_home":
            action = AgentAction.walk_to.value
            xy = _spot_xy(spots.get((trip["event"] or {}).get("building_id"))) or here
            reason = f"Heading home after {title}."
        else:
            action = AgentAction.idle.value
            xy = end or home_xy
            reason = f"At {title}." if phase == "there" else "Home — nothing on the calendar right now."
        if (
            action == AgentAction.walk_to.value
            and me.get("action") == AgentAction.walk_to.value
            and old_id == dest
            and old.get("travel_minutes")
            and _near(here, xy)
        ):
            continue
        if action == AgentAction.idle.value and me.get("action") == AgentAction.idle.value and old_id == dest and _near(here, xy):
            continue
        spot = spots.get(dest) or {}
        target = {"building_id": dest}
        if action == AgentAction.walk_to.value:
            target["travel_minutes"] = travel
            depart = (trip or {}).get("depart_at")
            if depart is not None:
                target["depart_at"] = depart.isoformat() if hasattr(depart, "isoformat") else depart
        if spot.get("x") is not None:
            target["x"], target["y"] = spot["x"], spot["y"]
        if spot.get("door"):
            target["door"] = spot["door"]
        target = {k: v for k, v in target.items() if v is not None}
        change = {
            "action": action,
            "target": target or None,
            "next_decision_at": iso_in(travel + 2) if action == AgentAction.walk_to.value else now_iso(),
            "updated_at": now_iso(),
        }
        if xy is not None:
            change["x"], change["y"] = xy
        db.table("agents").update({**change, "written_by": writer("calendar")}).eq("town_id", town_id).eq("user_id", uid).execute()
        # Logged like any other move, so the building card's "earlier today" includes calendar trips
        db.table("agent_actions").insert({"town_id": town_id, "user_id": uid, "action": action, "written_by": writer("calendar"),
                                          "details": {"by": "calendar", "target_building_id": dest, "reasoning": reason}}).execute()
        moved.append({"user_id": uid, "action": action, "target": target, "reason": reason})
    return moved
