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
