from backend.routes.me import plan_town_handoff


def test_town_goes_to_longest_standing_member():
    others = [
        {"town_id": "t1", "user_id": "late", "joined_at": "2026-09-26T12:00:00Z"},
        {"town_id": "t1", "user_id": "early", "joined_at": "2026-09-25T09:00:00Z"},
    ]
    assert plan_town_handoff(["t1"], others) == ({"t1": "early"}, [])


def test_empty_town_is_deleted():
    assert plan_town_handoff(["t1"], []) == ({}, ["t1"])


def test_each_town_handled_on_its_own():
    others = [{"town_id": "t2", "user_id": "sam", "joined_at": "2026-09-26T00:00:00Z"}]
    assert plan_town_handoff(["t1", "t2"], others) == ({"t2": "sam"}, ["t1"])


def test_no_owned_towns():
    assert plan_town_handoff([], [{"town_id": "t9", "user_id": "x", "joined_at": "z"}]) == ({}, [])
