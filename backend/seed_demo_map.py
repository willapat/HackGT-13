"""Write the frontend's hard-coded 17x17 city into a town: tiles, map (places + scenery), and each demo
character's home and look.

    python3 -m backend.seed_demo_map              # DEMO_TOWN_ID from .env
    python3 -m backend.seed_demo_map <town_id>
    python3 -m backend.seed_demo_map --dry-run    # print what would be written, write nothing

Copied from the demo constants in town/js/layout.js (N, ROADS, inPark, TREES, STADIUM, FARM,
PLACES, FRIENDS). "lot" tiles are filled by buildCity()'s own zone rules, exactly as the hard-coded
version does today. Model keys are asset paths without "assets/" and ".glb".
"""

import json
import sys

N, ROADS, CENTER = 17, (2, 6, 10, 14), 8
SP, SUB = "simplepoly-city/", "city-kit-suburban/"


def block(x0: int, x1: int, y0: int, y1: int) -> list[tuple[int, int]]:
    return [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]


PARK = block(7, 9, 7, 9)
TREES = [(7, 7), (9, 7), (7, 9), (9, 9)]
STADIUM, FARM = block(11, 13, 11, 13), block(0, 1, 15, 16)

TOWN_MAP = {
    "places": {
        "library": {"name": "Library", "model": SP + "building-books-shop", "tile": [3, 1], "door": [3, 2]},
        "gym": {"name": "Boulder Gym", "model": SP + "building-auto-service", "tile": [5, 1], "door": [5, 2]},
        "cafe": {"name": "Bean There Café", "model": SP + "building-coffee-shop", "tile": [7, 3], "door": [6, 3]},
        "market": {"name": "Market", "model": SP + "building-super-market", "tile": [9, 5], "door": [9, 6]},
        "park": {"name": "Central Park", "tile": [8, 7], "door": [8, 6]},
        "downtown": {"name": "downtown", "tile": [7, 5], "door": [7, 6]},
    },
    "landmarks": {"stadium": {"model": SP + "building-stadium"}},
}

# Demo role → home (house tile + town_members.home), color in town (town_members.color) and look
# (profiles.avatar). Roles match demo.ROLES.
CAST = {
    "maya": {"house": (0, 4), "home": {"model": SP + "building-house-01-color01", "driveway": [1, 4], "door": [2, 4], "block": [0, 3, 1, 5]},
             "avatar": {"character": "character-female-a", "color": "#ff3b30"}},
    "jordan": {"house": (12, 0), "home": {"model": SUB + "building-type-k", "driveway": [12, 1], "door": [12, 2], "block": [11, 0, 13, 1]},
               "avatar": {"character": "character-male-b", "color": "#ff2d95"}},
    "sam": {"house": (4, 16), "home": {"model": SP + "building-house-03-color01", "driveway": [4, 15], "door": [4, 14], "block": [3, 15, 5, 16]},
            "avatar": {"character": "character-male-d", "color": "#ffd60a"}},
    "priya": {"house": (16, 8), "home": {"model": SUB + "building-type-r", "driveway": [15, 8], "door": [14, 8], "block": [15, 7, 16, 9]},
              "avatar": {"character": "character-female-c", "color": "#ff9500"}},
    "leo": {"house": (0, 12), "home": {"model": SP + "building-house-02-color01", "driveway": [1, 12], "door": [2, 12], "block": [0, 11, 1, 13]},
            "avatar": {"character": "character-male-f", "color": "#a24bff"}},
}


def demo_tiles() -> list[list[str]]:
    kind: dict[tuple[int, int], str] = {}
    for xy in PARK:
        kind[xy] = "park"
    kind[(CENTER, CENTER)] = "pond"
    for xy in TREES:
        kind[xy] = "tree"
    for xy in STADIUM:
        kind[xy] = "stadium"
    for xy in FARM:
        kind[xy] = "farm"
    for c in CAST.values():
        x0, y0, x1, y1 = c["home"]["block"]
        for xy in block(x0, x1, y0, y1):
            kind[xy] = "yard"
        kind[tuple(c["home"]["driveway"])] = "driveway"
        kind[c["house"]] = "home"
    for p in TOWN_MAP["places"].values():
        if "model" in p:
            kind[tuple(p["tile"])] = p["model"]
    return [
        ["road" if x in ROADS or y in ROADS else kind.get((x, y), "lot") for x in range(N)]
        for y in range(N)
    ]


def seed(town_id: str) -> None:
    from backend.calendar_drive import snap_town_to_clock
    from backend.db import get_client, now_iso
    from backend.routes.towns import park_at_home
    from backend.routes.demo import _town_members, cast_roles, primary_roles
    from backend.schedules import local_now

    db = get_client()
    db.table("towns").update({"tiles": demo_tiles(), "map": TOWN_MAP}).eq("id", town_id).execute()
    for user_id, role in primary_roles(cast_roles(_town_members(db, town_id))).items():
        c = CAST[role]
        (hx, hy), (dx, dy) = c["house"], c["home"]["door"]
        db.table("town_members").update(
            {"house_x": hx, "house_y": hy, "home": c["home"], "color": c["avatar"]["color"], "updated_at": now_iso()}
        ).eq("town_id", town_id).eq("user_id", user_id).execute()
        park_at_home(db, town_id, user_id, [hx, hy], [dx, dy], "seed")
        avatar = (db.table("profiles").select("avatar").eq("id", user_id).limit(1).execute().data or [{}])[0].get("avatar") or {}
        db.table("profiles").update({"avatar": {**avatar, **c["avatar"]}}).eq("id", user_id).execute()
        print(f"{role:7} {user_id} house ({hx}, {hy}), door ({dx}, {dy})")
    # Characters stand where the calendar says at the town clock. Postgres rejects any other position.
    snap_town_to_clock(db, town_id, local_now())
    print(f"town {town_id}: {N}x{N} tiles + map written")


if __name__ == "__main__":
    tiles = demo_tiles()
    assert len(tiles) == N and all(len(row) == N for row in tiles)
    assert tiles[3][7] == SP + "building-coffee-shop" and tiles[8][8] == "pond" and tiles[4][0] == "home"
    assert all(tiles[y][x] == "road" for y in range(N) for x in ROADS)
    args = sys.argv[1:]
    if "--dry-run" in args:
        print(json.dumps({"tiles": tiles, "map": TOWN_MAP, "homes": CAST}, indent=1))
        sys.exit(0)
    from backend.config import settings

    target = next((a for a in args if not a.startswith("-")), settings.DEMO_TOWN_ID)
    if not target:
        sys.exit("pass a town id or set DEMO_TOWN_ID")
    seed(target)
