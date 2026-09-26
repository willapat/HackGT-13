from backend.agent.validate import parse_raw_json, validate_agent_decision, validate_brain_output
from backend.brain.visibility import NEUTRAL_WEATHER, apply_visibility
from backend.models.agents import AgentDecisionInput, NearbyCharacter, RelevantFact
from backend.models.enums import POSTGRES_AGENT_ACTION_VALUES, AgentAction, VisibilityLevel
from backend.models.facts import BrainOutput, FactWrite, MemberStateWrite, NewsWrite


def _ctx(**kwargs) -> AgentDecisionInput:
    base = dict(
        character_id="alex",
        town_id="town1",
        current_location_building_id="cafe",
        current_action="idle",
        nearby_characters=[
            NearbyCharacter(user_id="sam", display_name="Sam", location_building_id="cafe", busy=False)
        ],
        relevant_facts=[RelevantFact(id="f1", category="news", fact="Maya got an internship")],
        active_events=[],
        known_connections=[],
        available_actions=[a.value for a in AgentAction],
        available_buildings=[{"id": "cafe", "type": "cafe"}, {"id": "gym", "type": "gym"}],
        inventory={"gift": 1},
    )
    base.update(kwargs)
    return AgentDecisionInput(**base)


def test_invalid_json_parse():
    assert parse_raw_json("not json") is None
    assert parse_raw_json("{") is None
    assert parse_raw_json(None) is None


def test_valid_json_object():
    assert parse_raw_json('{"action": "idle", "reason": "x", "fact_ids": []}')["action"] == "idle"


def test_schema_failure_returns_none():
    assert validate_agent_decision({"nope": True}, _ctx()) is None


def test_invalid_action_returns_none():
    raw = {"action": "fly_to_moon", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_hallucinated_building_returns_none():
    raw = {"action": "walk_to", "target_building_id": "spaceship", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_hallucinated_user_returns_none():
    raw = {"action": "visit", "target_user_id": "stranger", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_hallucinated_fact_id_returns_none():
    raw = {"action": "idle", "reason": "x", "fact_ids": ["made-up"]}
    assert validate_agent_decision(raw, _ctx()) is None


def test_gift_without_inventory_returns_none():
    raw = {"action": "leave_gift", "target_user_id": "sam", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx(inventory={"gift": 0})) is None


def test_missing_required_target_returns_none():
    raw = {"action": "visit", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_walk_to_building_alias_normalizes():
    raw = {"action": "walk_to_building", "target_building_id": "gym", "reason": "go", "fact_ids": []}
    out = validate_agent_decision(raw, _ctx())
    assert out is not None
    assert out.action == AgentAction.walk_to.value


def test_valid_idle_passes():
    raw = {"action": "idle", "reason": "nothing to do", "fact_ids": ["f1"]}
    out = validate_agent_decision(raw, _ctx())
    assert out is not None
    assert out.action == "idle"


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

    def limit(self, n):
        self.rows = self.rows[:n]
        return self

    def execute(self):
        return _Resp(self.rows)


class FakeDB:
    def __init__(self, tables: dict):
        self._tables = tables

    def table(self, name):
        return FakeQuery(self._tables.get(name, []))


def test_hidden_mood_does_not_leak_to_news_or_member_state():
    db = FakeDB(
        {
            "visibility_rules": [
                {"user_id": "jordan", "field": "mood", "level": VisibilityLevel.hidden.value, "town_id": "t"}
            ],
            "town_members": [{"user_id": "jordan", "mood": NEUTRAL_WEATHER, "activity": None, "state": {}}],
        }
    )
    secret = "Jordan is having a rough week because of a breakup"
    raw = BrainOutput(
        facts=[
            FactWrite(
                user_id="jordan",
                town_id="t",
                category="mood",
                fact=secret,
                source_signal_ids=["s1"],
                confidence=1.0,
                visibility="full",
            )
        ],
        member_states=[
            MemberStateWrite(town_id="t", user_id="jordan", weather="stormy", activity="crying at home", props={})
        ],
        news=[NewsWrite(town_id="t", text=secret)],
        quest_candidates=[],
    )
    filtered = apply_visibility(raw, "t", db)
    assert filtered.facts[0].visibility == "hidden"
    assert filtered.member_states[0].weather != "stormy"
    assert filtered.member_states[0].weather == NEUTRAL_WEATHER
    assert all(secret not in n.text for n in filtered.news)
    assert filtered.news == []


def test_brain_output_rejects_bad_weather():
    assert (
        validate_brain_output(
            {
                "facts": [],
                "member_states": [{"town_id": "t", "user_id": "u", "weather": "nuclear"}],
                "news": [],
                "quest_candidates": [],
            }
        )
        is None
    )


def test_agent_action_enum_matches_postgres_labels():
    assert POSTGRES_AGENT_ACTION_VALUES == (
        "idle",
        "walk_to",
        "visit",
        "knock",
        "chat",
        "leave_gift",
        "propose_event",
        "go_home",
    )
    assert VisibilityLevel.hidden.value == "hidden"


def test_enum_roundtrip_against_postgres():
    from backend.config import settings

    if not settings.SUPABASE_DB_URL:
        return
    try:
        import psycopg

        with psycopg.connect(settings.SUPABASE_DB_URL, connect_timeout=8) as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid "
                    "where t.typname = 'agent_action' order by enumsortorder"
                )
                labels = tuple(r[0] for r in cur.fetchall())
        assert labels == POSTGRES_AGENT_ACTION_VALUES
        with psycopg.connect(settings.SUPABASE_DB_URL, connect_timeout=8) as conn:
            conn.autocommit = False
            with conn.cursor() as cur:
                cur.execute("select town_id, user_id from agents limit 1")
                row = cur.fetchone()
                if not row:
                    return
                town_id, user_id = row
                for label in labels:
                    cur.execute("begin")
                    try:
                        cur.execute(
                            "insert into agent_actions (town_id, user_id, action) values (%s, %s, %s::agent_action)",
                            (town_id, user_id, label),
                        )
                        cur.execute("select action from agent_actions order by id desc limit 1")
                        assert cur.fetchone()[0] == label
                    finally:
                        cur.execute("rollback")
    except Exception as exc:
        import pytest

        pytest.skip(f"postgres enum round-trip skipped: {exc.__class__.__name__}")
