"""Town maps. Layout lives in three places (see migration 20260926000006):

- `towns.tiles[y][x]`: what's on each tile (road, park, pond, tree, path, stadium, farm, home, driveway, yard,
  lot = frontend fills it procedurally, garden/picnic/plaza/patio/oak/fountain/water/bench-n|s|e|w = small decorative scenes,
  sand and bridge (walkable), forest/lake/rocks/campfire (drawn towns, backend/towngen/freeform.py),
  or an explicit building model key).
- `towns.map.places`: named destinations, {"cafe": {"name", "tile": [x, y], "door": [x, y]}}.
- `town_members.house_x/house_y` + `.home` ({model, driveway, door, block}): each person's house.

Building ids are place ids ("cafe") and `house:{user_id}`. Doors are where characters stand when visiting.
"""

WALKABLE = {"road", "park", "path", "sand", "bridge"}

# Place ids agents know by type. A town with no places yet gets these (no coordinates) so agents still have
# somewhere to go; any other id in towns.map.places is just type "place".
PLACE_TYPES = {"library": "library", "university": "university", "gym": "gym", "cafe": "cafe", "market": "market", "park": "park", "downtown": "square"}


def house_building_id(user_id: str) -> str:
    return f"house:{user_id}"


def buildings(town_map: dict | None, members: list[dict]) -> list[dict]:
    """Everywhere a character can go, with its tile (x, y) and door. Coordinates are None when unknown."""
    places = (town_map or {}).get("places") or {}
    out = [
        {"id": pid, "type": PLACE_TYPES.get(pid, "place"), "name": p.get("name"),
         "x": p["tile"][0], "y": p["tile"][1], "door": p.get("door")}
        for pid, p in places.items()
    ] or [{"id": pid, "type": t, "name": None, "x": None, "y": None, "door": None} for pid, t in PLACE_TYPES.items()]
    out += [
        {"id": house_building_id(m["user_id"]), "type": "house",
         "name": (m.get("home") or {}).get("name")
         or (m.get("name") or (m.get("profiles") or {}).get("display_name") or "").strip() or None,
         "x": m.get("house_x"), "y": m.get("house_y"), "door": (m.get("home") or {}).get("door")}
        for m in members
    ]
    return out


def in_bounds(tiles: list, x: float, y: float) -> bool:
    """Is (x, y) on the map? Fractional coordinates are fine (someone mid-walk between tiles)."""
    if not tiles:
        return x >= 0 and y >= 0
    return 0 <= y < len(tiles) and 0 <= x < len(tiles[int(y)])


if __name__ == "__main__":
    town_map = {"places": {"cafe": {"name": "Bean There Café", "tile": [2, 1], "door": [1, 1]}}}
    members = [{"user_id": "u1", "house_x": 0, "house_y": 2, "home": {"door": [1, 2]}}]
    bs = {b["id"]: b for b in buildings(town_map, members)}
    assert set(bs) == {"cafe", "house:u1"}
    assert (bs["cafe"]["x"], bs["cafe"]["y"], bs["cafe"]["door"]) == (2, 1, [1, 1])
    assert bs["house:u1"]["door"] == [1, 2]
    assert len(buildings({}, [])) == len(PLACE_TYPES) and buildings(None, [])[0]["x"] is None
    tiles = [["road", "park", "lot"], ["lot", "road", "lot"]]
    assert in_bounds(tiles, 2.5, 1.9) and not in_bounds(tiles, 3, 0) and not in_bounds(tiles, 0, 2)
    print("town_map ok")
