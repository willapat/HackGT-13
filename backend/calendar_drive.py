"""Characters follow their own calendar: leave early enough to arrive, stay until it ends.

This is not an LLM decision. The times and places are what the person shared.
"""

from datetime import datetime, timedelta

from backend.db import iso_in, now_iso, parse_ts
from backend.writer import stamp
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
    travel: int | None = None, depart_at: datetime | None = None, from_building: str | None = None,
) -> dict:
    ev = block["event"]
    return {
        "event": ev,
        "phase": phase,
        "building_id": building_id,
        "from_building": from_building or building_id,
        "travel_minutes": block["travel"] if travel is None else travel,
        "leave_at": block["leave"],
        "depart_at": depart_at or block["leave"],
        "start_at": block["start"],
        "end_at": block["end"],
        "action": action,
        "until": until,
    }


def _stand(blocks: list[dict], user_id: str, at: datetime) -> str:
    """The door they are at. Mid-walk counts as the door they have not left yet."""
    home = house_building_id(user_id)
    active = [b for b in blocks if b["start"] <= at < b["end"]]
    if active:
        return active[-1]["dest"]
    finished = [b for b in blocks if b["end"] <= at]
    if not finished:
        return home
    last = finished[-1]
    travel = last["travel"] if last["dest"] != home else 0
    if last["dest"] != home and at < last["end"] + timedelta(minutes=travel):
        return last["dest"]
    return home


def current_trip(events: list[dict], user_id: str, now: datetime) -> dict | None:
    """Walk to the current event, stay until it ends, then walk home and wait there.

    A later event wins when its leave time has arrived, so they head out travel_minutes
    before it starts instead of staying through the earlier one.
    """
    home = house_building_id(user_id)
    blocks = _blocks(events, user_id)
    active = [b for b in blocks if b["leave"] <= now < b["end"]]
    if active:
        b = active[-1]
        if now < b["start"]:
            origin = _stand(blocks, user_id, b["leave"] - timedelta(seconds=1))
            return _trip(
                b, "walking", b["dest"], AgentAction.walk_to.value, b["start"],
                depart_at=b["leave"], from_building=origin,
            )
        return _trip(b, "there", b["dest"], AgentAction.idle.value, b["end"], from_building=b["dest"])

    finished = [b for b in blocks if b["end"] <= now]
    if not finished:
        return None
    last = finished[-1]
    next_leave = next((b["leave"] for b in blocks if b["leave"] > now), None)
    arrive_home = last["end"] + timedelta(minutes=last["travel"] if last["dest"] != home else 0)
    if last["dest"] != home and now < arrive_home and (next_leave is None or now < next_leave):
        until = arrive_home if next_leave is None else min(arrive_home, next_leave)
        return _trip(
            last, "going_home", home, AgentAction.walk_to.value, until,
            depart_at=last["end"], from_building=last["dest"],
        )
    return _trip(
        last, "home", home, AgentAction.idle.value,
        next_leave or now + timedelta(minutes=20), travel=0, from_building=home,
    )


def next_check_iso(until: datetime, now: datetime, rate: float | None = None) -> str:
    """Next look, in real time. `until` and `now` are town time.

    Live can wait up to 20 real seconds. Play and Fast cannot: 20 real seconds is 20 game
    minutes at one-minute-per-second, which skips the whole walk and the next write drops
    them on the door.
    """
    seconds = (until - now).total_seconds()
    if rate is None:
        from backend.schedules import clock_rate
        rate = clock_rate()
    rate = max(float(rate or 1), 1.0)
    if rate <= 1:
        return iso_in(max(5.0, min(20.0, seconds)))
    real = seconds / rate
    return iso_in(max(1.0, min(real, 30.0 / rate)))


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


def _same_instant(stored, depart) -> bool:
    """True when the row's depart_at is the same moment the clock snap would write."""
    if depart is None:
        return not stored
    want = depart.isoformat() if hasattr(depart, "isoformat") else str(depart)
    if not stored:
        return False
    try:
        return parse_ts(stored) == parse_ts(want)
    except (TypeError, ValueError):
        return stored == want


def plan_clock_placement(
    trip: dict | None, user_id: str, spots: dict, agent_row: dict, clock_at: datetime | None = None
) -> dict | None:
    """The only shape a clock placement may write.

    Idle means they are already at the door, so x/y is that door and target is that building.
    A walk stores the curb they leave from in x/y and the destination on target, with depart_at.
    Returns None when the row already matches, so a repeat does not bump updated_at.
    """
    home_id = house_building_id(user_id)
    dest = trip["building_id"] if trip else home_id
    phase = trip["phase"] if trip else "home"
    title = (trip["event"].get("title") if trip else None) or "home"
    travel = int(trip["travel_minutes"]) if trip and trip.get("travel_minutes") else estimate_travel_minutes(dest)
    old = agent_row.get("target") or {}
    here = (float(agent_row["x"]), float(agent_row["y"])) if agent_row.get("x") is not None and agent_row.get("y") is not None else None
    end = _spot_xy(spots.get(dest))
    home_xy = _spot_xy(spots.get(home_id))
    depart = None
    if phase == "walking":
        action = AgentAction.walk_to.value
        origin = (trip or {}).get("from_building") or home_id
        xy = _spot_xy(spots.get(origin)) or home_xy or here
        depart = (trip or {}).get("depart_at")
        reason = f"Leaving for {title} ({travel} min walk)."
    elif phase == "going_home":
        action = AgentAction.walk_to.value
        origin = (trip or {}).get("from_building") or (trip["event"] or {}).get("building_id")
        xy = _spot_xy(spots.get(origin)) or here
        depart = (trip or {}).get("depart_at")
        reason = f"Heading home after {title}."
    else:
        action = AgentAction.idle.value
        xy = end or home_xy
        reason = f"At {title}." if phase == "there" else "Home — nothing on the calendar right now."
    same_place = old.get("building_id") == dest and _near(here, xy)
    if action == AgentAction.walk_to.value and agent_row.get("action") == action and same_place and old.get("travel_minutes") and _same_instant(old.get("depart_at"), depart):
        return None
    if (
        action == AgentAction.idle.value and (agent_row.get("action") or action) == action and same_place
        and not old.get("depart_at")
    ):
        return None
    spot = spots.get(dest) or {}
    target = {"building_id": dest}
    if action == AgentAction.walk_to.value:
        target["travel_minutes"] = travel
        if depart is not None:
            target["depart_at"] = depart.isoformat() if hasattr(depart, "isoformat") else depart
    if spot.get("x") is not None:
        target["x"], target["y"] = spot["x"], spot["y"]
    if spot.get("door"):
        target["door"] = spot["door"]
    # Postgres re-plans at this instant and rejects the row if the calendar disagrees.
    if clock_at is not None:
        target["clock_at"] = clock_at.isoformat()
    target = {k: v for k, v in target.items() if v is not None}
    change = {
        "action": action,
        "target": target or None,
        "next_decision_at": iso_in(travel + 2) if action == AgentAction.walk_to.value else now_iso(),
        "updated_at": now_iso(),
        "reason": reason,
    }
    if xy is not None:
        change["x"], change["y"] = xy
    return change


def _personal_events(db, town_id: str) -> list[dict]:
    return (
        db.table("events")
        .select("id, title, kind, start_at, end_at, building_id, text, travel_minutes, event_participants(user_id)")
        .eq("town_id", town_id).eq("type", "personal")
        .execute().data or []
    )


def _mine(events: list[dict], user_id: str) -> list[dict]:
    return [e for e in events if user_id in {p["user_id"] for p in (e.get("event_participants") or [])}]


def _snap_context(db, town_id: str) -> dict:
    members = (
        db.table("town_members").select("user_id, house_x, house_y, home").eq("town_id", town_id).execute().data or []
    )
    town = (db.table("towns").select("tiles, map").eq("id", town_id).limit(1).execute().data or [{}])[0]
    return {
        "members": members,
        "spots": {b["id"]: b for b in buildings(town.get("map"), members)},
        "events": _personal_events(db, town_id),
        "agents": {a["user_id"]: a for a in db.table("agents").select("*").eq("town_id", town_id).execute().data or []},
    }


def _apply_placement(db, town_id: str, user_id: str, change: dict) -> dict | None:
    reason = change.pop("reason")
    try:
        db.table("agents").update(stamp(change)).eq("town_id", town_id).eq("user_id", user_id).execute()
    except Exception as exc:
        # The slider moved between planning and writing. The next pass plans for the new hour.
        if "placement rejected" not in str(exc):
            raise
        print(f"[calendar] {user_id}: {exc}", flush=True)
        return None
    return {"user_id": user_id, "action": change["action"], "target": change["target"], "reason": reason}


def snap_member_to_clock(db, town_id: str, user_id: str, now: datetime, ctx: dict | None = None) -> dict | None:
    """Place one person with plan_clock_placement. This is the only calendar position writer."""
    ctx = ctx or _snap_context(db, town_id)
    trip = current_trip(_mine(ctx["events"], user_id), user_id, now)
    change = plan_clock_placement(trip, user_id, ctx["spots"], ctx["agents"].get(user_id) or {}, clock_at=now)
    if change is None:
        return None
    placed = _apply_placement(db, town_id, user_id, change)
    if placed is None:
        return None
    ctx["agents"][user_id] = {**(ctx["agents"].get(user_id) or {}), **{k: v for k, v in change.items() if k != "reason"}}
    return placed


def snap_town_to_clock(db, town_id: str, now: datetime) -> list[dict]:
    """Start a walk to wherever the calendar says each person should be at `now`.

    agents.x/y is the curb they leave from. The client walks that to target over travel_minutes.
    People already standing on the right door stay put.
    """
    ctx = _snap_context(db, town_id)
    moved = []
    for m in ctx["members"]:
        placed = snap_member_to_clock(db, town_id, m["user_id"], now, ctx)
        if placed:
            moved.append(placed)
    return moved
