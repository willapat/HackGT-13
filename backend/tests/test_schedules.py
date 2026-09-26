from datetime import datetime, timedelta, timezone

from backend.schedules import TOWN_TZ, free_slots, label
from backend.scripts.seed_demo_schedules import PEOPLE, SCHEDULE, build_personal_events, build_signals

SAT = datetime(2026, 9, 26, tzinfo=TOWN_TZ)


def at(day: int, hour: int, minute: int = 0) -> datetime:
    return SAT + timedelta(days=day, hours=hour, minutes=minute)


def test_free_slots_skip_everyones_busy_blocks():
    busy = {"a": [(at(0, 9), at(0, 14))], "b": [(at(0, 13), at(0, 18))]}
    slots = free_slots(busy, now=at(0, 8), days=1, count=1)
    assert slots[0]["start"] == at(0, 18).isoformat()


def test_free_slots_one_per_day_first():
    slots = free_slots({"a": []}, now=at(0, 8), days=3, count=3)
    assert [s["start"] for s in slots] == [at(d, 9).isoformat() for d in range(3)]


def test_free_slots_ignore_the_past():
    slots = free_slots({"a": []}, now=at(0, 15, 30), days=1, count=1)
    assert slots[0]["start"] == at(0, 16).isoformat()


def test_live_keeps_the_hour_on_screen():
    from backend.schedules import FAST_RATE, clock_update, mode_for_rate, project_town_time

    shown = datetime(2026, 9, 26, 14, 30, tzinfo=TOWN_TZ)
    anchor, rate = clock_update(shown, hour=None, live=True, fast=False)
    assert anchor == shown and rate == 1.0 and mode_for_rate(rate) == "live"
    scrubbed, rate = clock_update(shown, hour=9.25, live=False, fast=False)
    assert (scrubbed.hour, scrubbed.minute) == (9, 15) and mode_for_rate(rate) == "scrub"
    real = datetime(2026, 9, 26, 16, 0, tzinfo=timezone.utc)
    assert project_town_time(scrubbed, real, 0, real + timedelta(hours=3)) == scrubbed
    resumed, rate = clock_update(scrubbed, hour=None, live=True, fast=False)
    assert (resumed.hour, resumed.minute) == (9, 15) and rate == 1.0
    later = project_town_time(resumed, real, rate, real + timedelta(hours=1))
    assert (later.hour, later.minute) == (10, 15)
    fast_anchor, fast_rate = clock_update(shown, hour=None, live=False, fast=True)
    assert fast_anchor == shown and fast_rate == FAST_RATE
    after_fast = project_town_time(fast_anchor, real, fast_rate, real + timedelta(seconds=120))
    assert abs((after_fast - fast_anchor).total_seconds() - 24 * 3600) < 1
    assert mode_for_rate(fast_rate) == "fast"


def test_play_is_one_minute_per_second_from_the_hour_on_screen():
    from backend.schedules import PLAY_RATE, clock_update, mode_for_rate, project_town_time

    scrubbed = datetime(2026, 9, 26, 9, 15, tzinfo=TOWN_TZ)
    anchor, rate = clock_update(scrubbed, hour=None, live=False, fast=False, play=True)
    assert anchor == scrubbed and rate == PLAY_RATE and mode_for_rate(rate) == "play"
    real = datetime(2026, 9, 26, 16, 0, tzinfo=timezone.utc)
    later = project_town_time(anchor, real, rate, real + timedelta(seconds=30))
    assert (later.hour, later.minute) == (9, 45)


def test_label_is_town_time():
    from backend.schedules import window_label

    assert label(at(2, 14)) == "Mon Sep 28, 2:00pm"
    assert window_label(at(2, 14), at(2, 15, 15)) == "Mon Sep 28, 2:00pm-3:15pm"


def test_seed_schedule_is_consistent():
    ids = {name: f"{name}-uuid" for name in PEOPLE}
    rows = build_signals(ids, SAT)
    assert len(rows) == len(SCHEDULE)
    assert {r["user_id"] for r in rows} == set(ids.values())
    for r in rows:
        v = r["value"]
        assert r["source"] == "calendar" and r["type"] == "calendar_event"
        assert datetime.fromisoformat(v["start"]) < datetime.fromisoformat(v["end"])
        assert "visibility" not in v
        assert v.get("building_id")
    shared = [r for r in rows if r["value"].get("with")]
    for r in shared:
        for other in r["value"]["with"]:
            assert any(o["user_id"] == other and r["user_id"] in o["value"].get("with", [])
                       and o["value"]["start"] == r["value"]["start"] for o in rows)


def test_personal_events_dedupe_shared_plans():
    ids = {name: f"{name}-uuid" for name in PEOPLE}
    rows = build_personal_events(ids, SAT, "town-1")
    assert all(r["type"] == "personal" for r in rows)
    assert all(r["start_at"] < r["end_at"] for r in rows)
    assert all(r["travel_minutes"] >= 6 for r in rows)
    dinners = [r for r in rows if r["title"] == "Dinner"]
    assert len(dinners) == 2
    assert all(len(r["_people"]) == 2 for r in dinners)
    assert len(rows) < len(SCHEDULE)
    assert all(r["building_id"] for r in rows)
    homes = [r for r in rows if r["text"] == "home"]
    assert homes and all(r["building_id"].startswith("house:") for r in homes)
