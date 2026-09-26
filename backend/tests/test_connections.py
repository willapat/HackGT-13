from backend.connections.detector import find_connection_candidates


class _Resp:
    def __init__(self, data):
        self.data = data


class FakeQuery:
    def __init__(self, rows):
        self.rows = list(rows)

    def select(self, *a, **k):
        return self

    def eq(self, key, value):
        if self.rows and key not in self.rows[0]:
            return self
        self.rows = [r for r in self.rows if r.get(key) == value]
        return self

    def in_(self, key, values):
        self.rows = [r for r in self.rows if r.get(key) in values]
        return self

    def execute(self):
        return _Resp(self.rows)


class FakeDB:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return FakeQuery(self._tables.get(name, []))


SAM, PRIYA, MAYA = "sam-id", "priya-id", "maya-id"


def _members():
    return [
        {"user_id": SAM, "profiles": {"id": SAM, "display_name": "Sam", "interests": ["climbing"]}},
        {"user_id": PRIYA, "profiles": {"id": PRIYA, "display_name": "Priya", "interests": ["climbing"]}},
        {"user_id": MAYA, "profiles": {"id": MAYA, "display_name": "Maya", "interests": ["piano"]}},
    ]


def test_shared_interest_pair_returned():
    db = FakeDB({"town_members": _members(), "events": []})
    found = find_connection_candidates("t", db)
    pairs = {tuple(sorted(c["user_ids"])) for c in found}
    assert tuple(sorted((SAM, PRIYA))) in pairs
    assert all("climbing" in c["shared_interests"] for c in found if set(c["user_ids"]) == {SAM, PRIYA})


def test_existing_active_quest_cools_down_pair():
    db = FakeDB(
        {
            "town_members": _members(),
            "events": [
                {
                    "id": "e1",
                    "type": "quest",
                    "status": "suggested",
                    "town_id": "t",
                    "event_participants": [{"user_id": SAM}, {"user_id": PRIYA}],
                }
            ],
        }
    )
    found = find_connection_candidates("t", db)
    pairs = {tuple(sorted(c["user_ids"])) for c in found}
    assert tuple(sorted((SAM, PRIYA))) not in pairs
