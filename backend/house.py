"""What a person puts on their own spot in a town: a bubble over their character and a mood on their house.
Both are written by the person, expire on their own, and are never read by the town brain. A bubble is a quick
chat line (one minute); a mood lasts like a free/busy status."""

from datetime import datetime, timedelta, timezone

from backend.db import parse_ts

# House moods: the 3D town draws each one over the house (town/js/effects.js HOUSE_MOODS). Keep the two lists in step.
MOODS = ("party", "sunny", "rainy", "stormy", "love", "sleepy", "music", "cozy", "proud", "busy", "chill", "studying")
MOOD_HOURS = 3  # like a free/busy status (frontend/app/app.js STATUS_HOURS)
BUBBLE_HOURS = 1 / 60  # one minute
BUBBLE_MAX = 60


def clean_text(text: str | None) -> str:
    """One line: newlines and runs of spaces collapse to single spaces."""
    return " ".join((text or "").split())


def entry(key: str, value: str, hours: float, now: datetime | None = None) -> dict:
    now = now or datetime.now(timezone.utc)
    return {key: value, "set_at": now.isoformat(), "until": (now + timedelta(hours=hours)).isoformat()}


def active(item: dict | None, now: datetime | None = None) -> dict | None:
    """The bubble/mood if it hasn't run out, else None."""
    if not item or not item.get("until"):
        return None
    try:
        until = parse_ts(item["until"])
    except (TypeError, ValueError):
        return None
    return item if until > (now or datetime.now(timezone.utc)) else None
