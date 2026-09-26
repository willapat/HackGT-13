from datetime import datetime, timedelta, timezone

from backend.person import build_person, friend_state

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)
MAYA = {"id": "maya", "display_name": "Maya", "username": "maya", "bio": "climber", "interests": ["jazz", "climbing"],
        "avatar": {"photo": "https://x/p.jpg", "character": "girl-a"}, "email": "maya@secret.com",
        "status": "free", "status_until": (NOW + timedelta(hours=1)).isoformat()}
TOWN = [{"id": "t1", "name": "Lakeside", "residents": 4, "their_name": "Maya", "their_color": "#f00"}]


def test_strangers_only_get_a_minimal_card():
    p = build_person("me", MAYA, None, [], ["climbing"], [], None, NOW)
    assert p["relation"] == "stranger"
    assert set(p) == {"id", "display_name", "username", "photo", "relation", "friendship"}


def test_townmates_see_the_full_profile_with_shared_interests_first():
    p = build_person("me", MAYA, None, TOWN, ["climbing"], [], None, NOW)
    assert p["relation"] == "townmate"
    assert p["interests"] == [{"name": "climbing", "shared": True}, {"name": "jazz", "shared": False}]
    assert p["status"]["status"] == "free" and p["shared_towns"] == TOWN
    assert "email" not in p and "status_until" not in p


def test_friends_get_their_connection_with_you():
    row = {"id": "r1", "from_user": "me", "to_user": "maya", "status": "accepted", "responded_at": "2026-09-01"}
    bond = {"path_score": 0.72, "last_interaction_at": (NOW - timedelta(days=3)).isoformat()}
    p = build_person("me", MAYA, row, [], [], [{"id": "sam"}], bond, NOW)
    assert p["relation"] == "friend" and p["mutual_count"] == 1
    assert p["you_two"] == {"score": 0.72, "days_since": 3}


def test_friend_state_from_the_request_row():
    assert friend_state("me", None) == {"state": "none"}
    assert friend_state("me", {"id": "r", "from_user": "me", "to_user": "x", "status": "pending"}) == {"state": "requested"}
    assert friend_state("me", {"id": "r", "from_user": "x", "to_user": "me", "status": "pending"}) == {"state": "incoming", "request_id": "r"}
    assert friend_state("me", {"id": "r", "from_user": "x", "to_user": "me", "status": "declined"}) == {"state": "none"}
