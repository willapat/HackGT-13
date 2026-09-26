"""Calendars are `signals` rows: source 'calendar', type 'calendar_event'.

value: {title, kind, start, end, building_id?, place?, with?: [user_id], visibility?}
start/end are ISO timestamps with an offset. `kind` is one of KINDS.
"""

from datetime import datetime, timedelta, timezone

from backend.config import settings
from backend.db import parse_ts

_wall_boot = datetime.now(timezone.utc)
# Runtime clock the 3D slider can drive. None = fall back to TOWN_CLOCK / wall time.
_override_base: datetime | None = None
_override_wall: datetime | None = None
_override_rate = 1.0  # 1 = real time; 0 = frozen; 720 = a full day in two minutes
FAST_RATE = (24 * 3600) / 120

CALENDAR_SOURCE = "calendar"
CALENDAR_TYPE = "calendar_event"
KINDS = {"class", "work", "social", "activity", "appointment"}
# The demo runs in Atlanta. September is EDT; switch to zoneinfo if the demo ever crosses a DST change.
TOWN_TZ = timezone(timedelta(hours=-4), "ET")


def _env_now() -> datetime:
    if settings.TOWN_CLOCK:
        start = parse_ts(settings.TOWN_CLOCK).astimezone(TOWN_TZ)
        return start + (datetime.now(timezone.utc) - _wall_boot)
    return datetime.now(TOWN_TZ)


def local_now() -> datetime:
    """Town-local time. Slider / Fast day set an override; otherwise TOWN_CLOCK or the wall clock."""
    if _override_base is not None and _override_wall is not None:
        elapsed = (datetime.now(timezone.utc) - _override_wall).total_seconds() * _override_rate
        return _override_base + timedelta(seconds=elapsed)
    return _env_now()


def clock_mode() -> str:
    if _override_base is None:
        return "live"
    if _override_rate > 1:
        return "fast"
    if _override_rate == 0:
        return "scrub"
    return "live"


def set_town_clock(*, hour: float | None = None, live: bool = False, fast: bool = False) -> datetime:
    """Sync town time with the 3D sky controls. `hour` is 0–24 on the current town date."""
    global _override_base, _override_wall, _override_rate
    if live and hour is None:
        _override_base = None
        _override_wall = None
        _override_rate = 1.0
        return local_now()
    now = local_now()
    if hour is not None:
        hour = max(0.0, min(23.999, float(hour)))
        h = int(hour)
        m = int((hour - h) * 60)
        s = int(((hour - h) * 60 - m) * 60)
        now = now.replace(hour=h, minute=m, second=s, microsecond=0)
    _override_base = now
    _override_wall = datetime.now(timezone.utc)
    _override_rate = FAST_RATE if fast else (1.0 if live else 0.0)
    return local_now()


def busy_blocks(db, user_ids: list[str], start: datetime, end: datetime) -> dict[str, list[tuple[datetime, datetime]]]:
    """Per user, personal events overlapping [start, end)."""
    out: dict[str, list[tuple[datetime, datetime]]] = {uid: [] for uid in user_ids}
    for ev in events_for_users(db, user_ids, start, end):
        try:
            s, e = parse_ts(ev["start"]), parse_ts(ev["end"])
        except (KeyError, TypeError, ValueError):
            continue
        out[ev["user_id"]].append((s, e))
    return out


def free_slots(
    busy: dict[str, list[tuple[datetime, datetime]]],
    now: datetime,
    days: int = 3,
    duration: timedelta = timedelta(hours=2),
    day_start_hour: int = 9,
    day_end_hour: int = 22,
    count: int = 3,
) -> list[dict]:
    """First free window per day that nobody's calendar overlaps, then more from any day, up to `count`."""
    blocks = [b for bs in busy.values() for b in bs]
    first_day = now.astimezone(TOWN_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    per_day: list[list[datetime]] = []
    for d in range(days):
        day = first_day + timedelta(days=d)
        starts = []
        t = day.replace(hour=day_start_hour)
        while t + duration <= day.replace(hour=day_end_hour):
            if t > now and not any(s < t + duration and e > t for s, e in blocks):
                starts.append(t)
            t += timedelta(hours=1)
        per_day.append(starts)
    picked = [starts[0] for starts in per_day if starts][:count]
    for starts in per_day:
        for t in starts[1:]:
            if len(picked) >= count:
                break
            picked.append(t)
    return [{"start": t.isoformat(), "end": (t + duration).isoformat(), "label": label(t)} for t in sorted(picked)]


def label(t: datetime) -> str:
    t = t.astimezone(TOWN_TZ)
    hour = t.strftime("%I").lstrip("0")
    return f"{t.strftime('%a %b')} {t.day}, {hour}:{t.strftime('%M%p').lower()}"


def window_label(start: datetime, end: datetime) -> str:
    start, end = start.astimezone(TOWN_TZ), end.astimezone(TOWN_TZ)
    start_h = start.strftime("%I").lstrip("0")
    end_h = end.strftime("%I").lstrip("0")
    return (
        f"{start.strftime('%a %b')} {start.day}, "
        f"{start_h}:{start.strftime('%M%p').lower()}-{end_h}:{end.strftime('%M%p').lower()}"
    )


def events_for_users(db, user_ids: list[str], start: datetime, end: datetime) -> list[dict]:
    """Personal events overlapping [start, end). One row per participant, sorted by start."""
    if not user_ids:
        return []
    wanted = set(user_ids)
    rows = (
        db.table("events")
        .select("id, title, kind, start_at, end_at, building_id, text, travel_minutes, event_participants(user_id)")
        .eq("type", "personal")
        .execute()
        .data
        or []
    )
    out = []
    for r in rows:
        try:
            s, e = parse_ts(r["start_at"]), parse_ts(r["end_at"])
        except (KeyError, TypeError, ValueError):
            continue
        if s >= end or e <= start:
            continue
        going = [p["user_id"] for p in (r.get("event_participants") or []) if p.get("user_id")]
        for uid in going:
            if uid not in wanted:
                continue
            out.append({
                "id": r["id"],
                "user_id": uid,
                "title": r.get("title") or "Busy",
                "kind": r.get("kind"),
                "start": s.isoformat(),
                "end": e.isoformat(),
                "label": window_label(s, e),
                "building_id": r.get("building_id"),
                "place": r.get("text"),
                "travel_minutes": r.get("travel_minutes"),
                "with": [o for o in going if o != uid],
            })
    out.sort(key=lambda ev: (ev["start"], ev["user_id"]))
    return out
