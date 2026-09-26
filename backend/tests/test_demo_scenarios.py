import pytest
from fastapi import HTTPException

from backend.routes.demo import cast_roles, primary_roles, scenario_signals


def _members(*names):
    return [{"user_id": f"{n}-uuid", "display_name": n} for n in names]


def test_cast_prefers_matching_names():
    cast = cast_roles(_members("Leo", "ana", "Maya"))
    assert cast["maya"] == "Maya-uuid"
    assert cast["leo"] == "Leo-uuid"
    assert cast["jordan"] == "ana-uuid"


def test_cast_works_with_any_names():
    cast = cast_roles(_members("ana", "ben"))
    assert cast["maya"] == "ana-uuid"
    assert cast["jordan"] == "ben-uuid"
    assert cast["sam"] != cast["priya"]
    assert primary_roles(cast) == {"ana-uuid": "maya", "ben-uuid": "jordan"}


def test_cast_single_member_climbing_dedupes():
    rows = scenario_signals("climbing", cast_roles(_members("ana")))
    assert [r["user_id"] for r in rows] == ["ana-uuid"]


def test_cast_empty_town_is_400():
    with pytest.raises(HTTPException) as e:
        cast_roles([])
    assert e.value.status_code == 400


def test_good_news_payload_is_only_a_signal():
    names = {"maya": "maya-uuid"}
    rows = scenario_signals("goodNews", names)
    assert len(rows) == 1
    assert rows[0]["type"] == "news"
    assert rows[0]["value"] == {"text": "got the internship"}
    assert rows[0]["source"] == "manual"


def test_climbing_payload_two_interest_mentions():
    names = {"sam": "sam-uuid", "priya": "priya-uuid"}
    rows = scenario_signals("climbing", names)
    assert {r["user_id"] for r in rows} == {"sam-uuid", "priya-uuid"}
    assert all(r["value"]["interest"] == "climbing" for r in rows)


def test_rough_week_payload_does_not_invent_details():
    names = {"jordan": "jordan-uuid"}
    rows = scenario_signals("roughWeek", names)
    assert rows[0]["value"] == {"mood": "rough_week"}
    assert "breakup" not in str(rows[0]["value"]).lower()


def test_models_roundtrip():
    from backend.models.agents import AgentDecisionOutput
    from backend.models.api import SignalIn
    from backend.models.brain import BrainOutput

    s = SignalIn.model_validate({"source": "manual", "type": "mood", "value": {"mood": "ok"}})
    assert s.model_dump()["value"]["mood"] == "ok"
    b = BrainOutput.model_validate({"facts": [], "member_states": [], "news": [], "quest_candidates": []})
    assert b.model_dump()["facts"] == []
    d = AgentDecisionOutput.model_validate({"action": "idle", "reason": "n", "fact_ids": []})
    assert d.action == "idle"


def test_openrouter_model_ids():
    from backend.llm import _openrouter_model

    assert _openrouter_model("google/gemini-2.5-flash") == "google/gemini-2.5-flash"
    assert _openrouter_model("gemini-2.5-flash") == "google/gemini-2.5-flash"
    assert _openrouter_model("gemini-2.5-flash-lite") == "google/gemini-2.5-flash-lite"
