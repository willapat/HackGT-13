import json

import backend.towngen as towngen
from backend.models.api import TownCreate
from backend.towngen.catalog import MID, SMALL, TALL, PlacePlan, TownPlan
from backend.towngen.layout import build, problems


def test_rules_hold_for_every_size_and_option():
    for size in range(11, 32, 2):
        for bw in (2, 3, 4):
            for landmark in ("none", "farm", "stadium"):
                for outer_park in (True, False):
                    tiles, town_map = build(TownPlan(size=size, block_width=bw, landmarks=[] if landmark == "none" else [landmark], outer_park=outer_park))
                    assert problems(tiles, town_map) == [], (size, bw, landmark, outer_park)
                    TownCreate(name="x", tiles=tiles, map=town_map, me={"name": "Me", "color": "#ff3b30"})  # API accepts it


def test_outer_park_is_symmetric_with_water_in_the_middle():
    tiles, town_map = build(TownPlan(size=13, outer_park=True))
    assert "outerpark" in town_map["places"]
    (wx, wy), = [(i, j) for j in range(len(tiles)) for i in range(len(tiles)) if tiles[j][i] == "water"]  # only the park has water
    grid = [[tiles[wy - 1 + j][wx - 1 + i] for i in range(3)] for j in range(3)]
    assert grid == [["oak", "bench-s", "oak"], ["bench-e", "water", "bench-w"], ["oak", "bench-n", "oak"]]


def test_plan_customizes_places_and_palettes_and_drops_unknown_models():
    plan = TownPlan(size=21, core_models=[TALL[0], "made-up/tower"], middle_models=[MID[0]],
                    places=[{"id": "cafe", "name": "Bean There", "model": SMALL[9]},
                            {"id": "arcade", "name": "Pixel Palace", "model": "not/a-model"}])
    tiles, town_map = build(plan)
    assert town_map["places"]["cafe"]["name"] == "Bean There" and "arcade" not in town_map["places"]
    x, y = town_map["places"]["cafe"]["tile"]
    assert tiles[y][x] == SMALL[9]
    flat = {k for row in tiles for k in row}
    assert TALL[0] in flat and "made-up/tower" not in flat


def test_small_towns_default_to_small_buildings():
    tiles, _ = build(TownPlan(size=13))
    assert not {k for row in tiles for k in row} & set(TALL)


def test_plan_town_retries_bad_json_then_uses_the_model(monkeypatch):
    answers = iter(["not json", json.dumps({"name": "Tidepool", "size": 15, "places": []})])
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: next(answers))
    plan, source = towngen.plan_town("a seaside village")
    assert (plan.name, plan.size, source) == ("Tidepool", 15, "ai")


def test_plan_town_falls_back_when_the_model_is_down(monkeypatch):
    def down(*a, **k):
        raise RuntimeError("no key")
    monkeypatch.setattr(towngen, "complete", down)
    made = towngen.generate_town("anything", members=1, name="Backup")
    assert made["plan_source"] == "fallback" and made["name"] == "Backup" and len(made["tiles"]) == 11


def test_each_size_tier_reserves_a_plot_per_member():
    for cap, size in towngen.TIERS:
        for bw in (2, 3, 4):
            tiles, town_map = towngen.lay_out(TownPlan(block_width=bw), cap, "p")
            assert len(tiles) == size and len(town_map["home_slots"]) == cap and problems(tiles, town_map, cap) == []
    assert [towngen.size_for(n) for n in (1, 2, 3, 5, 7, 9, 13, 17, 99)] == [11, 11, 13, 15, 17, 21, 25, 31, 31]


def fake_model(monkeypatch, plan: dict):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(plan))


def test_town_grows_from_its_saved_plan_and_rescales_buildings(monkeypatch):
    fake_model(monkeypatch, {"name": "Tidepool", "places": [{"id": "cafe", "name": "Bean There", "model": SMALL[9]}],
                             "core_models": [MID[0]], "middle_models": [SMALL[0]]})
    made = towngen.generate_town("a seaside town")
    town = {"tiles": made["tiles"], "map": made["map"]}
    assert len(town["tiles"]) == 11 and not towngen.needs_to_grow(town, 2) and towngen.needs_to_grow(town, 3)
    tiles, town_map = towngen.grow(town, 7)
    assert len(tiles) == 17 and len(town_map["home_slots"]) == 8
    assert town_map["places"]["cafe"]["name"] == "Bean There" and town_map["plan"]["name"] == "Tidepool"
    assert {k for row in tiles for k in row} & set(TALL)  # 17x17 without a custom style: a tall downtown now
    assert town_map["prompt"] == "a seaside town"


def test_custom_style_survives_growth(monkeypatch):
    fake_model(monkeypatch, {"name": "Cottages", "custom_style": True, "core_models": [SMALL[0]], "middle_models": [SMALL[1]]})
    made = towngen.generate_town("only little cottage shops, no towers")
    tiles, _ = towngen.grow({"tiles": made["tiles"], "map": made["map"]}, 9)
    assert len(tiles) == 21 and not {k for row in tiles for k in row} & set(TALL)


def test_suburb_scenery_is_varied_not_patterned():
    tiles, town_map = build(TownPlan(size=21, name="Varied"))
    plots = {(x, y) for p in town_map["home_slots"] for x in range(p["block"][0], p["block"][2] + 1) for y in range(p["block"][1], p["block"][3] + 1)}
    N, c = len(tiles), len(tiles) // 2
    scenes = {"garden", "picnic", "plaza", "patio", "tree", "oak", "lot"}
    pairs = same = 0
    edge = c - min(i for i in range(N) if all(k == "road" for k in tiles[i]))
    outer = lambda x, y: max(abs(x - c), abs(y - c)) > edge
    for y in range(N):
        for x in range(N - 1):
            a, b = tiles[y][x], tiles[y][x + 1]
            if outer(x, y) and outer(x + 1, y) and a in scenes and b in scenes and not {(x, y), (x + 1, y)} & plots:
                pairs += 1
                same += a == b
    assert pairs and same / pairs < 0.1  # neighbours rarely match (unclaimed home plots are 2x2 garden by design)
    assert len({k for row in tiles for k in row} & scenes) >= 5  # a real mix of scene types


def test_user_picked_places_win_over_the_model(monkeypatch):
    from backend.towngen.catalog import PLACE_TYPES
    fake_model(monkeypatch, {"name": "Tidepool", "landmarks": ["stadium"],
                             "places": [{"id": "cafe", "name": "Salty Bean", "model": SMALL[0]},
                                        {"id": "arcade", "name": "Pixel Pier", "model": SMALL[1]}]})
    made = towngen.generate_town("seaside", places=["cafe", "library"], custom=["Hospital", "Hospital", "Dog Park!"],
                                 landmarks=["farm"])
    places = made["map"]["places"]
    assert places["cafe"]["name"] == "Café" and places["cafe"]["model"] == PLACE_TYPES["cafe"][1]  # plain type name, our building
    assert places["library"]["name"] == "Library"
    assert "arcade" not in places  # the user picked their places; nothing extra
    assert places["hospital"]["name"] == "Hospital" and places["hospital_2"]["name"] == "Hospital"
    assert places["dog_park"]["name"] == "Dog Park!"
    assert len({places[k]["model"] for k in ("hospital", "hospital_2", "dog_park")}) == 3  # distinct random buildings
    assert made["plan"]["landmarks"] == ["farm"] and any("farm" in row for row in made["tiles"])


def test_generate_request_rejects_unknown_place_types():
    import pytest
    from backend.models.api import TownGenerate
    me = {"name": "Me", "color": "#ff3b30"}
    assert TownGenerate(prompt="x", me=me, places=["cafe", "cafe"]).places == ["cafe"]
    with pytest.raises(ValueError):
        TownGenerate(prompt="x", me=me, places=["spaceport"])


def test_every_requested_place_and_landmark_is_built_at_every_size():
    from backend.towngen.catalog import MAX_PLACES, PLACE_TYPES
    picks = [PlacePlan(id=k, name=label, model=m) for k, (label, m) in list(PLACE_TYPES.items())[:MAX_PLACES]]
    for cap, size in towngen.TIERS:
        for bw in (2, 3, 4):
            for landmarks in (["stadium", "farm"], ["stadium"], ["farm"], []):
                tiles, town_map = towngen.lay_out(TownPlan(block_width=bw, landmarks=landmarks, places=picks), cap, "p")
                assert {p.id for p in picks} <= set(town_map["places"]), (size, bw)
                assert "farm" not in landmarks or any("farm" in row for row in tiles), (size, bw)
                # an 11x11 town has no 3x3 block free; its stadium appears once the town grows
                assert "stadium" not in landmarks or size < 13 or any("stadium" in row for row in tiles), (size, bw)
                assert all(0 <= p["tile"][0] < size and 0 <= p["tile"][1] < size for p in town_map["places"].values())


def test_a_full_town_regrows_from_its_saved_plan():
    from backend.towngen.catalog import MAX_PLACES, PLACE_TYPES
    picks = [PlacePlan(id=k, name=label, model=m) for k, (label, m) in list(PLACE_TYPES.items())[:MAX_PLACES]]
    tiles, town_map = towngen.lay_out(TownPlan(places=picks, landmarks=["stadium"]), 1, "p")
    grown, grown_map = towngen.grow({"tiles": tiles, "map": town_map}, 3)  # saved plan with 12 places must reload
    assert len(grown) == 13 and {p.id for p in picks} <= set(grown_map["places"]) and any("stadium" in r for r in grown)


def test_styles_pick_the_buildings_at_every_size():
    from backend.towngen.catalog import HOUSES
    for size in (11, 13, 17, 21, 25, 31):
        for style in ("suburbs", "village"):
            plan = TownPlan(size=size, style=style)
            tiles, town_map = build(plan)
            kinds = {k for row in tiles for k in row}
            assert not kinds & (set(TALL) | set(MID)), (size, style)  # never a tower or an apartment block
            assert kinds & set(HOUSES) and problems(tiles, town_map, dense_core=False) == [], (size, style)
            assert town_map["style"] == style
        tiles, _ = build(TownPlan(size=size, style="city"))
        assert {k for row in tiles for k in row} & set(TALL), size  # a city has towers even when small


def test_a_village_is_greener_than_a_town():
    count = lambda plan: sum("/" in k for row in build(plan)[0] for k in row)
    assert count(TownPlan(size=21, style="village", greenery="lots")) < count(TownPlan(size=21, style="town", greenery="less"))


def test_the_users_look_picks_win_and_reach_the_map(monkeypatch):
    fake_model(monkeypatch, {"name": "Frost Hollow", "landscape": "green", "style": "city", "greenery": "less"})
    made = towngen.generate_town("a winter village", look={"landscape": "snowy", "style": "village", "greenery": None})
    assert (made["plan"]["landscape"], made["plan"]["style"], made["plan"]["greenery"]) == ("snowy", "village", "less")
    assert made["map"]["landscape"] == "snowy" and not {k for row in made["tiles"] for k in row} & set(TALL)


def test_a_classic_revision_hands_the_model_its_plan(monkeypatch):
    fake_model(monkeypatch, {"name": "Dune Town", "landscape": "desert", "style": "town"})
    made = towngen.generate_town("a desert town")
    seen = {}

    def model(model, system, message, **k):
        seen.update(json.loads(message))
        return json.dumps({"name": "Dune Town", "landscape": "desert", "style": "suburbs"})
    monkeypatch.setattr(towngen, "complete", model)
    revised = towngen.generate_town("a desert town", revision={"tiles": made["tiles"], "map": made["map"], "feedback": "no tall buildings"})
    shown = seen["your_previous_town"]
    assert shown["landscape"] == "desert" and shown["style"] == "town" and "rows" not in shown
    assert seen["requested_changes"] == "no tall buildings" and revised["plan"]["style"] == "suburbs"


def test_growth_keeps_the_look(monkeypatch):
    fake_model(monkeypatch, {"name": "Quiet Oaks", "landscape": "autumn", "style": "suburbs"})
    made = towngen.generate_town("leafy suburb")
    tiles, town_map = towngen.grow({"tiles": made["tiles"], "map": made["map"]}, 9)
    assert len(tiles) == 21 and town_map["landscape"] == "autumn" and not {k for row in tiles for k in row} & set(TALL)


def _spread(slots):
    """Average distance of the home plots from their own middle: small = side by side."""
    xs = [(s["block"][0] + s["block"][2]) / 2 for s in slots]
    ys = [(s["block"][1] + s["block"][3]) / 2 for s in slots]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    return sum(abs(x - mx) + abs(y - my) for x, y in zip(xs, ys)) / len(xs)


def test_homes_spread_evenly_unless_the_user_asks_for_them_together_or_in_groups():
    assert TownPlan().homes == "spread"
    # Up to 16 homes: at 24 the plots fill nearly the whole outer ring, so together can only wrap around it
    for cap, size in towngen.TIERS[1:-1]:
        even = build(TownPlan(size=size, home_slots=cap))[1]["home_slots"]
        for homes in ("together", "groups"):
            tiles, town_map = build(TownPlan(size=size, home_slots=cap, homes=homes))
            assert len(town_map["home_slots"]) == cap
            assert problems(tiles, town_map, homes_needed=cap, homes=homes) == [], (size, homes)
        together = build(TownPlan(size=size, home_slots=cap, homes="together"))
        assert _spread(together[1]["home_slots"]) < _spread(even) * 0.75, size
        assert problems(*together, homes_needed=cap), "bunched homes still fail the default (even) rule"


def test_the_model_can_place_homes_but_not_size_the_town():
    from backend.towngen.prompt import planner_system_prompt
    system = planner_system_prompt()
    assert '"homes"' in system and '"home_slots"' not in system and '"size"' not in system


def test_two_places_never_share_a_tile():
    """spread() used to pick the same lot twice when a town had nearly as many places as lots (86 of 594 towns)."""
    from collections import Counter
    for size in range(11, 32, 2):
        for n in range(1, 13):
            for seed in range(4):
                plan = TownPlan(size=size, name=f"T{seed}",
                                places=[PlacePlan(id=f"p{i}", name=f"P{i}", model=(SMALL + MID)[i]) for i in range(n)])
                tiles, town_map = build(plan)
                counts = Counter(tuple(p["tile"]) for p in town_map["places"].values())
                assert max(counts.values()) == 1, (size, n, seed)


def test_a_map_with_two_names_on_one_tile_is_rejected():
    import pytest
    from pydantic import ValidationError
    from backend.models.api import TownMap
    one = {"name": "Café", "tile": [2, 1], "door": [1, 1]}
    TownMap(places={"cafe": one, "gym": {**one, "tile": [3, 1]}})
    with pytest.raises(ValidationError, match="share tile"):
        TownMap(places={"cafe": one, "gym": {**one, "name": "Gym"}})
    assert problems([["road"] * 11] * 11, {"places": {"a": one, "b": one}})[0].startswith("places a and b share tile")
