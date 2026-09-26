import json
from typing import Any

from pydantic import ValidationError

from backend.models.agents import AgentDecisionInput, AgentDecisionOutput
from backend.models.enums import AGENT_ACTION_ALIASES, AgentAction

REQUIRED_TARGET_ACTIONS = {"visit", "knock", "chat", "leave_gift", "propose_event"}


def parse_raw_json(raw: str | dict | None) -> dict | None:
    if raw is None:
        return None
    if isinstance(raw, dict):
        return raw
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    try:
        data = json.loads(text)
    except (json.JSONDecodeError, TypeError):
        return None
    return data if isinstance(data, dict) else None


def normalize_action(action: str) -> str:
    return AGENT_ACTION_ALIASES.get(action, action)


def log_agent_validation_failure(
    character_id: str,
    reason: str,
    detail: Any,
    raw_output: Any,
    town_id: str | None = None,
) -> None:
    print(
        f"[VALIDATION FAILED: {reason}] character={character_id} detail={detail!r}",
        flush=True,
    )
    try:
        import uuid as uuid_lib

        from backend.db import get_client

        if town_id:
            uuid_lib.UUID(str(town_id))
            get_client().table("agent_actions").insert(
                {
                    "town_id": town_id,
                    "user_id": character_id,
                    "action": AgentAction.idle.value,
                    "details": {
                        "reasoning": f"[VALIDATION FAILED: {reason}] {detail}",
                        "raw": raw_output,
                    },
                }
            ).execute()
    except Exception as exc:
        print(f"[VALIDATION FAILED] could not write agent_actions: {exc!r}", flush=True)


def validate_agent_decision(
    raw_output: dict,
    input_ctx: AgentDecisionInput,
) -> AgentDecisionOutput | None:
    """Returns a validated AgentDecisionOutput, or None if anything fails."""
    try:
        decision = AgentDecisionOutput.model_validate(raw_output)
    except ValidationError as e:
        log_agent_validation_failure(input_ctx.character_id, "schema", str(e), raw_output, input_ctx.town_id)
        return None

    decision.action = normalize_action(decision.action)
    if decision.action not in {a.value for a in AgentAction}:
        log_agent_validation_failure(input_ctx.character_id, "invalid_action", decision.action, raw_output, input_ctx.town_id)
        return None

    if decision.target_building_id is not None:
        valid_ids = {b["id"] for b in input_ctx.available_buildings}
        if decision.target_building_id not in valid_ids:
            log_agent_validation_failure(
                input_ctx.character_id, "hallucinated_building", decision.target_building_id, raw_output, input_ctx.town_id
            )
            return None

    if decision.target_user_id is not None:
        valid_ids = {c.user_id for c in input_ctx.nearby_characters} | {input_ctx.character_id}
        if decision.target_user_id not in valid_ids:
            log_agent_validation_failure(
                input_ctx.character_id, "hallucinated_target", decision.target_user_id, raw_output, input_ctx.town_id
            )
            return None

    valid_fact_ids = {f.id for f in input_ctx.relevant_facts}
    if not set(decision.fact_ids).issubset(valid_fact_ids):
        log_agent_validation_failure(input_ctx.character_id, "hallucinated_fact_id", decision.fact_ids, raw_output, input_ctx.town_id)
        return None

    if decision.action == AgentAction.leave_gift.value and input_ctx.inventory.get("gift", 0) <= 0:
        log_agent_validation_failure(input_ctx.character_id, "gift_without_inventory", None, raw_output, input_ctx.town_id)
        return None

    if decision.action in REQUIRED_TARGET_ACTIONS and decision.target_user_id is None:
        log_agent_validation_failure(input_ctx.character_id, "missing_required_target", None, raw_output, input_ctx.town_id)
        return None

    return decision


def validate_brain_output(raw_output: dict) -> "BrainOutput | None":
    from backend.models.enums import FACT_CATEGORIES, VisibilityLevel, WeatherKind
    from backend.models.facts import BrainOutput

    try:
        out = BrainOutput.model_validate(raw_output)
    except ValidationError as e:
        print(f"[VALIDATION FAILED: brain_schema] {e}", flush=True)
        return None

    vis = {v.value for v in VisibilityLevel}
    weather = {w.value for w in WeatherKind}
    for fact in out.facts:
        if fact.category not in FACT_CATEGORIES or fact.visibility not in vis:
            print(f"[VALIDATION FAILED: brain_enum] fact={fact}", flush=True)
            return None
    for state in out.member_states:
        if state.weather not in weather:
            print(f"[VALIDATION FAILED: brain_weather] {state.weather}", flush=True)
            return None
    return out
