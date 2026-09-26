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


def test_only_visible_town_and_friends_posts_take_reactions_and_comments():
    from backend.posts import can_respond
    town = sig(1, "sam", text="pizza?", audience="town", town_id="t1")
    other = sig(2, "zoe", text="hi", audience="town", town_id="t2")
    friends = sig(3, "maya", text="news", audience="friends")
    private = sig(4, "me", text="rough day", audience="private")
    assert can_respond("me", town, TOWNS, FRIENDS)
    assert not can_respond("me", other, TOWNS, FRIENDS)
    assert can_respond("me", friends, TOWNS, FRIENDS)
    assert not can_respond("sam", friends, TOWNS, {})  # Sam isn't Maya's friend
    assert not can_respond("me", private, TOWNS, FRIENDS)  # not even the author: nobody else would see it


def test_feed_posts_carry_reaction_counts_and_comments():
    from backend.posts import with_responses
    s = [sig(1, "sam", text="pizza at 7?", audience="town", town_id="t1"), sig(2, "me", text="shh", audience="private")]
    items = post_items("me", s, TOWNS, PEOPLE, FRIENDS, NOW)
    reactions = [{"signal_id": 1, "user_id": "me", "emoji": "🎉"}, {"signal_id": 1, "user_id": "zoe", "emoji": "❤️"},
                 {"signal_id": 1, "user_id": "maya", "emoji": "❤️"}]
    comments = [{"id": 8, "signal_id": 1, "user_id": "sam", "text": "come thru", "created_at": "2026-09-26T13:00:00Z"},
                {"id": 7, "signal_id": 1, "user_id": "me", "text": "I'm in", "created_at": "2026-09-26T12:30:00Z"}]
    out = with_responses(items, reactions, comments, "me", lambda u, t: {"name": u.title()})
    town, mine = out
    assert town["reactions"] == [{"emoji": "❤️", "count": 2}, {"emoji": "🎉", "count": 1}]
    assert town["my_reaction"] == "🎉"
    assert [c["text"] for c in town["comments"]] == ["I'm in", "come thru"]
    assert town["comments"][0]["can_delete"] and not town["comments"][1]["can_delete"]
    assert town["comments"][1]["author"]["name"] == "Sam"
    assert "reactions" not in mine and "comments" not in mine
