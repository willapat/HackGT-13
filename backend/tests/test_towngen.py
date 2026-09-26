import json

import backend.towngen as towngen
from backend.models.api import TownCreate
from backend.towngen.catalog import MID, SMALL, TALL, TownPlan
from backend.towngen.layout import build, problems


def test_rules_hold_for_every_size_and_option():
    for size in range(11, 32, 2):
        for bw in (2, 3, 4):
            for landmark in ("none", "farm", "stadium"):
                for outer_park in (True, False):
                    tiles, town_map = build(TownPlan(size=size, block_width=bw, landmark=landmark, outer_park=outer_park))
                    assert problems(tiles, town_map) == [], (size, bw, landmark, outer_park)
                    TownCreate(name="x", tiles=tiles, map=town_map, me={"name": "Me", "color": "#ff3b30"})  # API accepts it


def test_outer_park_is_symmetric_with_water_in_the_middle():
    tiles, town_map = build(TownPlan(size=13, outer_park=True))
    assert "outerpark" in town_map["places"]
    park = [(i, j) for j in range(len(tiles)) for i in range(len(tiles)) if tiles[j][i] in ("oak", "water") or tiles[j][i].startswith("bench")]
    x0, y0 = min(p[0] for p in park), min(p[1] for p in park)
    grid = [[tiles[y0 + j][x0 + i] for i in range(3)] for j in range(3)]
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
