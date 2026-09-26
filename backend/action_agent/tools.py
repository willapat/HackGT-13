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


PLACES = {
    "gym": "Boulder Gym",
    "cafe": "Bean There Café",
    "park": "Central Park",
    "library": "Library",
    "market": "Market",
    "downtown": "downtown",
}
KEYWORDS = {"climb": "gym", "coffee": "cafe", "café": "cafe", "book": "library", "picnic": "park", "run": "park"}


def suggest_place(text: str) -> dict:
    """Pretend-places: pick a known building mentioned in the quest text. Not a real Places API."""
    lowered = text.lower()
    building_id = next((b for b in PLACES if b in lowered), None) or next(
        (b for k, b in KEYWORDS.items() if k in lowered), None
    )
    return {"building_id": building_id, "name": PLACES.get(building_id, "somewhere you both like"), "stub": True}
