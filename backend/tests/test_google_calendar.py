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


@pytest.fixture(autouse=True)
def google_creds(monkeypatch):
    monkeypatch.setattr(gc.settings, "GOOGLE_CLIENT_ID", "cid")
    monkeypatch.setattr(gc.settings, "GOOGLE_CLIENT_SECRET", "secret")


def fake_google(monkeypatch, token_resp, busy=((T1, T2),)):
    def post(url, **kw):
        if url == gc.TOKEN_URL:
            return token_resp
        assert url == gc.FREEBUSY_URL and kw["headers"]["Authorization"] == "Bearer at"
        return FakeResp(200, {"calendars": {"primary": {"busy": [
            {"start": s.isoformat(), "end": e.isoformat()} for s, e in busy]}}})
    monkeypatch.setattr(gc.httpx, "post", post)


def db_with_user(towns=("t1", "t2")):
    return FakeDB(
        calendar_connections=[{"user_id": "u1", "refresh_token": "rt"}],
        town_members=[{"town_id": t, "user_id": "u1"} for t in towns],
        events=[{"id": "old", "imported_for": "u1", "title": "Busy"}, {"id": "keep", "imported_for": None, "title": "Class"}],
        event_participants=[],
    )


def test_busy_block_copied_into_every_town_at_home(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}))
    db = db_with_user()
    assert gc.sync_user(db, "u1") == {"busy_blocks": 1}
    imported = [e for e in db.tables["events"] if e.get("imported_for") == "u1"]
    assert {e["town_id"] for e in imported} == {"t1", "t2"}
    assert all(e["title"] == "Busy" and e["building_id"] == "house:u1" and e["type"] == "personal" for e in imported)
    assert "old" not in {e["id"] for e in db.tables["events"]}  # previous copies replaced
    assert "keep" in {e["id"] for e in db.tables["events"]}  # events made in Tiny Town untouched
    assert {p["user_id"] for p in db.tables["event_participants"]} == {"u1"}
    conn = db.tables["calendar_connections"][0]
    assert conn["last_error"] is None and conn["last_synced_at"]


def test_revoked_access_is_recorded_and_keeps_old_events(monkeypatch):
    fake_google(monkeypatch, FakeResp(400, {"error": "invalid_grant"}))
    db = db_with_user()
    with pytest.raises(gc.CalendarError, match="Reconnect"):
        gc.sync_user(db, "u1")
    assert "Reconnect" in db.tables["calendar_connections"][0]["last_error"]
    assert "old" in {e["id"] for e in db.tables["events"]}


def test_not_in_any_town_imports_nothing(monkeypatch):
    fake_google(monkeypatch, FakeResp(200, {"access_token": "at"}))
    db = db_with_user(towns=())
    gc.sync_user(db, "u1")
    assert [e["id"] for e in db.tables["events"]] == ["keep"]


def test_disconnect_forgets_token_and_imports(monkeypatch):
    revoked = []
    monkeypatch.setattr(gc.httpx, "post", lambda url, **kw: revoked.append((url, kw["data"]["token"])))
    db = db_with_user()
    gc.disconnect(db, "u1")
    assert db.tables["calendar_connections"] == []
    assert [e["id"] for e in db.tables["events"]] == ["keep"]
    assert revoked == [(gc.REVOKE_URL, "rt")]
