from backend.routes.demo import scenario_signals


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
