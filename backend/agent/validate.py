"""Every LLM output passes through here before it can reach Postgres."""

import json

from pydantic import ValidationError

from backend.models.agents import AgentDecisionInput, AgentDecisionOutput
from backend.models.brain import BrainOutput
from backend.models.enums import AGENT_ACTION_ALIASES, AgentAction

REQUIRED_TARGET_ACTIONS = {"visit", "knock", "chat", "leave_gift", "propose_event"}
MAX_LINE_CHARS = 160


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


def _reject(ctx: AgentDecisionInput, reason: str, detail) -> None:
    print(f"[VALIDATION FAILED: {reason}] character={ctx.character_id} detail={detail!r}", flush=True)
    return None


def validate_agent_decision(raw_output: dict | None, ctx: AgentDecisionInput) -> AgentDecisionOutput | None:
    """Returns a validated decision, or None if anything is off."""
    try:
        decision = AgentDecisionOutput.model_validate(raw_output)
    except ValidationError as e:
        return _reject(ctx, "schema", str(e))

    decision.action = AGENT_ACTION_ALIASES.get(decision.action, decision.action)
    if decision.action not in {a.value for a in AgentAction}:
        return _reject(ctx, "invalid_action", decision.action)
    if decision.target_building_id is not None and decision.target_building_id not in {
        b["id"] for b in ctx.available_buildings
    }:
        return _reject(ctx, "hallucinated_building", decision.target_building_id)
    if decision.target_user_id is not None and decision.target_user_id not in {
        c.user_id for c in ctx.nearby_characters
    }:
        return _reject(ctx, "hallucinated_target", decision.target_user_id)
    grounding_ids = {f.id for f in ctx.relevant_facts} | {e.id for e in ctx.active_events}
    if not set(decision.fact_ids) <= grounding_ids:
        return _reject(ctx, "hallucinated_fact_id", decision.fact_ids)
    if decision.action in REQUIRED_TARGET_ACTIONS and decision.target_user_id is None:
        return _reject(ctx, "missing_required_target", decision.action)
    return decision


def validate_lines(raw_output: dict | None, speaker_ids: set[str]) -> list[dict]:
    """Chat bubbles: only the two speakers, 1-3 short non-empty lines."""
    cleaned = []
    for line in ((raw_output or {}).get("lines") or [])[:3]:
        if not isinstance(line, dict):
            continue
        text = str(line.get("text") or "").strip()
        if line.get("speaker_id") in speaker_ids and text:
            cleaned.append({"speaker_id": line["speaker_id"], "text": text[:MAX_LINE_CHARS]})
    return cleaned


def validate_brain_output(raw_output: dict | None) -> BrainOutput | None:
    if raw_output is None:
        return None
    try:
        return BrainOutput.model_validate(raw_output)
    except ValidationError as e:
        print(f"[VALIDATION FAILED: brain_schema] {e}", flush=True)
        return None
