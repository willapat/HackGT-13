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
    assert destination_for({"kind": "appointment"}, "u1") == "downtown"
    assert destination_for({"kind": "class"}, "u1") == "library"
    assert destination_for({}, "u1") == "downtown"


def test_leave_early_enough_to_arrive():
    row = ev()
    walking = current_trip([row], "u1", NOW.replace(hour=9, minute=55))
    assert walking["phase"] == "walking" and walking["building_id"] == "cafe"
    assert walking["travel_minutes"] == 8
    assert walking["depart_at"] == NOW.replace(hour=10) - timedelta(minutes=8)
    too_early = current_trip([row], "u1", NOW.replace(hour=9, minute=50))
    assert too_early is None


def test_stay_at_the_place_during_the_event():
    there = current_trip([ev()], "u1", NOW.replace(hour=11))
    assert there["phase"] == "there" and there["action"] == "idle"


def test_walk_home_after_event_ends():
    just_ended = current_trip([ev()], "u1", NOW.replace(hour=14, minute=1))
    assert just_ended["phase"] == "going_home"
    assert just_ended["building_id"] == "house:u1"
    assert just_ended["action"] == "walk_to"
    assert just_ended["depart_at"] == NOW.replace(hour=14)
    assert just_ended["travel_minutes"] == 8


def test_idle_at_home_after_the_walk_back():
    home = current_trip([ev()], "u1", NOW.replace(hour=14, minute=10))
    assert home["phase"] == "home"
    assert home["building_id"] == "house:u1"
    assert home["action"] == "idle"


def test_next_event_beats_walking_home():
    cafe = ev()
    gym = ev(
        id="e2",
        title="Climbing",
        start_at=(NOW.replace(hour=14, minute=10)).isoformat(),
        end_at=(NOW.replace(hour=16)).isoformat(),
        building_id="gym",
        travel_minutes=12,
    )
    # 14:01 is after cafe ends, but leave-for-gym is 13:58, so they go to the gym.
    trip = current_trip([cafe, gym], "u1", NOW.replace(hour=14, minute=1))
    assert trip["building_id"] == "gym"
    assert trip["phase"] in ("walking", "there")


def test_home_event_stays_put_after_end():
    row = ev(
        title="Cooking night",
        building_id="house:u1",
        text="home",
        travel_minutes=6,
        start_at=(NOW.replace(hour=17)).isoformat(),
        end_at=(NOW.replace(hour=19)).isoformat(),
    )
    after = current_trip([row], "u1", NOW.replace(hour=19, minute=1))
    assert after["phase"] == "home" and after["action"] == "idle"
    assert after["building_id"] == "house:u1"


def test_no_calendar_means_no_trip():
    assert current_trip([], "u1", NOW) is None


def test_default_travel_when_column_missing():
    row = ev()
    del row["travel_minutes"]
    trip = current_trip([row], "u1", NOW.replace(hour=9, minute=53))
    assert trip["travel_minutes"] == 8
    assert trip["leave_at"] == NOW.replace(hour=10) - timedelta(minutes=8)
