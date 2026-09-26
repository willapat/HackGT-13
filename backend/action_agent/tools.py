# Calendar/places "tools" for the action agent.
# STUBS for the hackathon demo — no real Google Calendar / Maps calls.
# Swap the bodies for real integrations later; keep the function names.

from datetime import datetime, timedelta, timezone


def find_time_slots(participant_user_ids: list[str], count: int = 3) -> list[dict]:
    """Pretend-calendar: next Saturday/Sunday afternoon slots. Not a real calendar."""
    now = datetime.now(timezone.utc)
    days_until_sat = (5 - now.weekday()) % 7
    saturday = (now + timedelta(days=days_until_sat or 7)).replace(hour=14, minute=0, second=0, microsecond=0)
    sunday = saturday + timedelta(days=1)
    slots = [
        {"start": saturday.isoformat(), "label": "Saturday 2:00pm"},
        {"start": (saturday + timedelta(hours=4)).isoformat(), "label": "Saturday 6:00pm"},
        {"start": sunday.isoformat(), "label": "Sunday 2:00pm"},
    ]
    _ = participant_user_ids
    return slots[:count]


def suggest_place(building_id: str | None, title: str) -> dict:
    """Pretend-places: map known building ids to a venue name. Not a real Places API."""
    names = {
        "gym": "Boulder Gym",
        "cafe": "Bean There Café",
        "park": "Central Park",
        "library": "Library",
        "market": "Market",
        "downtown": "downtown",
    }
    return {"building_id": building_id, "name": names.get(building_id or "", title), "stub": True}
