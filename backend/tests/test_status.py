from datetime import datetime, timedelta, timezone

from backend.status import active_status

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)


def test_status_runs_until_its_end_time_then_lapses():
    until = (NOW + timedelta(hours=2)).isoformat()
    assert active_status({"status": "free", "status_until": until}, NOW) == {"status": "free", "until": until}
    assert active_status({"status": "free", "status_until": until}, NOW + timedelta(hours=3)) is None


def test_missing_or_unknown_status_is_none():
    assert active_status({}, NOW) is None  # profile from before the columns existed
    assert active_status(None, NOW) is None
    assert active_status({"status": "napping", "status_until": NOW.isoformat()}, NOW) is None


def test_calendar_makes_you_busy_unless_you_set_a_status_yourself():
    from backend.status import effective_status
    block = {"since": (NOW - timedelta(minutes=30)).isoformat(), "until": (NOW + timedelta(minutes=45)).isoformat()}
    cal = effective_status({}, NOW, block)
    assert cal == {"status": "busy", "until": block["until"], "since": block["since"], "source": "calendar"}
    free = {"status": "free", "status_until": (NOW + timedelta(hours=1)).isoformat()}
    assert effective_status(free, NOW, block)["status"] == "free"  # "free anyway" beats the calendar
    busy = {"status": "busy", "status_until": (NOW + timedelta(hours=3)).isoformat()}
    mine = effective_status(busy, NOW, block)  # a busy you set is yours: your time, not the calendar's
    assert mine == {"status": "busy", "until": busy["status_until"]} and "source" not in mine
    lapsed = {"status": "free", "status_until": (NOW - timedelta(minutes=1)).isoformat()}
    assert effective_status(lapsed, NOW, block)["source"] == "calendar"  # once yours runs out, the calendar is back
    assert effective_status({}, NOW, None) is None
