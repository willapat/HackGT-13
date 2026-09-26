from datetime import datetime, timedelta, timezone

from backend.profile_stats import build_stats

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)
iso = lambda dt: dt.isoformat().replace("+00:00", "Z")  # noqa: E731
TOWNS = {"t1": "Lakeside", "t2": "Midtown"}
MEMBERS = [
    {"town_id": "t1", "user_id": "me", "name": "Will"},
    {"town_id": "t1", "user_id": "maya", "name": "Maya", "color": "#e8743a"},
    {"town_id": "t1", "user_id": "sam", "name": "Sam"},
    {"town_id": "t2", "user_id": "me", "name": "Will"},
    {"town_id": "t2", "user_id": "sam", "name": "Sammy"},
    {"town_id": "t2", "user_id": "jo", "name": None, "profiles": {"display_name": "Jordan"}},
]


def stats(actions=(), runs=(), friendships=()):
    return build_stats("me", TOWNS, MEMBERS, list(actions), list(runs), list(friendships), 2, 5, NOW)


def test_most_active_counts_actions_and_news_and_biggest_counts_residents():
    s = stats(actions=[{"town_id": "t2"}] * 2, runs=[{"town_id": "t1", "output": {"news": [{}, {}, {}]}}])
    assert s["most_active"]["id"] == "t1" and s["most_active"]["activity_week"] == 3
    assert s["biggest"]["residents"] == 3
    assert s["hangouts"] == 2 and s["shared"] == 5


def test_quiet_towns_have_no_most_active():
    assert stats()["most_active"] is None


def test_closest_and_reconnect_come_from_friendship_rows():
    friendships = [
        {"user_a": "maya", "user_b": "me", "path_score": 0.9, "last_interaction_at": iso(NOW - timedelta(days=1))},
        {"user_a": "me", "user_b": "sam", "path_score": 0.6, "last_interaction_at": iso(NOW - timedelta(days=12))},
    ]
    s = stats(friendships=friendships)
    assert [p["name"] for p in s["closest"]] == ["Maya", "Sam"]  # each townmate once, first town's name
    assert s["closest"][1]["days_since"] == 12
    # Sam drifted 12 days ago; Jordan and I have never crossed paths
    assert [p["name"] for p in s["reconnect"]] == ["Sam", "Jordan"]
    assert s["townmates"] == 3
