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
