"""Free / busy status: a low-pressure signal of whether you're up for plans. It always has an end time and
lapses on its own, so a stale "free" never lingers. Stored on `profiles.status` / `status_until`."""

from datetime import datetime, timedelta

STATUSES = ("free", "busy")
MAX_LENGTH = timedelta(hours=48)


def active_status(profile: dict | None, now: datetime) -> dict | None:
    """{"status", "until"} while it's still running, else None. Tolerates profiles from before the columns existed."""
    status, until = (profile or {}).get("status"), (profile or {}).get("status_until")
    if status not in STATUSES or not until:
        return None
    if datetime.fromisoformat(until.replace("Z", "+00:00")) <= now:
        return None
    return {"status": status, "until": until}


def calendar_busy(db, user_ids: list[str], now: datetime) -> dict[str, dict]:
    """Who is in the middle of a calendar block right now (a synced Google busy time, or a class/shift they
    shared): {user_id: {"since", "until"}}. Only times, never what the block is."""
    if not user_ids:
        return {}
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    rows = (db.table("event_participants").select("user_id, events!inner(start_at, end_at, type, status)")
            .in_("user_id", list(user_ids)).eq("status", "accepted")
            .eq("events.type", "personal").neq("events.status", "cancelled")
            .lte("events.start_at", stamp).gt("events.end_at", stamp).execute().data or [])
    out: dict[str, dict] = {}
    for r in rows:
        ev = r["events"]
        cur = out.get(r["user_id"])
        if not cur or ev["end_at"] > cur["until"]:  # overlapping blocks: busy until the last one ends
            out[r["user_id"]] = {"since": ev["start_at"], "until": ev["end_at"]}
    return out


def effective_status(profile: dict | None, now: datetime, busy: dict | None = None) -> dict | None:
    """What friends see: a status you set yourself wins; otherwise your calendar makes you busy while a block runs."""
    manual = active_status(profile, now)
    if manual:
        return manual
    if busy:
        return {"status": "busy", "until": busy["until"], "since": busy["since"], "source": "calendar"}
    return None
