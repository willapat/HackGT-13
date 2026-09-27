import json

import backend.towngen as towngen
from backend.towngen import freeform
from backend.towngen.catalog import HOUSES, SMALL, TownPlan

# A cabin retreat as the model might draw it: forest, a lake, trails, a campfire, cabins, no roads
CABINS = [
    "TTTTTTTTTTT",
    "TTh==H==hTT",
    "T==.....==T",
    "T=.~~~~~.=T",
    "TH.~~~~~.HT",
    "T=.~~~~~.=T",
    "T==..c..==T",
    "TTb==H==bTT",
    "TTTT=T=TTTT",
    "TTTT=b=TTTT",
    "TTTTTTTTTTT",
]


def cabin_plan(**extra) -> TownPlan:
    return TownPlan.model_validate({
        "name": "Pine Hollow", "theme": "cabins by a lake", "rows": CABINS, "outskirts": "T",
        "places": [{"id": "lodge", "name": "Pine Lodge", "model": HOUSES[0], "at": [5, 9]},
                   {"id": "campfire", "name": "Ember Circle", "model": None, "at": [5, 6]}],
        "houses": [HOUSES[1], HOUSES[2]], **extra})


def kinds(tiles):
    return {k for row in tiles for k in row}


def test_a_drawn_cabin_retreat_stays_a_cabin_retreat():
    tiles, town_map = freeform.build(cabin_plan(), members=1, min_size=11)
    assert freeform.problems(tiles, town_map, homes_needed=1) == []
    assert "road" not in kinds(tiles) and {"forest", "lake", "campfire", "path"} <= kinds(tiles)
    assert town_map["drawn"] and town_map["places"]["lodge"]["tile"] == [5, 9]
    assert town_map["places"]["campfire"] == {"name": "Ember Circle", "tile": [5, 6], "door": [5, 6]} or \
        tiles[6][5] == "campfire"  # an outdoor spot keeps its tile as drawn
    slots = town_map["home_slots"]
    assert len(slots) == freeform.slot_cap(11) and all(s["model"] in (HOUSES[1], HOUSES[2]) for s in slots)
    assert sum(tiles[s["house"][1]][s["house"][0]] == "garden" for s in slots) == len(slots)  # unclaimed plots
    assert all(k in HOUSES for k in (h["model"] for h in town_map["background_homes"]["homes"]))


def test_the_model_home_spots_are_used_first():
    _, town_map = freeform.build(cabin_plan(), members=1, min_size=11)
    spots = {(x, y) for y, row in enumerate(CABINS) for x, ch in enumerate(row) if ch == "H"}
    houses = {tuple(s["house"]) for s in town_map["home_slots"]}
    assert houses <= spots and len(houses) == freeform.slot_cap(11)


def test_a_walled_in_place_gets_a_trail():
    rows = ["." * 11] + ["TTTTTTTTTTT"] * 4 + ["TTTTTbTTTTT"] + ["TTTTTTTTTTT"] * 4 + ["." * 11]
    plan = TownPlan.model_validate({"name": "Deep Woods", "rows": rows,
                                    "places": [{"id": "cabin", "name": "Hermit Cabin", "model": HOUSES[0], "at": [5, 5]}]})
    tiles, town_map = freeform.build(plan, members=2, min_size=11)
    assert freeform.problems(tiles, town_map, homes_needed=2) == []
    assert "path" in kinds(tiles) and town_map["places"]["cabin"]["tile"] == [5, 5]  # a trail cut through the forest to it


def test_a_small_drawing_is_centred_and_padded_with_its_outskirts():
    plan = TownPlan.model_validate({"name": "Tiny", "rows": ["=====", "=b.H=", "====="], "outskirts": "T",
                                    "places": [{"id": "cafe", "name": "Café", "model": SMALL[9], "at": [1, 1]}]})
    tiles, town_map = freeform.build(plan, members=1, min_size=11)
    assert len(tiles) == 11 and tiles[0][0] == "forest"
    assert town_map["places"]["cafe"]["tile"] == [4, 5]  # (1, 1) shifted by the (3, 4) offset
    assert freeform.problems(tiles, town_map) == []


def test_user_picks_win_and_keep_where_the_model_drew_them(monkeypatch):
    drawn = {"name": "Pine Hollow", "rows": CABINS + [], "outskirts": "T",
             "places": [{"id": "library", "name": "Book Nook", "model": SMALL[10], "at": [8, 7]},
                        {"id": "hot_tub", "name": "Hot Tub", "model": SMALL[0], "at": [2, 7]}]}
    drawn["rows"] = [r.replace("c", "S") for r in CABINS]  # draws a (broken) stadium the user didn't ask for
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(drawn))
    made = towngen.generate_town("cabins", places=["library"], custom=["Hot Tub"], landmarks=["farm"])
    places, tiles = made["map"]["places"], made["tiles"]
    assert made["map"]["drawn"] and set(places) == {"library", "hot_tub"}
    assert places["library"]["tile"] == [8, 7] and places["library"]["name"] == "Library"
    assert places["hot_tub"]["tile"] == [2, 7] and places["hot_tub"]["model"] == SMALL[0]
    assert "stadium" not in kinds(tiles) and sum(row.count("farm") for row in tiles) == 4


def test_a_place_named_stadium_gets_a_stadium():
    plan = cabin_plan()
    plan.rows = ["." * 15] * 15
    plan.places = [p for p in plan.places] + [towngen.PlacePlan(id="stadium", name="Big Arena", model=None, at=[7, 7])]
    tiles, town_map = freeform.build(plan, members=1, min_size=15)
    assert sum(row.count("stadium") for row in tiles) == 9 and "stadium" in town_map["landmarks"]
    assert tiles[town_map["places"]["stadium"]["tile"][1]][town_map["places"]["stadium"]["tile"][0]] == "stadium"


def test_an_unusable_drawing_falls_back_to_the_classic_town(monkeypatch):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps({"name": "Atlantis", "rows": ["~" * 11] * 11}))
    made = towngen.generate_town("underwater")
    assert not made["map"].get("drawn") and made["name"] == "Atlantis" and made["tiles"][5][5] == "pond"


def test_a_drawn_town_grows_outward_and_keeps_its_homes(monkeypatch):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(cabin_plan().model_dump()))
    made = towngen.generate_town("cabins")
    town = {"tiles": made["tiles"], "map": made["map"]}
    cap = len(town["map"]["home_slots"])
    assert not towngen.needs_to_grow(town, cap) and towngen.needs_to_grow(town, cap + 1)
    tiles, grown = towngen.grow(town, cap + 3)
    k = (len(tiles) - 11) // 2
    assert len(tiles) > 11 and len(grown["home_slots"]) >= cap + 3 and grown["drawn"] and grown["plan"]["name"] == "Pine Hollow"
    old = [[s["house"][0] + k, s["house"][1] + k] for s in town["map"]["home_slots"]]
    assert [s["house"] for s in grown["home_slots"][:cap]] == old  # same homes, first in line, shifted
    assert grown["places"]["lodge"]["tile"] == [5 + k, 9 + k] and tiles[9 + k][5 + k] == HOUSES[0]
    assert freeform.problems(tiles, grown, homes_needed=cap + 3) == []
    assert "forest" in (tiles[0][0], tiles[0][-1], tiles[-1][0], tiles[-1][-1]) or tiles[0][0] == "park"  # outskirts fill the new ring


def test_growth_stops_at_the_largest_size():
    tiles, town_map = freeform.build(cabin_plan(), members=1, min_size=31)
    town = {"tiles": tiles, "map": {**town_map, "plan": cabin_plan().model_dump()}}
    assert not towngen.needs_to_grow(town, 99)


def test_an_approved_preview_is_built_exactly_as_shown_without_the_model(monkeypatch):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(cabin_plan().model_dump()))
    preview = towngen.generate_town("cabins", places=["library"], landmarks=["farm"])

    def no_model(*a, **k):
        raise AssertionError("approving must not call the model")
    monkeypatch.setattr(towngen, "complete", no_model)
    built = towngen.generate_town("cabins", design=preview["plan"])
    assert built["tiles"] == preview["tiles"] and built["map"]["places"] == preview["map"]["places"]
    assert built["map"]["home_slots"] == preview["map"]["home_slots"] and built["plan_source"] == "approved"
    classic = towngen.generate_town("x", design=towngen.generate_town("x")["plan"])  # the classic fallback too
    assert classic["tiles"] == towngen.generate_town("x", design=classic["plan"])["tiles"]


def test_a_revision_shows_the_model_the_built_town_and_the_notes(monkeypatch):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(cabin_plan().model_dump()))
    preview = towngen.generate_town("cabins")
    seen = {}

    def model(model, system, message, **k):
        seen.update(json.loads(message))
        return json.dumps({**cabin_plan().model_dump(), "name": "Pine Hollow Lakeside"})
    monkeypatch.setattr(towngen, "complete", model)
    revised = towngen.generate_town("cabins", revision={"tiles": preview["tiles"], "map": preview["map"], "feedback": "a bigger lake"})
    assert seen["requested_changes"] == "a bigger lake"
    shown = seen["your_previous_town"]
    assert shown["rows"] == freeform.to_rows(preview["tiles"], preview["map"]) and len(shown["rows"]) == len(preview["tiles"])
    assert {p["id"]: p["at"] for p in shown["places"]}["lodge"] == preview["map"]["places"]["lodge"]["tile"]
    assert sum(r.count("H") for r in shown["rows"]) == len(preview["map"]["home_slots"])
    assert revised["name"] == "Pine Hollow Lakeside"


def test_if_the_model_is_down_mid_review_the_town_stays_as_it_was(monkeypatch):
    monkeypatch.setattr(towngen, "complete", lambda *a, **k: json.dumps(cabin_plan().model_dump()))
    preview = towngen.generate_town("cabins")

    def down(*a, **k):
        raise RuntimeError("no key")
    monkeypatch.setattr(towngen, "complete", down)
    kept = towngen.generate_town("cabins", revision={"tiles": preview["tiles"], "map": preview["map"], "feedback": "more trees"})
    assert kept["map"].get("drawn") and kept["name"] == "Pine Hollow" and set(kept["map"]["places"]) == set(preview["map"]["places"])
    assert kept["map"]["places"]["lodge"]["tile"] == preview["map"]["places"]["lodge"]["tile"]


def test_outdoor_places_drawn_on_the_same_spot_get_their_own_tiles():
    from collections import Counter
    plan = cabin_plan(places=[{"id": "dock", "name": "Dock", "model": None, "at": [3, 3]},
                              {"id": "beach", "name": "Beach", "model": None, "at": [3, 3]},
                              {"id": "fire", "name": "Fire Pit", "model": None, "at": [3, 3]}])
    tiles, town_map = freeform.build(plan, 2, 11)
    assert max(Counter(tuple(p["tile"]) for p in town_map["places"].values()).values()) == 1
    assert freeform.problems(tiles, town_map, homes_needed=2) == []
