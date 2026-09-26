from backend.post_ideas import FALLBACK, validate_ideas


def test_valid_ideas_pass_through():
    raw = '{"ideas": [{"label": "How was bouldering?", "starter": "Bouldering today was "}, {"label": "Plans tonight?", "starter": "Tonight I want to "}]}'
    assert validate_ideas(raw)[0] == {"label": "How was bouldering?", "starter": "Bouldering today was ", "why": ""}


def test_bad_or_oversized_output_is_rejected():
    assert validate_ideas("not json") is None
    assert validate_ideas('{"ideas": [{"label": "x" , "starter": "y"}]}') is None  # too short, too few
    long = "a" * 80
    assert validate_ideas('{"ideas": [{"label": "ok ok", "starter": "%s"}, {"label": "ok ok", "starter": "fine "}]}' % long) is None


def test_fallback_ideas_are_well_formed():
    assert validate_ideas({"ideas": FALLBACK[:4]}) is not None


def test_without_the_model_ideas_come_from_your_own_calendar_and_interests():
    from backend.post_ideas import simple_ideas
    ideas = simple_ideas({"today": [{"title": "Bouldering session", "start": "x"}], "me": {"interests": ["climbing"]}})
    assert [i["label"] for i in ideas[:2]] == ["How was Bouldering session?", "Climbing hot take"]
    assert len(ideas) == 4 and validate_ideas({"ideas": ideas}) is not None


def _context():
    from backend.post_ideas import build_context
    me = {"display_name": "Will Patton", "bio": "CS at Tech", "interests": ["climbing", "coffee"]}
    people = [
        {"user_id": "d", "name": "Drew Kim", "bio": "always at the gym", "interests": ["climbing"], "free": True,
         "days_since": 2, "relation": "friend"},
        {"user_id": "s", "name": "Sam", "bio": "", "interests": ["chess"], "free": False, "days_since": None,
         "relation": "townmate"},
    ]
    items = [
        {"kind": "post", "audience": "private", "mine": False, "actor": {"name": "Sam"}, "text": "secret"},
        {"kind": "post", "audience": "friends", "mine": True, "actor": {"name": "Will"}, "text": "mine"},
        {"kind": "post", "audience": "town", "mine": False, "actor": {"name": "Drew Kim"}, "text": "new crag opened",
         "town": {"name": "Lakeside"}},
        {"kind": "news", "title": "Bake sale Friday", "text": "at the cafe", "town": {"name": "Lakeside"}},
    ]
    return build_context(me, "Sat 2:40 PM", [], None, people, items, [])


def test_context_includes_people_and_happenings_but_never_private_posts():
    ctx = _context()
    assert ctx["people"][0] == {"name": "Drew", "relation": "friend", "bio": "always at the gym", "interests": ["climbing"],
                                "shared_interests": ["climbing"], "free_now": True, "days_since_crossed_paths": 2}
    whats = [r["what"] for r in ctx["recent"]]
    assert whats == ["Drew posted: new crag opened", "Bake sale Friday — at the cafe"]
    assert "secret" not in str(ctx)


def test_fallback_ideas_are_personal_and_refresh_brings_new_ones():
    from backend.post_ideas import simple_ideas
    ctx = _context()
    first = simple_ideas(ctx)
    assert first[0]["label"] == "Climbing with Drew?"
    again = simple_ideas(ctx, avoid=[i["label"] for i in first], shuffle=True)
    assert len(again) == 4 and not {i["label"] for i in again} & {i["label"] for i in first}
    assert validate_ideas({"ideas": again}) is not None
