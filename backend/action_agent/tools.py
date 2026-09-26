# Calendar/places "tools" for the action agent.
# Calendar: participants' shared calendar signals (backend/schedules.py). Places: still a keyword stub.

from datetime import timedelta

from backend.db import get_client
from backend.schedules import busy_blocks, free_slots, local_now, user_tz

SEARCH_DAYS = 3


def find_time_slots(participant_user_ids: list[str], count: int = 3) -> list[dict]:
    """Two-hour windows in the next few days when no participant's shared calendar is busy."""
    now = local_now()
    db = get_client()
    busy = busy_blocks(db, participant_user_ids, now, now + timedelta(days=SEARCH_DAYS))
    # Daytime hours in the first participant's time zone (the person the plan is being made for)
    tz = user_tz(db, participant_user_ids[0] if participant_user_ids else None)
    return free_slots(busy, now, days=SEARCH_DAYS, count=count, tz=tz)


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
