from datetime import datetime, timedelta

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


def test_slider_sets_shared_town_clock():
    from backend.schedules import clock_mode, local_now, set_town_clock

    frozen = set_town_clock(hour=14.5)
    assert frozen.hour == 14 and frozen.minute == 30
    assert clock_mode() == "scrub"
    assert abs((local_now() - frozen).total_seconds()) < 1
    set_town_clock(fast=True)
    assert clock_mode() == "fast"
    set_town_clock(live=True)
    assert clock_mode() == "live"


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
