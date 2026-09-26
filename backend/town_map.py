"""Town maps: `towns.tiles[y][x]` holds asset manifest keys ("road", "park", "house-c", "cafe", ...).

A named place is a tile whose key is a place id below; its grid position is its location.
Houses are `house:{user_id}` at the member's `town_members.house_x/house_y`.
Road pieces, facing, and door tiles are derived by the frontend from the grid, not stored.
"""

PLACE_TYPES = {
    "library": "library",
    "gym": "gym",
    "cafe": "cafe",
    "market": "market",
    "park": "park",
    "downtown": "square",
}


def house_building_id(user_id: str) -> str:
    return f"house:{user_id}"


def place_positions(tiles: list) -> dict[str, tuple[int, int]]:
    """Place id → (x, y) of its first tile, row by row (multi-tile places like the park use their top-left)."""
    out: dict[str, tuple[int, int]] = {}
    for y, row in enumerate(tiles or []):
        for x, key in enumerate(row):
            if key in PLACE_TYPES:
                out.setdefault(key, (x, y))
    return out


def buildings(tiles: list, members: list[dict]) -> list[dict]:
    """Everywhere a character can go: places on this map plus members' houses, with coordinates.

    A town without a map yet gets every place type (x/y None) so agents still have somewhere to go.
    """
    places = place_positions(tiles) if tiles else dict.fromkeys(PLACE_TYPES)
    out = [
        {"id": pid, "type": PLACE_TYPES[pid], "x": xy[0] if xy else None, "y": xy[1] if xy else None}
        for pid, xy in places.items()
    ]
    out += [
        {"id": house_building_id(m["user_id"]), "type": "house", "x": m.get("house_x"), "y": m.get("house_y")}
        for m in members
    ]
    return out


def in_bounds(tiles: list, x: float, y: float) -> bool:
    """Is (x, y) on the map? Fractional coordinates are fine (someone mid-walk between tiles)."""
    if not tiles:
        return x >= 0 and y >= 0
    return 0 <= y < len(tiles) and 0 <= x < len(tiles[int(y)])


if __name__ == "__main__":
    tiles = [["road", "park", "park"], ["cafe", "road", "house-c"]]
    assert place_positions(tiles) == {"park": (1, 0), "cafe": (0, 1)}
    bs = {b["id"]: b for b in buildings(tiles, [{"user_id": "u1", "house_x": 2, "house_y": 1}])}
    assert set(bs) == {"park", "cafe", "house:u1"} and (bs["cafe"]["x"], bs["cafe"]["y"]) == (0, 1)
    assert len(buildings([], [])) == len(PLACE_TYPES)
    assert in_bounds(tiles, 2.5, 1.9) and not in_bounds(tiles, 3, 0) and not in_bounds(tiles, 0, 2)
    print("town_map ok")
