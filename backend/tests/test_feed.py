from datetime import datetime, timedelta, timezone

from backend.feed import build_feed

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)
iso = lambda dt: dt.isoformat().replace("+00:00", "Z")  # noqa: E731
TOWNS = {"t1": "Lakeside"}
MEMBERS = [
    {"town_id": "t1", "user_id": "me", "name": "Will", "color": "#ff0000"},
    {"town_id": "t1", "user_id": "maya", "name": None, "color": "#00ff00", "profiles": {"display_name": "Maya"}},
    {"town_id": "t1", "user_id": "sam", "name": "Sam", "color": "#0000ff"},
]


def feed(runs=(), actions=(), events=()):
    return build_feed("me", TOWNS, MEMBERS, list(runs), list(actions), list(events), NOW)


def test_news_is_deduped_across_runs_and_newest_first():
    runs = [
        {"id": "r2", "town_id": "t1", "created_at": iso(NOW), "output": {"news": [{"title": "Maya got the internship"}]}},
        {"id": "r1", "town_id": "t1", "created_at": iso(NOW - timedelta(hours=1)), "output": {"news": [{"title": "Maya got the internship"}]}},
    ]
    items = feed(runs=runs)["items"]
    assert [i["id"] for i in items] == ["news:r2:0"]
    assert items[0]["town"] == {"id": "t1", "name": "Lakeside"}


def test_social_actions_name_both_people_and_skip_movement():
    actions = [
        {"id": 3, "town_id": "t1", "user_id": "maya", "action": "chat", "created_at": iso(NOW),
         "details": {"target_user_id": "sam", "lines": [{"speaker_id": "maya", "text": "climb Saturday?"}]}},
        {"id": 2, "town_id": "t1", "user_id": "sam", "action": "walk_to", "created_at": iso(NOW), "details": {}},
        {"id": 1, "town_id": "t1", "user_id": "sam", "action": "visit", "created_at": iso(NOW), "details": {}},  # no target
    ]
    items = feed(actions=actions)["items"]
    assert len(items) == 1
    assert items[0]["kind"] == "chat"
    assert items[0]["title"] == "Maya chatted with Sam"  # falls back to the profile name
    assert items[0]["lines"] == [{"name": "Maya", "color": "#00ff00", "text": "climb Saturday?"}]


def test_inbox_holds_only_plans_waiting_on_me():
    def ev(eid, status, parts, start=None):
        return {"id": eid, "town_id": "t1", "status": status, "title": eid, "created_at": iso(NOW), "start_at": start,
                "event_participants": [{"user_id": u, "status": s} for u, s in parts.items()]}

    events = [
        ev("unanswered", "suggested", {"me": "suggested", "maya": "accepted"}),
        ev("answered", "suggested", {"me": "accepted", "maya": "suggested"}),
        ev("to-approve", "scheduled", {"me": "accepted", "sam": "accepted"}),
        ev("not-mine", "scheduled", {"maya": "accepted", "sam": "accepted"}),
    ]
    inbox = feed(events=events)["inbox"]
    assert [i["id"] for i in inbox] == ["unanswered", "to-approve"]
    assert [p["name"] for p in inbox[0]["people"]] == ["Maya"]


def test_today_lists_the_next_24_hours_in_order():
    def ev(eid, hours, status="active"):
        return {"id": eid, "town_id": "t1", "status": status, "title": eid, "created_at": iso(NOW),
                "start_at": iso(NOW + timedelta(hours=hours)), "event_participants": [{"user_id": "maya", "status": "accepted"}]}

    today = feed(events=[ev("dinner", 7), ev("gym", 2), ev("past", -1), ev("tomorrow-night", 30), ev("off", 3, "cancelled")])["today"]
    assert [t["id"] for t in today] == ["gym", "dinner"]
    assert today[0]["people"][0]["name"] == "Maya"


def test_town_summary_has_residents_headline_and_recent_count():
    runs = [{"id": "r1", "town_id": "t1", "created_at": iso(NOW - timedelta(hours=2)), "output": {"news": [{"title": "Sam is climbing"}]}},
            {"id": "r0", "town_id": "t1", "created_at": iso(NOW - timedelta(days=3)), "output": {"news": [{"title": "Old news"}]}}]
    [town] = feed(runs=runs)["towns"]
    assert town["headline"] == "Sam is climbing"
    assert town["new"] == 1
    assert sorted(p["name"] for p in town["residents"]) == ["Maya", "Sam", "Will"]


def test_free_now_lists_townmates_with_a_running_free_status():
    later, earlier = iso(NOW + timedelta(hours=3)), iso(NOW - timedelta(hours=1))
    members = [
        {"town_id": "t1", "user_id": "me", "name": "Will", "profiles": {"status": "free", "status_until": later}},
        {"town_id": "t1", "user_id": "maya", "name": "Maya", "profiles": {"status": "free", "status_until": later}},
        {"town_id": "t1", "user_id": "sam", "name": "Sam", "profiles": {"status": "busy", "status_until": later}},
        {"town_id": "t1", "user_id": "jo", "name": "Jo", "profiles": {"status": "free", "status_until": earlier}},  # lapsed
    ]
    out = build_feed("me", TOWNS, members, [], [], [], NOW)
    assert [p["name"] for p in out["free_now"]] == ["Maya"]
    assert out["towns"][0]["residents"][2]["status"]["status"] == "busy"
