from copy import deepcopy

from backend.models.enums import VisibilityLevel, WeatherKind
from backend.models.facts import BrainOutput, FactWrite, MemberStateWrite, NewsWrite

NEUTRAL_WEATHER = WeatherKind.cloudy.value
VAGUE_ACTIVITY = "is out and about"


def _rule_level(rules: dict[tuple[str, str], str], user_id: str, field: str) -> str:
    return rules.get((user_id, field), VisibilityLevel.full.value)


def load_visibility_rules(db, town_id: str, user_ids: list[str]) -> dict[tuple[str, str], str]:
    if not user_ids:
        return {}
    resp = (
        db.table("visibility_rules")
        .select("user_id, field, level")
        .eq("town_id", town_id)
        .in_("user_id", user_ids)
        .execute()
    )
    return {(row["user_id"], row["field"]): row["level"] for row in (resp.data or [])}


def load_previous_member_state(db, town_id: str, user_id: str) -> dict:
    resp = (
        db.table("town_members")
        .select("mood, activity, state")
        .eq("town_id", town_id)
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    rows = resp.data or []
    return rows[0] if rows else {"mood": NEUTRAL_WEATHER, "activity": None, "state": {}}


def apply_visibility(brain_output: BrainOutput, town_id: str, db) -> BrainOutput:
    """Filter Brain output using visibility_rules. Fail closed: hidden never leaks to town-visible tables."""
    user_ids = list(
        {f.user_id for f in brain_output.facts}
        | {s.user_id for s in brain_output.member_states}
    )
    rules = load_visibility_rules(db, town_id, user_ids)

    facts: list[FactWrite] = []
    hidden_or_vague_users_fields: set[tuple[str, str]] = set()
    for fact in brain_output.facts:
        level = fact.visibility if fact.visibility in {v.value for v in VisibilityLevel} else VisibilityLevel.full.value
        rule = _rule_level(rules, fact.user_id, fact.category)
        if rule in (VisibilityLevel.hidden.value, VisibilityLevel.vague.value):
            level = rule
        patched = fact.model_copy(update={"visibility": level, "town_id": fact.town_id or town_id})
        facts.append(patched)
        if level in (VisibilityLevel.hidden.value, VisibilityLevel.vague.value):
            hidden_or_vague_users_fields.add((fact.user_id, fact.category))

    member_states: list[MemberStateWrite] = []
    for state in brain_output.member_states:
        prev = load_previous_member_state(db, town_id, state.user_id)
        weather_level = _rule_level(rules, state.user_id, "mood")
        activity_level = _rule_level(rules, state.user_id, "activity")
        # Hidden mood also blocks new activity copy so specifics cannot leak via that field.
        if weather_level == VisibilityLevel.hidden.value and activity_level == VisibilityLevel.full.value:
            activity_level = VisibilityLevel.hidden.value
        weather = state.weather
        activity = state.activity
        props = deepcopy(state.props)

        if weather_level == VisibilityLevel.hidden.value:
            weather = prev.get("mood") or NEUTRAL_WEATHER
            props.pop("mood_text", None)
        elif weather_level == VisibilityLevel.vague.value:
            weather = WeatherKind.cloudy.value

        if activity_level == VisibilityLevel.hidden.value:
            activity = prev.get("activity")
        elif activity_level == VisibilityLevel.vague.value:
            activity = VAGUE_ACTIVITY

        member_states.append(
            state.model_copy(
                update={"weather": weather, "activity": activity, "props": props, "town_id": town_id}
            )
        )

    # Fail closed: anything less than full visibility never reaches town-visible news.
    private = any(
        f.visibility in (VisibilityLevel.hidden.value, VisibilityLevel.vague.value) for f in facts
    )
    news: list[NewsWrite] = [] if private else list(brain_output.news)

    return BrainOutput(
        facts=facts,
        member_states=member_states,
        news=news,
        quest_candidates=brain_output.quest_candidates,
    )
