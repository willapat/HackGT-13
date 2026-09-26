from datetime import timedelta

from backend.calendar_drive import current_trip, destination_for, estimate_travel_minutes
from backend.schedules import TOWN_TZ

NOW = __import__("datetime").datetime(2026, 9, 26, 10, 0, tzinfo=TOWN_TZ)


def ev(**kw):
    base = {
        "id": "e1",
        "title": "Shift at Bean There Café",
        "start_at": (NOW.replace(hour=10)).isoformat(),
        "end_at": (NOW.replace(hour=14)).isoformat(),
        "building_id": "cafe",
        "text": None,
        "travel_minutes": 8,
    }
    base.update(kw)
    return base


def test_travel_minutes_by_place():
    assert estimate_travel_minutes("cafe") == 8
    assert estimate_travel_minutes(None, "campus") == 18
    assert estimate_travel_minutes(None, "home") == 6


def test_campus_maps_to_library():
    assert destination_for({"building_id": None, "text": "campus"}, "u1") == "library"
    assert destination_for({"building_id": None, "text": "home"}, "u1") == "house:u1"
    assert destination_for({"building_id": "gym"}, "u1") == "gym"


def test_leave_early_enough_to_arrive():
    row = ev()
    walking = current_trip([row], "u1", NOW.replace(hour=9, minute=55))
    assert walking["phase"] == "walking" and walking["building_id"] == "cafe"
    assert walking["travel_minutes"] == 8
    too_early = current_trip([row], "u1", NOW.replace(hour=9, minute=50))
    assert too_early is None


def test_stay_at_the_place_during_the_event():
    there = current_trip([ev()], "u1", NOW.replace(hour=11))
    assert there["phase"] == "there" and there["action"] == "idle"


def test_done_after_end():
    assert current_trip([ev()], "u1", NOW.replace(hour=14, minute=1)) is None


def test_default_travel_when_column_missing():
    row = ev()
    del row["travel_minutes"]
    trip = current_trip([row], "u1", NOW.replace(hour=9, minute=53))
    assert trip["travel_minutes"] == 8
    assert trip["leave_at"] == NOW.replace(hour=10) - timedelta(minutes=8)
