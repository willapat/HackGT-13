from datetime import datetime, timezone

import pytest

import backend.google_calendar as gc


class FakeTable:
    """Just enough of supabase-py's query builder for google_calendar.py."""

    def __init__(self, db, name):
        self.db, self.name, self.filters, self.op, self.payload = db, name, [], "select", None

    def select(self, *_):
        self.op = "select"
        return self

    def insert(self, rows):
        self.op, self.payload = "insert", rows if isinstance(rows, list) else [rows]
        return self

    def upsert(self, rows, on_conflict=""):
        self.op, self.payload, self.keys = "upsert", rows if isinstance(rows, list) else [rows], on_conflict.split(",")
        return self

    def update(self, change):
        self.op, self.payload = "update", change
        return self

    def delete(self):
        self.op = "delete"
        return self

    def eq(self, col, val):
        self.filters.append((col, val))
        return self

    def limit(self, _):
        return self

    def _match(self, row):
        return all(row.get(c) == v for c, v in self.filters)

    def execute(self):
        rows = self.db.tables.setdefault(self.name, [])
        hits = [r for r in rows if self._match(r)]
        if self.op == "insert":
            for r in self.payload:
                r.setdefault("id", f"{self.name}-{len(rows) + 1}")
                rows.append(r)
            hits = self.payload
        elif self.op == "upsert":
            for r in self.payload:
                same = [x for x in rows if all(x.get(k) == r.get(k) for k in self.keys)]
                if same:
                    same[0].update(r)
                else:
                    rows.append(dict(r))
            hits = self.payload
        elif self.op == "update":
            for r in hits:
                r.update(self.payload)
        elif self.op == "delete":
            self.db.tables[self.name] = [r for r in rows if not self._match(r)]
        return type("Res", (), {"data": hits})()


class FakeDB:
    def __init__(self, **tables):
        self.tables = tables

    def table(self, name):
        return FakeTable(self, name)


class FakeResp:
    def __init__(self, status, body):
        self.status_code, self._body = status, body

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise gc.httpx.HTTPStatusError("bad", request=None, response=None)


T1 = datetime(2026, 9, 27, 14, tzinfo=timezone.utc)
T2 = datetime(2026, 9, 27, 16, tzinfo=timezone.utc)
TINY = {"places": {"market": {"name": "Market"}, "cafe": {"name": "Bean There Café"}, "park": {"name": "Central Park"}}}
LAKE = {"places": {"market": {"name": "Farmers Market"}, "park": {"name": "Lakeside Green"}, "pocketpark": {"name": "Pocket Park"}}}


@pytest.fixture(autouse=True)
def google_creds(monkeypatch):
    monkeypatch.setattr(gc.settings, "GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setattr(gc.settings, "GOOGLE_CLIENT_SECRET", "secret")


@pytest.fixture(autouse=True)
def no_model(monkeypatch):
    """No real LLM calls from tests; test_calendar_places turns a fake one on."""
    import backend.calendar_places as cp
    monkeypatch.setattr(cp, "available", lambda: False)


def g_event(summary, location="", **kw):
    return {"summary": summary, "location": location, "start": {"dateTime": T1.isoformat()}, "end": {"dateTime": T2.isoformat()}, **kw}


def fake_google(monkeypatch, token_resp, items=(), events_status=200, calendars=None, by_calendar=None, list_status=200):
    monkeypatch.setattr(gc.httpx, "post", lambda url, **kw: token_resp)
    if calendars is None:
        calendars = [{"id": "primary", "primary": True, "accessRole": "owner"}]

    def get(url, **kw):
        assert kw["headers"]["Authorization"] == "Bearer at"
        if url == gc.CALENDAR_LIST_URL:
            return FakeResp(list_status, {"items": list(calendars)})
        assert "/calendars/" in url and url.endswith("/events")
        assert kw["params"]["singleEvents"] == "true"
        from urllib.parse import unquote
        calendar_id = unquote(url.split("/calendars/")[1].removesuffix("/events"))
        batch = items if by_calendar is None else by_calendar.get(calendar_id, [])
        return FakeResp(events_status, {"items": list(batch)})
    monkeypatch.setattr(gc.httpx, "get", get)


def db_with_user(towns=(("t1", TINY), ("t2", LAKE))):
    return FakeDB(
        calendar_connections=[{"user_id": "u1", "refresh_token": "rt", "scopes": "https://www.googleapis.com/auth/calendar.calendarlist.readonly"}],
        town_members=[{"town_id": t, "user_id": "u1", "towns": {"map": m}} for t, m in towns],
        events=[{"id": "old", "imported_for": "u1", "title": "Busy"}, {"id": "keep", "imported_for": None, "title": "Class"}],
        event_participants=[],
    )


def imported(db):
    return {e["town_id"]: e for e in db.tables["events"] if e.get("imported_for") == "u1"}


def test_event_goes_to_the_matching_place_in_each_town(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), [g_event("Groceries at the market with mom")])
    db = db_with_user()
    assert gc.sync_user(db, "u1") == {"events": 1}
    rows = imported(db)
    assert rows["t1"]["building_id"] == "market" and rows["t1"]["title"] == "At Market"
    assert rows["t2"]["building_id"] == "market" and rows["t2"]["title"] == "At Farmers Market"
    assert all("mom" not in (r["title"] + str(r.get("text"))) for r in rows.values())  # real title stays private
    assert "old" not in {e["id"] for e in db.tables["events"]} and "keep" in {e["id"] for e in db.tables["events"]}
    assert {p["user_id"] for p in db.tables["event_participants"]} == {"u1"}
    conn = db.tables["calendar_connections"][0]
    assert conn["last_error"] is None and conn["last_synced_at"]


def test_location_and_accents_match_too(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), [g_event("Catch up", location="Bean There Cafe, 5th St")])
    db = db_with_user(towns=(("t1", TINY),))
    gc.sync_user(db, "u1")
    assert imported(db)["t1"]["building_id"] == "cafe"


def test_my_calendars_are_read_and_subscribed_ones_are_not(monkeypatch):
    fake_google(
        monkeypatch, FakeResp(200, {"access_token": "at"}),
        calendars=[
            {"id": "primary", "primary": True, "accessRole": "owner"},
            {"id": "classes@group.calendar.google.com", "accessRole": "owner"},
            {"id": "holidays@group.calendar.google.com", "accessRole": "reader"},
        ],
        by_calendar={
            "primary": [],
            "classes@group.calendar.google.com": [g_event("Club at the market")],
            "holidays@group.calendar.google.com": [g_event("Picnic at the park")],
        },
    )
    db = db_with_user(towns=(("t1", TINY),))
    assert gc.sync_user(db, "u1") == {"events": 1}
    assert imported(db)["t1"]["building_id"] == "market"


def test_no_matching_place_goes_home(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), [g_event("Dentist")])
    db = db_with_user(towns=(("t1", TINY),))
    gc.sync_user(db, "u1")
    row = imported(db)["t1"]
    assert row["building_id"] == "house:u1" and row["title"] == "Busy"
    assert 10 <= row["travel_minutes"] <= 20


def test_longest_place_name_wins():
    places = gc._town_places({"map": LAKE})
    assert gc.match_place(places, "Picnic in Pocket Park", "")["id"] == "pocketpark"
    assert gc.match_place(places, "Marketing meeting", "") is None  # whole words only


def test_all_day_free_and_declined_events_are_skipped(monkeypatch):
    items = [
        {"summary": "Market day", "start": {"date": "2026-09-27"}, "end": {"date": "2026-09-28"}},
        g_event("Market", transparency="transparent"),
        g_event("Market", attendees=[{"self": True, "responseStatus": "declined"}]),
        g_event("Market", status="cancelled"),
    ]
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), items)
    db = db_with_user()
    assert gc.sync_user(db, "u1") == {"events": 0}
    assert imported(db) == {}


def test_revoked_access_is_recorded_and_keeps_old_events(monkeypatch):
    fake_google(monkeypatch, FakeResp(400, {"error": "invalid_grant"}))
    db = db_with_user()
    with pytest.raises(gc.CalendarError, match="Reconnect"):
        gc.sync_user(db, "u1")
    assert "Reconnect" in db.tables["calendar_connections"][0]["last_error"]
    assert "old" in {e["id"] for e in db.tables["events"]}


def test_old_free_busy_permission_asks_to_reconnect(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), events_status=403)
    db = db_with_user()
    with pytest.raises(gc.CalendarError, match="Reconnect"):
        gc.sync_user(db, "u1")


def test_not_in_any_town_imports_nothing(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}), [g_event("Market")])
    db = db_with_user(towns=())
    gc.sync_user(db, "u1")
    assert [e["id"] for e in db.tables["events"]] == ["keep"]


def test_disconnect_forgets_token_and_imports(monkeypatch):
    revoked = []
    monkeypatch.setattr(gc.httpx, "post", lambda url, **kw: revoked.append((url, kw["data"]["token"])))
    db = db_with_user()
    db.tables["calendar_place_guesses"] = [{"user_id": "u1", "town_id": "t1", "event_key": "k", "choice": "misc"}]
    gc.disconnect(db, "u1")
    assert db.tables["calendar_connections"] == [] and db.tables["calendar_place_guesses"] == []
    assert [e["id"] for e in db.tables["events"]] == ["keep"]
    assert revoked == [(gc.REVOKE_URL, "rt")]
