"""Calendars are `signals` rows: source 'calendar', type 'calendar_event'.

value: {title, kind, start, end, building_id, place?, with?: [user_id], visibility?}
start/end are ISO timestamps with an offset. `kind` is one of KINDS.
"""

import time
from datetime import datetime, timedelta, timezone

from backend.config import settings
from backend.db import parse_ts

# Only used to fill an empty town_clock row the first time, so the label does not jump.
# After that row exists, restarts and Live both read it. Process uptime is not added again.
_process_started = datetime.now(timezone.utc)
FAST_RATE = (24 * 3600) / 120  # one game day per two real minutes
PLAY_RATE = 60.0  # one game minute per real second
_CACHE_SECONDS = 1.0
_clock_cache: dict | None = None
_clock_cached_at = 0.0

CALENDAR_SOURCE = "calendar"
CALENDAR_TYPE = "calendar_event"
KINDS = {"class", "work", "social", "activity", "appointment"}
# The demo runs in Atlanta. September is EDT; switch to zoneinfo if the demo ever crosses a DST change.
TOWN_TZ = timezone(timedelta(hours=-4), "ET")


def project_town_time(
    anchor_at: datetime, anchored_real_at: datetime, rate: float, real_now: datetime
) -> datetime:
    """Town time at real_now. rate is game-seconds per real second: 0 scrub, 1 live, FAST_RATE fast."""
    anchor = anchor_at.astimezone(TOWN_TZ) if anchor_at.tzinfo else anchor_at.replace(tzinfo=TOWN_TZ)
    start = anchored_real_at.astimezone(timezone.utc)
    real_now = real_now.astimezone(timezone.utc)
    return anchor + timedelta(seconds=(real_now - start).total_seconds() * float(rate))


def mode_for_rate(rate: float) -> str:
    if rate >= FAST_RATE:
        return "fast"
    if rate > 1:
        return "play"
    if rate == 0:
        return "scrub"
    return "live"


def _at_hour(shown: datetime, hour: float) -> datetime:
    hour = max(0.0, min(23.999, float(hour)))
    h = int(hour)
    m = int((hour - h) * 60)
    s = int(((hour - h) * 60 - m) * 60)
    return shown.replace(hour=h, minute=m, second=s, microsecond=0)


def clock_update(
    shown: datetime, *, hour: float | None, live: bool, fast: bool, play: bool = False
) -> tuple[datetime, float]:
    """The next anchor and rate. Live, Fast, and Play keep `shown`; they do not load a startup formula."""
    anchor = _at_hour(shown, hour) if hour is not None else shown
    if fast:
        rate = FAST_RATE
    elif play:
        rate = PLAY_RATE
    elif hour is not None and not live:
        rate = 0.0
    else:
        rate = 1.0
    return anchor, rate


def _bootstrap_anchor() -> datetime:
    if settings.TOWN_CLOCK:
        start = parse_ts(settings.TOWN_CLOCK).astimezone(TOWN_TZ)
        return start + (datetime.now(timezone.utc) - _process_started)
    return datetime.now(TOWN_TZ)


def _remember(row: dict) -> dict:
    global _clock_cache, _clock_cached_at
    _clock_cache = row
    _clock_cached_at = time.monotonic()
    return row


def _load_clock_row() -> dict:
    global _clock_cache, _clock_cached_at
    if _clock_cache is not None and time.monotonic() - _clock_cached_at < _CACHE_SECONDS:
        return _clock_cache
    from backend.db import get_client, now_iso

    db = get_client()
    town_id = settings.DEMO_TOWN_ID
    rows = db.table("town_clock").select("*").eq("town_id", town_id).limit(1).execute().data or []
    if rows:
        return _remember(rows[0])
    real = datetime.now(timezone.utc)
    anchor = _bootstrap_anchor()
    row = {
        "town_id": town_id,
        "mode": "live",
        "anchor_at": anchor.isoformat(),
        "anchored_real_at": real.isoformat(),
        "rate": 1,
        "updated_at": now_iso(),
    }
    try:
        db.table("town_clock").upsert(row, on_conflict="town_id").execute()
    except Exception as exc:  # DEMO_TOWN_ID names a town that no longer exists: run on this clock, unsaved
        print(f"[clock] can't save town_clock for DEMO_TOWN_ID {town_id}: {exc}", flush=True)
    return _remember(row)


def _row_time(row: dict, real_now: datetime | None = None) -> datetime:
    return project_town_time(
        parse_ts(row["anchor_at"]),
        parse_ts(row["anchored_real_at"]),
        float(row["rate"]),
        real_now or datetime.now(timezone.utc),
    )


def local_now() -> datetime:
    """Town-local time from the town_clock row the app last set."""
    if not settings.DEMO_TOWN_ID:
        return datetime.now(TOWN_TZ)
    return _row_time(_load_clock_row())


def clock_rate() -> float:
    if not settings.DEMO_TOWN_ID:
        return 1.0
    return float(_load_clock_row()["rate"])


def clock_mode() -> str:
    if not settings.DEMO_TOWN_ID:
        return "live"
    return mode_for_rate(clock_rate())


def set_town_clock(
    *, hour: float | None = None, live: bool = False, fast: bool = False, play: bool = False
) -> datetime:
    """Slider, Live, Fast day, and Play. Each anchors at the hour already on screen."""
    from backend.db import get_client, now_iso

    shown = local_now()
    anchor, rate = clock_update(shown, hour=hour, live=live, fast=fast, play=play)
    real = datetime.now(timezone.utc)
    if not settings.DEMO_TOWN_ID:
        return project_town_time(anchor, real, rate, real)
    row = {
        "town_id": settings.DEMO_TOWN_ID,
        "mode": mode_for_rate(rate),
        "anchor_at": anchor.isoformat(),
        "anchored_real_at": real.isoformat(),
        "rate": rate,
        "updated_at": now_iso(),
    }
    get_client().table("town_clock").upsert(row, on_conflict="town_id").execute()
    _remember(row)
    return project_town_time(anchor, real, rate, datetime.now(timezone.utc))


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
    from backend.calendar_drive import destination_for

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
                "building_id": destination_for(r, uid),
                "place": r.get("text"),
                "travel_minutes": r.get("travel_minutes"),
                "with": [o for o in going if o != uid],
            })
    out.sort(key=lambda ev: (ev["start"], ev["user_id"]))
    return out
