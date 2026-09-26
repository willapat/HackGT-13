from datetime import datetime, timezone

from backend.posts import post_items

NOW = datetime(2026, 9, 26, 12, tzinfo=timezone.utc)
TOWNS = {"t1": "Lakeside"}
PEOPLE = {("t1", "me"): {"user_id": "me", "name": "Will"}, ("t1", "sam"): {"user_id": "sam", "name": "Sam"},
          ("t2", "zoe"): {"user_id": "zoe", "name": "Zoe"}}
FRIENDS = {"maya": {"id": "maya", "display_name": "Maya", "avatar": {"photo": "p.jpg"}}}


def sig(i, who, **value):
    return {"id": i, "user_id": who, "created_at": f"2026-09-26T1{i}:00:00Z", "value": value}


def ids(items):
    return [it["id"] for it in items]


def test_town_posts_reach_only_that_town():
    s = [sig(1, "sam", text="pizza at 7?", audience="town", town_id="t1"),
         sig(2, "zoe", text="other town news", audience="town", town_id="t2")]
    out = post_items("me", s, TOWNS, PEOPLE, FRIENDS, NOW)
    assert ids(out) == ["post:1"] and out[0]["town"] == {"id": "t1", "name": "Lakeside"}


def test_friends_posts_reach_friends_even_outside_your_towns():
    s = [sig(1, "maya", text="got the internship!", audience="friends"),
         sig(2, "sam", text="friends only", audience="friends")]  # Sam is a townmate, not a friend
    out = post_items("me", s, TOWNS, PEOPLE, FRIENDS, NOW)
    assert ids(out) == ["post:1"] and out[0]["actor"]["name"] == "Maya" and out[0]["actor"]["photo"] == "p.jpg"


def test_private_posts_are_only_ever_shown_to_their_author():
    s = [sig(1, "me", text="rough day", audience="private"), sig(2, "sam", text="secret", audience="private")]
    out = post_items("me", s, TOWNS, PEOPLE, FRIENDS, NOW)
    assert ids(out) == ["post:1"] and out[0]["mine"]


def test_signals_that_are_not_posts_are_skipped():
    s = [sig(1, "sam", mood="rough_week"), sig(2, "sam", text="", audience="town", town_id="t1")]
    assert post_items("me", s, TOWNS, PEOPLE, FRIENDS, NOW) == []
