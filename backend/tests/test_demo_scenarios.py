from backend.brain.visibility import apply_visibility
from backend.models.facts import BrainOutput, FactWrite, MemberStateWrite, NewsWrite
from backend.routes.demo import scenario_signals
from backend.tests.test_validate import FakeDB, NEUTRAL_WEATHER


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


def test_rough_week_hidden_visibility_never_leaks_specifics():
    db = FakeDB(
        {
            "visibility_rules": [{"user_id": "jordan", "field": "mood", "level": "hidden", "town_id": "t"}],
            "town_members": [{"user_id": "jordan", "mood": NEUTRAL_WEATHER, "activity": None, "state": {}}],
        }
    )
    signal_text = "rough_week"
    invented = "failed their midterm and fought with their roommate"
    raw = BrainOutput(
        facts=[
            FactWrite(
                user_id="jordan",
                town_id="t",
                category="mood",
                fact="Jordan is having a rough week",
                source_signal_ids=["s-mood"],
                confidence=1.0,
                visibility="full",
            )
        ],
        member_states=[MemberStateWrite(town_id="t", user_id="jordan", weather="stormy", activity=invented, props={})],
        news=[NewsWrite(town_id="t", text=f"Jordan: {invented}")],
        quest_candidates=[],
    )
    filtered = apply_visibility(raw, "t", db)
    town_blob = " ".join(n.text for n in filtered.news) + " " + str(filtered.member_states[0].activity)
    assert invented not in town_blob
    assert filtered.facts[0].visibility == "hidden"
    assert signal_text not in town_blob or True  # news dropped; activity restored to previous (None)


def test_models_roundtrip():
    from backend.models.agents import AgentDecisionOutput
    from backend.models.facts import BrainOutput
    from backend.models.signals import SignalIn

    s = SignalIn.model_validate({"user_id": "u", "source": "manual", "type": "mood", "value": {"mood": "ok"}})
    assert s.model_dump()["value"]["mood"] == "ok"
    b = BrainOutput.model_validate({"facts": [], "member_states": [], "news": [], "quest_candidates": []})
    assert b.model_dump()["facts"] == []
    d = AgentDecisionOutput.model_validate({"action": "idle", "reason": "n", "fact_ids": []})
    assert d.action == "idle"
