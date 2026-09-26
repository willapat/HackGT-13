"""Write the frontend's hard-coded 12x12 city into a town's `tiles`, and put the demo cast in their houses.

    python3 -m backend.seed_demo_map              # DEMO_TOWN_ID from .env
    python3 -m backend.seed_demo_map <town_id>
    python3 -m backend.seed_demo_map --dry-run    # print the tiles, write nothing

Mirrors buildCity() / PLACES / FRIENDS in frontend/main.js so both draw the same town.
"""

import json
import math
import sys

N, ROADS = 12, (2, 6, 10)
PLACES = {"library": (3, 1), "gym": (5, 1), "cafe": (7, 3), "market": (9, 5), "downtown": (7, 5)}
# Demo role → (house tile, house model key); roles match demo.ROLES and main.js FRIENDS.
HOUSES = {
    "maya": ((1, 3), "house-c"),
    "jordan": ((3, 5), "house-h"),
    "sam": ((5, 7), "house-k"),
    "priya": ((11, 7), "house-n"),
    "leo": ((1, 9), "house-r"),
}
TREES = {(9, 7), (7, 9), (9, 9), (8, 7)}
SKYSCRAPERS = [f"skyscraper-{c}" for c in "abcde"]
COMMERCIAL = [f"commercial-{c}" for c in "abcdefghijklmn"]
FILLER_HOUSES = [f"house-{c}" for c in "abcdefghijklmnopqrstu"]


def demo_tiles() -> list[list[str]]:
    fixed = {xy: pid for pid, xy in PLACES.items()} | {xy: model for xy, model in HOUSES.values()}
    tiles = []
    for y in range(N):
        row = []
        for x in range(N):
            if x in ROADS or y in ROADS:
                row.append("road")
            elif 7 <= x <= 9 and 7 <= y <= 9:
                row.append("tree" if (x, y) in TREES else "park")
            elif (x, y) in fixed:
                row.append(fixed[(x, y)])
            else:  # same deterministic filler as main.js: taller buildings toward the centre
                d = math.hypot(x - 5.5, y - 5.5)
                pool = SKYSCRAPERS if d < 3.2 else COMMERCIAL if d < 5.3 else FILLER_HOUSES
                row.append(pool[(x * 7 + y * 13 + x * y) % len(pool)])
        tiles.append(row)
    return tiles


def seed(town_id: str) -> None:
    from backend.db import get_client, now_iso
    from backend.routes.demo import _town_members, cast_roles, primary_roles

    db = get_client()
    db.table("towns").update({"tiles": demo_tiles()}).eq("id", town_id).execute()
    for user_id, role in primary_roles(cast_roles(_town_members(db, town_id))).items():
        (x, y), _ = HOUSES[role]
        db.table("town_members").update({"house_x": x, "house_y": y, "updated_at": now_iso()}).eq(
            "town_id", town_id).eq("user_id", user_id).execute()
        db.table("agents").update({"x": x, "y": y}).eq("town_id", town_id).eq("user_id", user_id).execute()
        print(f"{role:7} {user_id} house at ({x}, {y})")
    print(f"town {town_id}: tiles written ({N}x{N})")


if __name__ == "__main__":
    args = sys.argv[1:]
    tiles = demo_tiles()
    from backend.town_map import place_positions

    assert place_positions(tiles) == {**PLACES, "park": (7, 7)}, place_positions(tiles)
    if "--dry-run" in args:
        print(json.dumps(tiles))
        sys.exit(0)
    from backend.config import settings

    target = next((a for a in args if not a.startswith("-")), settings.DEMO_TOWN_ID)
    if not target:
        sys.exit("pass a town id or set DEMO_TOWN_ID")
    seed(target)
