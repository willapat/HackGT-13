from backend.suggestions import suggest

row = lambda a, b, status="accepted": {"from_user": a, "to_user": b, "status": status}  # noqa: E731


def test_friends_of_friends_rank_by_mutual_friends_and_towns():
    pairs = [row("me", "ana"), row("ben", "me")]
    friend_pairs = [row("ana", "cy"), row("ben", "cy"), row("ana", "dee"), row("ana", "me"), row("ben", "ana")]
    got = suggest("me", pairs, friend_pairs, {"eve": ["Lakeside"], "dee": ["Lakeside"]})
    assert [p["id"] for p in got] == ["cy", "dee", "eve"]  # 2 mutual > 1 mutual + a town > a town
    assert got[0]["mutual_ids"] == ["ana", "ben"] and got[1]["towns"] == ["Lakeside"]


def test_nobody_you_already_have_a_request_with_is_suggested():
    pairs = [row("me", "ana"), row("me", "cy", "pending"), row("dee", "me", "declined")]
    friend_pairs = [row("ana", "cy"), row("ana", "dee"), row("ana", "me")]
    assert suggest("me", pairs, friend_pairs, {"ana": ["Lakeside"], "cy": ["Lakeside"]}) == []


def test_no_friends_and_no_towns_means_no_suggestions():
    assert suggest("me", [], [], {}) == []
