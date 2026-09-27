from datetime import datetime, timedelta, timezone

from backend import paper


def act(user, building, lines=None):
    return {"user_id": user, "details": {"target_building_id": building, **({"lines": lines} if lines else {})}}


def test_arrivals_counts_new_trips_only_and_skips_houses():
    rows = [act("a", "cafe"), act("a", "cafe"), act("a", "house:a"), act("a", "cafe"), act("b", "cafe"), act("b", "gym"),
            {"user_id": "b", "details": {}}]
    got = paper.arrivals(rows)
    assert got["cafe"]["visits"] == 3 and got["cafe"]["people"] == {"a", "b"}
    assert got["gym"]["visits"] == 1 and "house:a" not in got


def test_week_bounds_monday_to_monday():
    tz = timezone(timedelta(hours=-4))
    start, end = paper.week_bounds(datetime(2026, 9, 26, 15, 30, tzinfo=tz))  # a Saturday
    assert start == datetime(2026, 9, 21, tzinfo=tz) and end - start == timedelta(days=7)
    assert paper.week_bounds(datetime(2026, 9, 26, tzinfo=tz), -1)[0] == datetime(2026, 9, 14, tzinfo=tz)


def members():
    return [{"user_id": "a", "name": "Maya", "profiles": {"interests": ["Climbing", "jazz"]}},
            {"user_id": "b", "name": "Sam", "profiles": {"interests": ["climbing"]}},
            {"user_id": "c", "name": "Leo", "profiles": {"interests": []}}]


def test_candidates_from_shared_interests_and_places():
    visits = paper.arrivals([act("b", "cafe"), act("c", "cafe")])
    cands = paper.candidates(members(), visits, {"cafe": "Café"})
    assert {"id": "interest:a:b", "kind": "interest", "user_ids": ["a", "b"], "interest": "Climbing"} in cands
    assert any(c["id"] == "place:cafe:b:c" and c["place"] == "Café" for c in cands)


def test_validate_draft_drops_invented_ids():
    raw = '{"summary": "A busy week at the café.", "insights": [' \
          '{"id": "interest:a:b", "text": "Maya and Sam both climb.", "suggestion": "Climb Thursday?"},' \
          '{"id": "made:up", "text": "Nope nope.", "suggestion": "Nope nope."}]}'
    draft = paper.validate_draft(raw, {"interest:a:b"})
    assert [p.id for p in draft.insights] == ["interest:a:b"]
    assert paper.validate_draft("not json", {"x"}) is None


def test_build_paper_without_model(monkeypatch):
    monkeypatch.setattr(paper, "available", lambda: False)
    tz = timezone.utc
    start, end = datetime(2026, 9, 21, tzinfo=tz), datetime(2026, 9, 28, tzinfo=tz)
    rows = [act("a", "cafe"), act("b", "cafe", lines=[{"text": "hi"}]), act("b", "gym")]
    got = paper.build_paper("t-test", start, end, members(), {"cafe": "Café", "gym": "Gym"}, rows,
                            [{"output": {"news": [{"title": "Maya got the job"}]}}])
    assert (got["week_start"], got["week_end"]) == ("2026-09-21", "2026-09-27")
    assert got["hot_places"][0] == {"building_id": "cafe", "name": "Café", "visits": 2, "people": 2}
    assert "Café was the busiest spot" in got["summary"] and got["source"] == "fallback"
    assert got["insights"][0]["kind"] == "interest" and [p["name"] for p in got["insights"][0]["people"]] == ["Maya", "Sam"]


class _Q:
    def __init__(self, db, name):
        self.db, self.name, self.filters = db, name, {}

    def select(self, *a, **k):
        return self

    def eq(self, k, v):
        self.filters[k] = v
        return self

    def gte(self, *a):
        return self

    lt = order = limit = lambda self, *a, **k: self

    def upsert(self, row):
        if self.db.missing:
            raise RuntimeError("relation town_papers does not exist")
        self.db.saved.append(row)
        return self

    def execute(self):
        if self.name == "town_papers" and self.db.missing:
            raise RuntimeError("relation town_papers does not exist")
        rows = list(self.db.saved) if self.name == "town_papers" else []
        rows = [r for r in rows if all(r.get(k) == v for k, v in self.filters.items())]
        return type("R", (), {"data": rows})()


class _DB:
    def __init__(self, missing=False):
        self.saved, self.missing = [], missing

    def table(self, name):
        return _Q(self, name)


def _paper_route(monkeypatch, db, source="ai"):
    from uuid import UUID
    from backend.routes import towns
    calls = []

    def fake_build(tid, start, end, *a):
        calls.append(start.date().isoformat())
        return {"week_start": start.date().isoformat(), "summary": "s", "source": source}

    monkeypatch.setattr(towns, "get_client", lambda: db)
    monkeypatch.setattr(towns, "require_member", lambda *a: None)
    monkeypatch.setattr(towns, "user_tz", lambda *a: timezone.utc)
    monkeypatch.setattr(towns, "_place_names", lambda *a: {})
    monkeypatch.setattr(towns, "build_paper", fake_build)
    tid = UUID("00000000-0000-0000-0000-000000000001")
    return (lambda offset: towns.town_paper(tid, offset=offset, uid="u")), calls


def test_finished_week_is_written_once_then_read_from_the_db(monkeypatch):
    db = _DB()
    paper_for, calls = _paper_route(monkeypatch, db)
    first, again = paper_for(-1), paper_for(-1)
    assert first == again and len(calls) == 1 and len(db.saved) == 1
    paper_for(0), paper_for(0)  # this week is never saved: it's still happening
    assert len(db.saved) == 1 and len(calls) == 3


def test_fallback_paper_is_not_saved_and_missing_table_still_works(monkeypatch):
    db = _DB()
    paper_for, calls = _paper_route(monkeypatch, db, source="fallback")
    paper_for(-1), paper_for(-1)
    assert db.saved == [] and len(calls) == 2  # the model gets another try next time
    paper_for, _ = _paper_route(monkeypatch, _DB(missing=True))
    assert paper_for(-1)["summary"] == "s"  # before the migration: built as usual
