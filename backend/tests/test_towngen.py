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


def test_an_approved_preview_is_built_exactly_as_shown_without_the_model(monkeypatch):
    fake_model(monkeypatch, {"name": "Tidepool", "places": [{"id": "cafe", "name": "Bean There", "model": SMALL[9]}]})
    preview = towngen.generate_town("a seaside town", places=["library"], landmarks=["farm"])

    def no_model(*a, **k):
        raise AssertionError("approving must not call the model")
    monkeypatch.setattr(towngen, "complete", no_model)
    built = towngen.generate_town("a seaside town", design=preview["plan"])
    assert built["tiles"] == preview["tiles"] and built["map"]["places"] == preview["map"]["places"]
    assert built["map"]["home_slots"] == preview["map"]["home_slots"] and built["plan_source"] == "approved"


def test_a_revision_hands_the_model_its_plan_and_the_notes(monkeypatch):
    fake_model(monkeypatch, {"name": "Tidepool", "places": [{"id": "cafe", "name": "Bean There", "model": SMALL[9]}]})
    preview = towngen.generate_town("a seaside town")
    seen = {}

    def model(model, system, message, **k):
        seen.update(json.loads(message))
        return json.dumps({"name": "Tidepool", "landmarks": ["farm"]})
    monkeypatch.setattr(towngen, "complete", model)
    revised = towngen.generate_town("a seaside town", revision={"tiles": preview["tiles"], "map": preview["map"], "feedback": "add a farm"})
    assert seen["requested_changes"] == "add a farm" and seen["your_previous_town"]["name"] == "Tidepool"
    assert seen["your_previous_town"]["places"][0]["name"] == "Bean There" and "size" not in seen["your_previous_town"]
    assert any("farm" in row for row in revised["tiles"])


def test_if_the_model_is_down_mid_review_the_town_stays_as_it_was(monkeypatch):
    fake_model(monkeypatch, {"name": "Tidepool", "places": [{"id": "cafe", "name": "Bean There", "model": SMALL[9]}]})
    preview = towngen.generate_town("a seaside town")

    def down(*a, **k):
        raise RuntimeError("no key")
    monkeypatch.setattr(towngen, "complete", down)
    kept = towngen.generate_town("a seaside town", revision={"tiles": preview["tiles"], "map": preview["map"], "feedback": "more trees"})
    assert kept["name"] == "Tidepool" and kept["tiles"] == preview["tiles"]
