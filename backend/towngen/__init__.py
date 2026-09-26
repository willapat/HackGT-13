"""AI town generation: Gemini designs a TownPlan from the user's description (prompt.py), layout.build turns
it into tiles + map with the town rules enforced in code. The grid size comes from how many people are in the
town (size_for), and when a joiner pushes the town into a bigger tier it's rebuilt from the saved plan (grow).
See routes/towns.py: POST /towns/generate and admit()."""

from pydantic import ValidationError

from backend.agent.validate import parse_raw_json
from backend.config import settings
from backend.llm import complete
from backend.towngen.catalog import TownPlan
from backend.towngen.layout import build, problems
from backend.towngen.prompt import planner_system_prompt, planner_user_message

# (most members, grid size). Each tier reserves one home plot per member it holds, so people can join
# without a rebuild until the town outgrows the tier.
TIERS = [(2, 11), (4, 13), (6, 15), (8, 17), (12, 21), (16, 25), (24, 31)]


def tier_for(members: int) -> tuple[int, int]:
    """(home plots, grid size) for a town with this many members. Past the last tier, extra members get no house."""
    return next(((cap, size) for cap, size in TIERS if members <= cap), TIERS[-1])


def size_for(members: int) -> int:
    return tier_for(members)[1]


def plan_town(user_prompt: str, members: int = 1, name: str | None = None) -> tuple[TownPlan, str]:
    """Ask the model for a plan; if its JSON is invalid, retry once with the error. Returns (plan, "ai" | "fallback")."""
    size = size_for(members)
    system, message = planner_system_prompt(), planner_user_message(user_prompt, size, members, name)
    plan, err = None, None
    for _ in range(2):
        ask = message if err is None else f"{message}\n\nYour last answer was rejected: {err}. Reply with only the corrected JSON object."
        try:
            raw = complete(settings.BRAIN_MODEL, system, ask, max_tokens=2500)
        except Exception as e:  # model/network down: build a sensible default town rather than fail the request
            print(f"[towngen] model call failed: {e!r}", flush=True)
            break
        data = parse_raw_json(raw)
        if data is None:
            err = "that was not a single JSON object"
            continue
        try:
            plan = TownPlan.model_validate(data)
            break
        except ValidationError as e:
            err = str(e)[:500]
    source = "ai" if plan else "fallback"
    plan = plan or TownPlan(theme=user_prompt[:200])
    if name:
        plan.name = name
    return plan, source


def lay_out(plan: TownPlan, members: int, prompt: str) -> tuple[list[list[str]], dict]:
    """Build the town for this many members. The plan and prompt are saved in the map so the town can regrow."""
    plan.home_slots, plan.size = tier_for(members)
    tiles, town_map = build(plan)
    broken = problems(tiles, town_map, homes_needed=min(members, plan.home_slots))
    if broken:  # layout.build guarantees these; if this ever fires it's an engine bug, not a model mistake
        raise RuntimeError(f"generated town breaks the rules: {broken}")
    town_map["plan"], town_map["prompt"] = plan.model_dump(), prompt
    return tiles, town_map


def generate_town(user_prompt: str, members: int = 1, name: str | None = None) -> dict:
    plan, source = plan_town(user_prompt, members, name)
    tiles, town_map = lay_out(plan, members, user_prompt)
    return {"name": plan.name, "tiles": tiles, "map": town_map, "plan": town_map["plan"], "plan_source": source}


def needs_to_grow(town: dict, members: int) -> bool:
    """A generated town whose grid is smaller than its member count calls for."""
    return bool((town.get("map") or {}).get("plan")) and size_for(members) > len(town.get("tiles") or [])


def grow(town: dict, members: int) -> tuple[list[list[str]], dict]:
    """Rebuild a generated town from its saved plan at the size its member count calls for. Same name, theme,
    places and parks; unless the user asked for a specific style, the buildings re-scale to the new size."""
    plan = TownPlan.model_validate(town["map"]["plan"])
    if not plan.custom_style:
        plan.core_models, plan.middle_models = [], []  # layout picks the palette that fits the new size
    return lay_out(plan, members, town["map"].get("prompt", ""))
