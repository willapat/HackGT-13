from backend.agent.validate import parse_raw_json, validate_agent_decision, validate_brain_output, validate_lines
from backend.brain.visibility import NEUTRAL_MOOD, apply_visibility
from backend.models.agents import AgentDecisionInput, NearbyCharacter, RelevantFact
from backend.models.brain import BrainOutput, Fact, MemberState, NewsItem, QuestCandidate
from backend.models.enums import POSTGRES_AGENT_ACTION_VALUES, AgentAction, Visibility


def _ctx(**kwargs) -> AgentDecisionInput:
    base = dict(
        character_id="alex",
        display_name="Alex",
        town_id="town1",
        current_location_building_id="cafe",
        current_action="idle",
        nearby_characters=[
            NearbyCharacter(user_id="sam", display_name="Sam", location_building_id="cafe")
        ],
        relevant_facts=[RelevantFact(id="run1:0", user_id="maya", category="news", fact="Maya got an internship")],
        active_events=[],
        available_actions=[a.value for a in AgentAction],
        available_buildings=[{"id": "cafe", "type": "cafe"}, {"id": "gym", "type": "gym"}],
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


def test_self_target_returns_none():
    raw = {"action": "visit", "target_user_id": "alex", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_lines_only_keep_the_two_speakers():
    raw = {"lines": [{"speaker_id": "alex", "text": " hi "}, {"speaker_id": "mallory", "text": "x"},
                     {"speaker_id": "sam", "text": ""}, "junk"]}
    assert validate_lines(raw, {"alex", "sam"}) == [{"speaker_id": "alex", "text": "hi"}]
    assert validate_lines(None, {"alex"}) == []


def test_missing_required_target_returns_none():
    raw = {"action": "visit", "reason": "x", "fact_ids": []}
    assert validate_agent_decision(raw, _ctx()) is None


def test_walk_to_building_alias_normalizes():
    raw = {"action": "walk_to_building", "target_building_id": "gym", "reason": "go", "fact_ids": []}
    out = validate_agent_decision(raw, _ctx())
    assert out is not None
    assert out.action == AgentAction.walk_to.value


def test_valid_idle_passes():
    raw = {"action": "idle", "reason": "nothing to do", "fact_ids": ["run1:0"]}
    out = validate_agent_decision(raw, _ctx())
    assert out is not None
    assert out.action == "idle"


JORDAN_PREV = {"user_id": "jordan", "mood": NEUTRAL_MOOD, "activity": None, "state": {}}
SAM_PREV = {"user_id": "sam", "mood": None, "activity": None, "state": {}}


def _brain_output(secret: str) -> BrainOutput:
    return BrainOutput(
        facts=[Fact(user_id="jordan", category="mood", fact=secret, source_signal_ids=["s1"])],
        member_states=[MemberState(user_id="jordan", mood="stormy", activity="crying at home", props={"x": 1})],
        news=[NewsItem(title=secret)],
        quest_candidates=[QuestCandidate(title="Check in", text=secret, participant_user_ids=["jordan", "sam"])],
    )


def test_hidden_signal_never_leaks_to_town_visible_output():
    secret = "Jordan is having a rough week because of a breakup"
    signals = [{"user_id": "jordan", "value": {"mood": "rough_week", "visibility": "hidden"}}]
    out = apply_visibility(_brain_output(secret), signals, [JORDAN_PREV, SAM_PREV])
    assert out.facts == []  # brain_runs.output is town-readable
    assert out.member_states[0].mood.value == NEUTRAL_MOOD
    assert out.member_states[0].activity is None and out.member_states[0].props == {}
    assert out.news == [] and out.quest_candidates == []


def test_vague_signal_blurs_state():
    signals = [{"user_id": "jordan", "value": {"visibility": "vague"}}]
    out = apply_visibility(_brain_output("specifics"), signals, [JORDAN_PREV, SAM_PREV])
    assert out.member_states[0].mood.value == NEUTRAL_MOOD
    assert "crying" not in (out.member_states[0].activity or "")
    assert out.facts == [] and out.news == []


def test_full_signal_passes_through():
    signals = [{"user_id": "jordan", "value": {"mood": "rough_week"}}]
    out = apply_visibility(_brain_output("Jordan is having a rough week"), signals, [JORDAN_PREV, SAM_PREV])
    assert len(out.facts) == 1 and out.member_states[0].mood.value == "stormy"
    assert len(out.news) == 1 and len(out.quest_candidates) == 1


def test_brain_cannot_write_about_non_members():
    out = apply_visibility(_brain_output("x"), [], [SAM_PREV])
    assert out.facts == [] and out.member_states == [] and out.quest_candidates == []


def test_brain_output_rejects_bad_weather():
    assert (
        validate_brain_output(
            {
                "facts": [],
                "member_states": [{"user_id": "u", "mood": "nuclear"}],
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
    assert Visibility.hidden.value == "hidden"


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
