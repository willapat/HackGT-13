from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from backend.my_schedule import (
    ScheduleError, check_horizon, group_week, parse_slot, place_for_town, plan_remove, week_offset, week_window,
)

TZ = ZoneInfo("America/New_York")
MONDAY = datetime(2026, 9, 21, tzinfo=TZ)  # a Monday


def _ev(eid, title, start, end, **extra):
    return {
        "id": eid, "title": title, "kind": "class", "text": extra.pop("text", "University"),
        "start_at": start, "end_at": end, "status": "active", "event_participants": [{"user_id": "me", "status": "accepted"}],
        **extra,
    }


def test_week_starts_monday():
    start, end = week_window(datetime(2026, 9, 26, 22, 30, tzinfo=TZ), 0)  # Saturday
    assert start == MONDAY and end == MONDAY + timedelta(days=7)
    nxt, _ = week_window(start, 1)
    assert nxt == MONDAY + timedelta(days=7)
    assert week_offset(datetime(2026, 9, 24, 9, tzinfo=TZ), datetime(2026, 9, 26, tzinfo=TZ)) == 0
    assert week_offset(datetime(2026, 9, 28, 9, tzinfo=TZ), datetime(2026, 9, 26, tzinfo=TZ)) == 1


def test_copies_across_towns_are_one_row():
    start, end = "2026-09-23T13:00:00-04:00", "2026-09-23T14:15:00-04:00"
    days = group_week([
        _ev("a", "CS 3600", start, end),
        _ev("b", "CS 3600", start, end),
    ], MONDAY, "me")
    wednesday = days[2]
    assert wednesday["date"] == "2026-09-23" and wednesday["weekday"] == "Wednesday"
    assert len(wednesday["items"]) == 1
    item = wednesday["items"][0]
    assert item["title"] == "CS 3600" and item["place"] == "University"
    assert item["source"] == "you" and item["removable"] is True
    assert all(not day["items"] for i, day in enumerate(days) if i != 2)


def test_google_and_shared_events_stay():
    start, end = "2026-09-21T09:00:00-04:00", "2026-09-21T10:00:00-04:00"
    google = _ev("g", "At University", start, end, text=None, imported_from="google")
    shared = _ev("s", "Dinner", "2026-09-22T18:00:00-04:00", "2026-09-22T19:00:00-04:00", text="Café")
    shared["event_participants"].append({"user_id": "sam", "status": "accepted"})
    days = group_week([google, shared], MONDAY, "me")
    assert days[0]["items"][0]["source"] == "google" and days[0]["items"][0]["removable"] is False
    assert days[1]["items"][0]["removable"] is False
    with pytest.raises(ScheduleError) as google_err:
        plan_remove(google, [google], "me")
    assert google_err.value.status == 409
    with pytest.raises(ScheduleError) as shared_err:
        plan_remove(shared, [shared], "me")
    assert shared_err.value.status == 409


def test_remove_takes_every_town_copy():
    start, end = "2026-09-24T15:00:00-04:00", "2026-09-24T16:00:00-04:00"
    a, b = _ev("a", "Gym", start, end, text="Gym"), _ev("b", "Gym", start, end, text="Gym")
    assert plan_remove(a, [a, b], "me") == ["a", "b"]


def test_place_falls_back_to_a_building_the_town_has():
    places = [{"id": "library", "name": "Library"}, {"id": "cafe", "name": "Café"}]
    assert place_for_town(places, "university", "house:me") == "library"
    assert place_for_town(places, "cafe", "house:me") == "cafe"
    assert place_for_town(places, "gym", "house:me") == "house:me"
    assert place_for_town([], "home", "house:me") == "house:me"


def test_slot_is_a_same_day_span():
    began, ended = parse_slot("2026-09-28", "09:00", "10:30", TZ)
    assert (began.hour, began.minute) == (9, 0) and (ended - began) == timedelta(hours=1, minutes=30)
    with pytest.raises(ScheduleError):
        parse_slot("2026-09-28", "10:00", "09:00", TZ)
    with pytest.raises(ScheduleError):
        parse_slot("2026-02-31", "09:00", "10:00", TZ)
    now = datetime(2026, 9, 26, tzinfo=TZ)
    check_horizon(now, now)
    with pytest.raises(ScheduleError):
        check_horizon(now + timedelta(weeks=20), now)
