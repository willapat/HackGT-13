"""AI town generation: Gemini designs a TownPlan from the user's description (prompt.py), layout.build turns
it into tiles + map with the town rules enforced in code. The grid size comes from how many people are in the
town (size_for), and when a joiner pushes the town into a bigger tier it's rebuilt from the saved plan (grow).
See routes/towns.py: POST /towns/generate and admit()."""

import random
import re
import zlib

from pydantic import ValidationError

from backend.agent.validate import parse_raw_json
from backend.config import settings
from backend.llm import complete
from backend.towngen.catalog import MID, PLACE_TYPES, SMALL, PlacePlan, TownPlan
from backend.towngen.layout import build, problems
from backend.towngen.prompt import planner_system_prompt, planner_user_message

# (most members, grid size). Each tier reserves one home plot per member it holds, so people can join
# without a rebuild until the town outgrows the tier.
TIERS = [(2, 11), (4, 13), (6, 15), (8, 17), (12, 21), (16, 25), (24, 31)]
LANDMARK_TILES = {"farm": "farm", "stadium": "stadium"}
# A stadium is a whole 3x3 block; an 11x11 town's suburb ring is only 2 deep, so it waits until the town grows.
LANDMARK_MIN_SIZE = {"farm": 11, "stadium": 13}


def tier_for(members: int) -> tuple[int, int]:
    """(home plots, grid size) for a town with this many members. Past the last tier, extra members get no house."""
    return next(((cap, size) for cap, size in TIERS if members <= cap), TIERS[-1])


def size_for(members: int) -> int:
    return tier_for(members)[1]


def apply_choices(plan: TownPlan, places: list[str], custom: list[str], landmarks: list[str], seed: str) -> None:
    """What the user picked when creating the town wins over the model: exactly those places, each named just
    its type ("Library", "Gym") on its catalog building; custom places under the user's own names on a random
    building; and exactly the picked landmarks. Picking nothing leaves the model's choices alone."""
    if places or custom:
        plan.places = [PlacePlan(id=t, name=PLACE_TYPES[t][0], model=PLACE_TYPES[t][1]) for t in places]
        rng = random.Random(zlib.crc32(seed.encode()))
        pool = [m for m in SMALL + MID if m not in {p.model for p in plan.places}]
        ids = set(places) | {"park", "outerpark"}
        for label in custom:
            base = re.sub(r"[^a-z0-9]+", "_", label.lower()).strip("_")[:20]
            base = base if len(base) >= 2 and base[0].isalpha() else f"place_{base}"[:20]
            pid, n = base, 2
            while pid in ids:
                pid, n = f"{base}_{n}", n + 1
            ids.add(pid)
            model = rng.choice(pool or SMALL + MID)
            if model in pool:
                pool.remove(model)  # each custom place looks different, while the catalog lasts
            plan.places.append(PlacePlan(id=pid, name=label, model=model))
    if places or custom or landmarks:
        plan.landmarks = list(dict.fromkeys(landmarks))


def shown_town(revision: dict) -> dict:
    """The plan of a town the user reviewed, for the model to edit (engine-set fields left out)."""
    prev = TownPlan.model_validate((revision.get("map") or {}).get("plan") or {})
    return prev.model_dump(exclude={"size", "home_slots"})


def plan_town(user_prompt: str, members: int = 1, name: str | None = None, places: list[str] = (),
              custom: list[str] = (), landmarks: list[str] = (), revision: dict | None = None) -> tuple[TownPlan, str]:
    """Ask the model for a plan; if its JSON is invalid, retry once with the error. Returns (plan, "ai" | "fallback").
    With a revision ({tiles, map, feedback}: a previewed town and what the user wants changed) the model edits that
    town's plan with the changes, keeping the rest."""
    size = size_for(members)
    system = planner_system_prompt()
    message = planner_user_message(user_prompt, size, members, name, places, custom, landmarks,
                                   previous=shown_town(revision) if revision else None,
                                   changes=revision["feedback"] if revision else None)
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
    if plan is None and revision:  # model down mid-review: keep the town they were looking at
        try:
            plan = TownPlan.model_validate((revision.get("map") or {}).get("plan") or {})
        except ValidationError:
            plan = None
    plan = plan or TownPlan(theme=user_prompt[:200])
    if name:
        plan.name = name
    apply_choices(plan, list(places), list(custom), list(landmarks), seed=f"{user_prompt}|{plan.name}")
    return plan, source


def lay_out(plan: TownPlan, members: int, prompt: str) -> tuple[list[list[str]], dict]:
    """Build the town for this many members. The plan and prompt are saved in the map so the town can regrow."""
    plan.home_slots, plan.size = tier_for(members)
    tiles, town_map = build(plan)
    broken = problems(tiles, town_map, homes_needed=min(members, plan.home_slots))
    broken += [f"requested place '{p.id}' is missing" for p in plan.places if p.id not in town_map["places"]]
    broken += [f"requested {lm} doesn't fit a {len(tiles)}x{len(tiles)} town" for lm in plan.landmarks
               if lm in LANDMARK_TILES and not any(LANDMARK_TILES[lm] in row for row in tiles) and len(tiles) >= LANDMARK_MIN_SIZE[lm]]
    if broken:  # layout.build guarantees these; if this ever fires it's an engine bug, not a model mistake
        raise RuntimeError(f"generated town breaks the rules: {broken}")
    town_map["plan"], town_map["prompt"] = plan.model_dump(), prompt
    return tiles, town_map


def generate_town(user_prompt: str, members: int = 1, name: str | None = None, places: list[str] = (),
                  custom: list[str] = (), landmarks: list[str] = (), revision: dict | None = None,
                  design: dict | None = None) -> dict:
    """Design and lay out a town. `design` is the plan of a preview the user approved: it's laid out again with no
    model call, and since layout is seeded by the plan, it comes out exactly as they saw it."""
    if design is not None:
        plan, source = TownPlan.model_validate(design), "approved"
    else:
        plan, source = plan_town(user_prompt, members, name, places, custom, landmarks, revision)
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
