import pytest
from fastapi import HTTPException

import backend.routes.towns as towns_route


class _Resp:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    """Filters rows for reads; records updates and deletes as (table, op, payload, filters)."""

    def __init__(self, db, name):
        self.db, self.name, self.filters, self.op, self.payload = db, name, [], "select", None

    def select(self, *a, **k):
        return self

    def update(self, payload):
        self.op, self.payload = "update", payload
        return self

    def delete(self):
        self.op = "delete"
        return self

    def insert(self, payload):
        self.op, self.payload = "insert", payload
        return self

    def eq(self, key, value):
        self.filters.append((key, "eq", value))
        return self

    def neq(self, key, value):
        self.filters.append((key, "neq", value))
        return self

    def limit(self, n):
        return self

    def execute(self):
        rows = [r for r in self.db.tables.get(self.name, [])
                if all((r.get(k) == v) == (op == "eq") for k, op, v in self.filters)]
        if self.op != "select":
            self.db.writes.append((self.name, self.op, self.payload, dict((k, v) for k, _, v in self.filters)))
        return _Resp(rows)


class FakeDB:
    def __init__(self, tables):
        self.tables, self.writes = tables, []

    def table(self, name):
        return FakeQuery(self, name)


def leave(monkeypatch, tables, uid):
    db = FakeDB(tables)
    monkeypatch.setattr(towns_route, "get_client", lambda: db)
    monkeypatch.setattr(towns_route, "require_member", lambda *a: {})  # no house placed, so no plot to free
    towns_route.leave_town("00000000-0000-0000-0000-000000000001", uid=uid)
    return db.writes


TID = "00000000-0000-0000-0000-000000000001"


def test_member_leaving_just_removes_their_row(monkeypatch):
    writes = leave(monkeypatch, {"towns": [{"id": TID, "created_by": "owner"}]}, "sam")
    assert writes == [("town_members", "delete", None, {"town_id": TID, "user_id": "sam"})]


def test_creator_leaving_hands_the_town_to_the_longest_member(monkeypatch):
    tables = {
        "towns": [{"id": TID, "created_by": "owner"}],
        "town_members": [
            {"town_id": TID, "user_id": "owner", "joined_at": "2026-01-01"},
            {"town_id": TID, "user_id": "late", "joined_at": "2026-03-01"},
            {"town_id": TID, "user_id": "early", "joined_at": "2026-02-01"},
        ],
    }
    writes = leave(monkeypatch, tables, "owner")
    assert writes[0] == ("towns", "update", {"created_by": "early"}, {"id": TID})
    assert writes[1] == ("town_members", "delete", None, {"town_id": TID, "user_id": "owner"})


def test_last_person_leaving_deletes_the_town(monkeypatch):
    tables = {"towns": [{"id": TID, "created_by": "owner"}],
              "town_members": [{"town_id": TID, "user_id": "owner", "joined_at": "2026-01-01"}]}
    assert leave(monkeypatch, tables, "owner") == [("towns", "delete", None, {"id": TID})]


def delete(monkeypatch, tables, uid, me=None):
    db = FakeDB(tables)
    monkeypatch.setattr(towns_route, "get_client", lambda: db)
    monkeypatch.setattr(towns_route, "require_member", lambda *a: me or {"name": "Will"})
    towns_route.delete_town(TID, uid=uid)
    return db.writes


def test_only_the_creator_can_delete_a_town(monkeypatch):
    with pytest.raises(HTTPException) as e:
        delete(monkeypatch, {"towns": [{"id": TID, "name": "Lakeside", "created_by": "owner"}]}, "sam")
    assert e.value.status_code == 403


def test_deleting_a_town_tells_everyone_else_in_their_inbox(monkeypatch):
    tables = {"towns": [{"id": TID, "name": "Lakeside", "created_by": "owner"}],
              "town_members": [{"town_id": TID, "user_id": "owner"}, {"town_id": TID, "user_id": "sam"},
                               {"town_id": TID, "user_id": "maya"}]}
    writes = delete(monkeypatch, tables, "owner", me={"name": "Will"})
    table, op, notices, _ = writes[0]
    assert (table, op) == ("notifications", "insert")
    assert sorted(n["user_id"] for n in notices) == ["maya", "sam"]
    assert notices[0]["payload"] == {"town_name": "Lakeside", "by_name": "Will"}
    assert writes[1] == ("towns", "delete", None, {"id": TID})
