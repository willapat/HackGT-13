"""Your week on the profile: the events you added, plus Google Calendar copies.

A synced event is stored once per town (each character needs its own building). The week view
collapses those copies into one row. Adding writes one row per town you belong to, aimed at
the place you picked when that town has it. Google rows are replaced on every sync, so they
are shown and not deleted here.
"""

from datetime import datetime, timedelta

from backend.calendar_drive import estimate_travel_minutes
from backend.db import parse_ts
from backend.models.enums import EventStatus, EventType, ParticipantStatus
from backend.town_map import house_building_id

PLACES = (
    ("home", "Home"),
    ("university", "University"),
    ("library", "Library"),
    ("gym", "Gym"),
    ("cafe", "Café"),
    ("market", "Market"),
    ("park", "Park"),
    ("downtown", "Downtown"),
)
PLACE_LABELS = dict(PLACES)
KINDS = ("class", "work", "social", "activity", "appointment")
KIND_LABELS = {
    "class": "Class", "work": "Work", "social": "Social",
    "activity": "Activity", "appointment": "Appointment",
}
# A town without the place you picked: the next id it does have, then home.
FALLBACKS = {
    "university": ("library", "downtown"),
    "library": ("university", "downtown"),
    "gym": ("park", "downtown"),
    "cafe": ("market", "downtown"),
    "market": ("cafe", "downtown"),
    "park": ("downtown",),
    "downtown": ("park", "cafe"),
}
HORIZON_PAST = timedelta(weeks=8)
HORIZON_FUTURE = timedelta(weeks=16)


class ScheduleError(Exception):
    def __init__(self, status: int, detail: str):
        self.status, self.detail = status, detail


def week_offset(moment: datetime, now: datetime) -> int:
    """How many weeks `moment`'s Monday is from `now`'s Monday."""
    start, _ = week_window(moment, 0)
    current, _ = week_window(now, 0)
    return round((start - current).total_seconds() / (7 * 24 * 3600))


def week_window(now: datetime, offset: int) -> tuple[datetime, datetime]:
    """Monday 00:00 of this week (plus `offset` weeks) and the Monday after, in `now`'s zone."""
    start = (now - timedelta(days=now.weekday())).replace(hour=0, minute=0, second=0, microsecond=0)
    start += timedelta(weeks=offset)
    return start, start + timedelta(days=7)


def parse_slot(date: str, start: str, end: str, tz) -> tuple[datetime, datetime]:
    """A same-day start and end in the person's zone. Raises ScheduleError when it isn't a real span."""
    try:
        y, m, d = (int(x) for x in date.split("-"))
        sh, sm = (int(x) for x in start.split(":"))
        eh, em = (int(x) for x in end.split(":"))
        began = datetime(y, m, d, sh, sm, tzinfo=tz)
        ended = datetime(y, m, d, eh, em, tzinfo=tz)
    except (TypeError, ValueError):
        raise ScheduleError(422, "Use a date like 2026-09-28 and times like 14:00.")
    if ended <= began:
        raise ScheduleError(422, "The end has to be after the start.")
    if ended - began > timedelta(hours=18):
        raise ScheduleError(422, "Keep it under 18 hours.")
    return began, ended


def check_horizon(start: datetime, now: datetime) -> None:
    if start < now - HORIZON_PAST or start > now + HORIZON_FUTURE:
        raise ScheduleError(422, "Pick a day from the past couple of months through the next few.")


def place_for_town(places: list[dict], choice: str, home: str) -> str:
    """A building id that town actually has. Missing places fall through to home."""
    have = {p["id"] for p in places if p.get("id")}
    if choice != "home" and choice in have:
        return choice
    for alt in FALLBACKS.get(choice, ()):
        if alt in have:
            return alt
    return home


def _others(event: dict, uid: str) -> bool:
    return any(
        p.get("user_id") != uid and p.get("status") != "declined"
        for p in (event.get("event_participants") or [])
    )


def group_week(events: list[dict], week_start: datetime, uid: str) -> list[dict]:
    """Seven days. Copies that share a start, end and title (one per town) are one row."""
    tz = week_start.tzinfo
    days = []
    for i in range(7):
        day = week_start + timedelta(days=i)
        days.append({"date": day.date().isoformat(), "weekday": day.strftime("%A"), "items": []})
    grouped: dict[tuple, dict] = {}
    order: list[tuple] = []
    for ev in events:
        try:
            began, ended = parse_ts(ev["start_at"]), parse_ts(ev["end_at"])
        except (KeyError, TypeError, ValueError):
            continue
        if ev.get("status") == EventStatus.cancelled.value:
            continue
        index = (began.astimezone(tz).date() - week_start.date()).days
        if not 0 <= index <= 6:
            continue
        key = (began.isoformat(), ended.isoformat(), (ev.get("title") or "").strip())
        slot = grouped.get(key)
        if slot is None:
            slot = {
                "id": ev["id"], "title": (ev.get("title") or "Busy").strip() or "Busy",
                "kind": ev.get("kind") or "activity",
                "start": began.isoformat(), "end": ended.isoformat(),
                "place": (ev.get("text") or "").strip() or None,
                "source": "you", "removable": True, "_day": index,
            }
            grouped[key] = slot
            order.append(key)
        if ev.get("imported_from"):
            slot["source"] = "google"
            slot["removable"] = False
        if _others(ev, uid):
            slot["removable"] = False
    for key in order:
        slot = grouped[key]
        days[slot.pop("_day")]["items"].append({k: v for k, v in slot.items()})
    for day in days:
        day["items"].sort(key=lambda item: item["start"])
    return days


def plan_remove(target: dict, copies: list[dict], uid: str) -> list[str]:
    """Every town copy of an event you added. Google rows and shared plans stay."""
    if target.get("imported_from"):
        raise ScheduleError(409, "This one comes from Google Calendar. Take it off there and it leaves here on the next sync.")
    ids = []
    seen = set()
    for ev in [target, *copies]:
        if ev.get("imported_from") or ev["id"] in seen:
            continue
        if (ev.get("title") or "").strip() != (target.get("title") or "").strip():
            continue
        if ev.get("start_at") != target.get("start_at") or ev.get("end_at") != target.get("end_at"):
            continue
        if _others(ev, uid):
            raise ScheduleError(409, "Someone else is on this one, so it stays.")
        seen.add(ev["id"])
        ids.append(ev["id"])
    return ids


def _view(days: list[dict], start: datetime, offset: int) -> dict:
    sunday = start + timedelta(days=6)
    return {
        "offset": offset,
        "week_start": start.date().isoformat(),
        "week_end": sunday.date().isoformat(),
        "days": days,
        "places": [{"id": pid, "label": label} for pid, label in PLACES],
        "kinds": [{"id": kind, "label": KIND_LABELS[kind]} for kind in KINDS],
    }


def _flatten(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        if row.get("status") == "declined":
            continue
        ev = row.get("events")
        if isinstance(ev, dict) and ev.get("type") in (None, EventType.personal.value):
            out.append(ev)
    return out


def week_for(db, uid: str, offset: int) -> dict:
    from backend.schedules import user_tz

    tz = user_tz(db, uid)
    start, end = week_window(datetime.now(tz), offset)
    rows = (
        db.table("event_participants")
        .select("status, events!inner(id, town_id, title, kind, text, start_at, end_at, building_id, imported_from, type, status, event_participants(user_id, status))")
        .eq("user_id", uid).eq("events.type", "personal")
        .lt("events.start_at", end.isoformat()).gt("events.end_at", start.isoformat())
        .limit(500).execute().data or []
    )
    return _view(group_week(_flatten(rows), start, uid), start, offset)


def _places(town_row: dict) -> list[dict]:
    places = ((town_row.get("towns") or {}).get("map") or {}).get("places") or {}
    return [{"id": pid, "name": (p or {}).get("name")} for pid, p in places.items()]


def _snap(db, uid: str, town_ids: list[str]) -> None:
    from backend.calendar_drive import snap_member_to_clock
    from backend.schedules import local_now

    now = local_now()
    for tid in town_ids:
        try:
            snap_member_to_clock(db, tid, uid, now)
        except Exception as exc:  # the calendar loop places them on its next pass
            print(f"[schedule] snap {tid}: {exc!r}", flush=True)


def add_event(db, uid: str, body, tz, now: datetime) -> dict:
    began, ended = parse_slot(body.date, body.start, body.end, tz)
    check_horizon(began, now)
    towns = db.table("town_members").select("town_id, towns(map)").eq("user_id", uid).execute().data or []
    if not towns:
        raise ScheduleError(422, "Join a town first. Your schedule is where your character goes.")
    home = house_building_id(uid)
    label = PLACE_LABELS[body.place]
    rows = []
    for town in towns:
        building = place_for_town(_places(town), body.place, home)
        rows.append({
            "town_id": town["town_id"], "type": EventType.personal.value,
            "title": body.title, "text": label, "kind": body.kind,
            "start_at": began.isoformat(), "end_at": ended.isoformat(),
            "building_id": building, "travel_minutes": estimate_travel_minutes(building),
            "status": EventStatus.active.value,
        })
    created = db.table("events").insert(rows).execute().data or []
    try:
        db.table("event_participants").insert([
            {"event_id": ev["id"], "user_id": uid, "status": ParticipantStatus.accepted.value} for ev in created
        ]).execute()
    except Exception:
        if created:
            db.table("events").delete().in_("id", [ev["id"] for ev in created]).execute()
        raise
    _snap(db, uid, [t["town_id"] for t in towns])
    return began


def remove_event(db, uid: str, event_id: str) -> None:
    rows = (
        db.table("event_participants")
        .select("status, events!inner(id, town_id, title, start_at, end_at, imported_from, type, event_participants(user_id, status))")
        .eq("user_id", uid).eq("events.id", event_id).limit(1).execute().data or []
    )
    target = rows[0]["events"] if rows and isinstance(rows[0].get("events"), dict) else None
    if target is None or rows[0].get("status") == "declined":
        raise ScheduleError(404, "That event isn't on your schedule.")
    copies = (
        db.table("event_participants")
        .select("events!inner(id, town_id, title, start_at, end_at, imported_from, event_participants(user_id, status))")
        .eq("user_id", uid).eq("events.type", "personal")
        .eq("events.start_at", target["start_at"]).eq("events.end_at", target["end_at"])
        .eq("events.title", target["title"]).execute().data or []
    )
    ids = plan_remove(target, _flatten(copies), uid)
    towns = list({ev["town_id"] for ev in [target, *_flatten(copies)] if ev.get("town_id")})
    db.table("events").delete().in_("id", ids).execute()
    _snap(db, uid, towns)
