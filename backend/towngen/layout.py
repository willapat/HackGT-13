"""Turns a TownPlan (Gemini's design) into towns.tiles + towns.map. The town rules live here, in code, so they
hold no matter what the model or the user prompt says:

- square, odd-sized grid; roads span the whole map, symmetric around the centre
- a central park (pond in the middle) ringed by the densest, tallest buildings; paths lead in from the roads
- one 2x2 home plot per member the size tier holds (house + driveway to a road + 2 yard tiles), only in the
  outer suburb ring, spread evenly around it
- sparse one-tile background houses (no plot) in the suburbs, never more than 35% of the free street tiles
- a symmetric outer park (water centre, oaks in the corners, benches facing in) when there's room
"""

import math
import random
import zlib

from backend.towngen.catalog import BUILDINGS, HOUSES, MID, SMALL, STADIUM, TALL, TownPlan

MIN_SIZE, MAX_SIZE, LARGE = 11, 31, 17
NEIGHBORS = ((1, 0), (-1, 0), (0, 1), (0, -1))


def grid_size(n: int) -> int:
    n = max(MIN_SIZE, min(MAX_SIZE, n))
    return n if n % 2 else n + 1


def default_palettes(size: int) -> tuple[list[str], list[str]]:
    """Big grids get a tall downtown; small ones stay town-scale."""
    return (TALL, MID) if size >= LARGE else (MID, SMALL)


def build(plan: TownPlan) -> tuple[list[list[str]], dict]:
    # Seeded by the plan, so the same town always builds the same way, but choices look organic, not patterned
    rng = random.Random(zlib.crc32(f"{plan.name}|{plan.theme}|{plan.size}".encode()))
    N = grid_size(plan.size)
    c = N // 2
    pr = 1 if N < 21 else 2  # central park radius: 3x3, or 5x5 on big grids
    # Roads at c +/- d: the first leaves one ring of buildings around the park, then one every block_width+1,
    # stopping while the outer suburb ring is still at least 2 tiles deep (room for 2x2 homes).
    bw = max(plan.block_width, 3) if "stadium" in plan.landmarks else plan.block_width  # a stadium needs 3x3 blocks
    dists = [pr + 2]
    while c - (dists[-1] + bw + 1) >= 2:
        dists.append(dists[-1] + bw + 1)
    roads = sorted({c - d for d in dists} | {c + d for d in dists})
    edge = dists[-1]

    T = [["road" if x in roads or y in roads else "lot" for x in range(N)] for y in range(N)]
    inb = lambda x, y: 0 <= x < N and 0 <= y < N

    def varied(options, x, y, weights=None):
        """A random pick (optionally weighted) that differs from the four tiles around (x, y)."""
        near = {T[y + dy][x + dx] for dx, dy in NEIGHBORS if inb(x + dx, y + dy)}
        fresh = [(o, w) for o, w in zip(options, weights or [1] * len(options)) if o not in near] or list(zip(options, weights or [1] * len(options)))
        return rng.choices([o for o, _ in fresh], [w for _, w in fresh])[0]

    def spread(items, k):
        """k items spread along `items` with jitter: even overall, never a regular rhythm."""
        if not k:
            return []
        step = len(items) / k
        return [items[min(len(items) - 1, int(i * step + rng.random() * step))] for i in range(k)]
    road = lambda x, y: inb(x, y) and T[y][x] == "road"
    outer = lambda x, y: max(abs(x - c), abs(y - c)) > edge
    core = lambda x, y: max(abs(x - c), abs(y - c)) < dists[0]
    free = lambda x, y: inb(x, y) and T[y][x] == "lot"
    frontage = lambda x, y: any(road(x + dx, y + dy) for dx, dy in NEIGHBORS)
    road_next_to = lambda x, y: next(([x + dx, y + dy] for dx, dy in NEIGHBORS if road(x + dx, y + dy)), None)
    angle = lambda x, y: math.atan2(y - c, x - c)

    # ---- Central park, with paths in from the north and south roads
    for y in range(c - pr, c + pr + 1):
        for x in range(c - pr, c + pr + 1):
            T[y][x] = "tree" if abs(x - c) == pr and abs(y - c) == pr else "park"
    T[c][c] = "pond"
    T[c - pr - 1][c] = T[c + pr + 1][c] = "path"
    places = {"park": {"name": plan.park_name, "tile": [c, c - pr], "door": [c, c - pr - 1]}}

    # ---- Home plots: every 2x2 in the suburbs whose driveway meets a road in line with the house...
    cands = []
    for y0 in range(N - 1):
        for x0 in range(N - 1):
            sq = [(x0, y0), (x0 + 1, y0), (x0, y0 + 1), (x0 + 1, y0 + 1)]
            if not all(free(*t) and outer(*t) for t in sq):
                continue
            for dx, dy in sq:
                door = road_next_to(dx, dy)
                house = door and (2 * dx - door[0], 2 * dy - door[1])
                if door and house in sq:
                    cands.append({"house": list(house), "driveway": [dx, dy], "door": door, "block": [x0, y0, x0 + 1, y0 + 1]})
                    break
    # ...then pick one nearest each of n evenly spaced angles around the centre, without overlaps
    tiles_of = lambda b: {(x, y) for x in range(b[0], b[2] + 1) for y in range(b[1], b[3] + 1)}
    centre_of = lambda s: ((s["block"][0] + s["block"][2]) / 2, (s["block"][1] + s["block"][3]) / 2)
    gap = lambda a, b: abs((a - b + math.pi) % (2 * math.pi) - math.pi)
    n = max(1, plan.home_slots)
    slots, used = [], set()
    for k in range(n):
        target = -math.pi + (k + 0.5) * 2 * math.pi / n
        options = [s for s in cands if not tiles_of(s["block"]) & used]
        if not options:
            break
        s = min(options, key=lambda s: gap(angle(*centre_of(s)), target))
        s["model"] = rng.choice(HOUSES)
        slots.append(s)
        used |= tiles_of(s["block"])
    for s in slots:  # unclaimed plots show as garden until someone joins (routes/towns.py claim_home_slot)
        for x, y in tiles_of(s["block"]):
            T[y][x] = "garden"

    # ---- Landmarks the plan asks for come before the optional outer park, so they always get room first
    landmarks = {}
    if "farm" in plan.landmarks:
        spots = [(x0, y0) for y0 in range(N - 1) for x0 in range(N - 1)
                 if all(free(x, y) and outer(x, y) for x in (x0, x0 + 1) for y in (y0, y0 + 1))]
        if spots:
            x0, y0 = max(spots, key=lambda p: abs(p[0] + 0.5 - c) + abs(p[1] + 0.5 - c))  # a corner
            for x in (x0, x0 + 1):
                for y in (y0, y0 + 1):
                    T[y][x] = "farm"
    if "stadium" in plan.landmarks:  # a whole 3x3 block: in the city's middle ring if there is one, else the suburbs
        square = lambda x0, y0: [(x, y) for x in range(x0, x0 + 3) for y in range(y0, y0 + 3)]
        middle = [(x0, y0) for y0 in range(N - 2) for x0 in range(N - 2)
                  if all(free(x, y) and not outer(x, y) and not core(x, y) for x, y in square(x0, y0))]
        suburb = [(x0, y0) for y0 in range(N - 2) for x0 in range(N - 2) if all(free(x, y) and outer(x, y) for x, y in square(x0, y0))]
        spot = middle[len(middle) // 2] if middle else (max(suburb, key=lambda p: abs(p[0] + 1 - c) + abs(p[1] + 1 - c)) if suburb else None)
        if spot:
            for x, y in square(*spot):
                T[y][x] = "stadium"
            landmarks["stadium"] = {"model": STADIUM}

    # ---- Outer park: a symmetric 3x3 in the suburbs, as far from the homes as possible
    if plan.outer_park:
        best = None
        for y0 in range(N - 2):
            for x0 in range(N - 2):
                sq = [(x0 + i, y0 + j) for j in range(3) for i in range(3)]
                if not all(free(*t) and outer(*t) for t in sq):
                    continue
                mids = [(x0 + 1, y0), (x0 + 1, y0 + 2), (x0, y0 + 1), (x0 + 2, y0 + 1)]
                entry = next(((m, road_next_to(*m)) for m in mids if road_next_to(*m)), None)
                if not entry:
                    continue
                room = min((abs(x0 + 1 - centre_of(s)[0]) + abs(y0 + 1 - centre_of(s)[1]) for s in slots), default=0)
                if best is None or room > best[0]:
                    best = (room, x0, y0, entry)
        if best:
            _, x0, y0, (tile, door) = best
            for (i, j), k in {(0, 0): "oak", (1, 0): "bench-s", (2, 0): "oak", (0, 1): "bench-e", (1, 1): "water",
                              (2, 1): "bench-w", (0, 2): "oak", (1, 2): "bench-n", (2, 2): "oak"}.items():
                T[y0 + j][x0 + i] = k
            places["outerpark"] = {"name": plan.outer_park_name, "tile": list(tile), "door": door}

    # ---- Named places on street-facing lots in the city, spread around it (overflowing into the suburbs)
    inner_front = sorted([(x, y) for y in range(N) for x in range(N) if free(x, y) and not outer(x, y) and frontage(x, y)],
                         key=lambda t: angle(*t))
    wanted = [p for p in plan.places if p.id not in places and p.model in BUILDINGS]
    # More places than city lots: the rest go on street-facing suburb lots, so every requested place is built
    extra = sorted([(x, y) for y in range(N) for x in range(N) if free(x, y) and outer(x, y) and frontage(x, y)], key=lambda t: angle(*t))
    spots = spread(inner_front, min(len(wanted), len(inner_front))) + spread(extra, max(0, len(wanted) - len(inner_front)))
    for p, (x, y) in zip(wanted, spots):
        T[y][x] = p.model
        places[p.id] = {"name": p.name, "model": p.model, "tile": [x, y], "door": road_next_to(x, y)}

    # ---- The rest of the city: every street-facing lot gets a building; tallest palette around the park
    core_pal, mid_pal = default_palettes(N)
    core_pal = [m for m in plan.core_models if m in BUILDINGS] or core_pal
    mid_pal = [m for m in plan.middle_models if m in BUILDINGS] or mid_pal
    for x, y in [(x, y) for y in range(N) for x in range(N) if free(x, y) and not outer(x, y) and frontage(x, y)]:
        T[y][x] = varied(core_pal if max(abs(x - c), abs(y - c)) <= dists[0] + 1 else mid_pal, x, y)
    # (inner lots with no street stay "lot": the frontend makes them courtyards)

    # ---- Suburbs: a few background houses spread along the streets, decor everywhere else
    street = sorted([(x, y) for y in range(N) for x in range(N) if free(x, y) and outer(x, y) and frontage(x, y)],
                    key=lambda t: angle(*t))
    k = round(min(0.35, max(0.0, plan.background_density)) * len(street))
    pick = set(spread(street, k))
    homes = []
    for x, y in sorted(pick):
        T[y][x] = varied(HOUSES, x, y)
        homes.append({"model": T[y][x], "house": [x, y]})
    # Street-side scenes: the plan's decor, plus trees, scattered at random (no two alike side by side)
    decor = list(dict.fromkeys(plan.decor or ["garden"])) + ["tree", "oak"]
    for x, y in sorted(t for t in street if t not in pick):
        T[y][x] = varied(decor, x, y)
    # Behind the street: mostly trees and gardens, with the odd bushy lot, picnic spot or big oak
    for x, y in [(x, y) for y in range(N) for x in range(N) if free(x, y) and outer(x, y)]:
        T[y][x] = varied(["tree", "garden", "lot", "picnic", "oak"], x, y, weights=[4, 4, 2, 1, 1])

    town_map = {"places": places, "home_slots": slots, "background_homes": {"color": plan.background_color, "homes": homes}}
    if landmarks:
        town_map["landmarks"] = landmarks
    if plan.theme:
        town_map["theme"] = plan.theme
    return T, town_map


def problems(tiles: list[list[str]], town_map: dict, homes_needed: int = 1) -> list[str]:
    """Checks the town rules on a built town. Empty list = OK. Used by tests and after every build."""
    out = []
    N = len(tiles)
    c = N // 2
    if any(len(r) != N for r in tiles) or N % 2 == 0:
        out.append("grid must be square and odd-sized")
    if tiles[c][c] != "pond":
        out.append("central park needs a pond at the centre")
    walk = {(x, y) for y in range(N) for x in range(N) if tiles[y][x] in ("road", "park", "path")}
    roads_at = [i for i in range(N) if all(k == "road" for k in tiles[i])]
    edge = c - min(roads_at) if roads_at else 0
    outer = lambda x, y: max(abs(x - c), abs(y - c)) > edge
    slots = town_map.get("home_slots") or []
    if len(slots) < homes_needed:
        out.append(f"only {len(slots)} home plots, need {homes_needed}")
    for s in slots:
        b, (hx, hy), (dx, dy), door = s["block"], s["house"], s["driveway"], s["door"]
        cells = [(x, y) for x in range(b[0], b[2] + 1) for y in range(b[1], b[3] + 1)]
        if len(cells) != 4 or not all(outer(*t) for t in cells):
            out.append(f"home plot {b} is not a 2x2 in the suburbs")
        if tuple(door) not in walk or (2 * dx - door[0], 2 * dy - door[1]) != (hx, hy):
            out.append(f"home plot {b}: driveway doesn't lead straight from the house to a road")
    if slots:  # evenly spread: no gap between neighbours bigger than ~2.5x an even share
        angles = sorted(math.atan2((s["block"][1] + s["block"][3]) / 2 - c, (s["block"][0] + s["block"][2]) / 2 - c) for s in slots)
        gaps = [b - a for a, b in zip(angles, angles[1:])] + [angles[0] + 2 * math.pi - angles[-1]]
        if max(gaps) > 2.5 * 2 * math.pi / len(slots):
            out.append("home plots are bunched up")
    building = lambda k: "/" in k
    inner = [tiles[y][x] for y in range(N) for x in range(N) if not outer(x, y) and tiles[y][x] != "road"]
    suburb = [tiles[y][x] for y in range(N) for x in range(N) if outer(x, y) and tiles[y][x] != "road"]
    if suburb and sum(map(building, inner)) / len(inner) <= sum(map(building, suburb)) / len(suburb):
        out.append("the city centre isn't denser than the suburbs")
    street = [(x, y) for y in range(N) for x in range(N) if outer(x, y) and tiles[y][x] != "road"
              and any((x + a, y + b) in walk and tiles[y + b][x + a] == "road" for a, b in NEIGHBORS if 0 <= x + a < N and 0 <= y + b < N)]
    bg = town_map.get("background_homes", {}).get("homes", [])
    if street and len(bg) > 0.35 * len(street):
        out.append("too many background houses")
    # Everyone can reach every place and home from the roads
    if walk:
        seen, todo = set(), [next(iter(walk))]
        while todo:
            p = todo.pop()
            if p in seen:
                continue
            seen.add(p)
            todo += [(p[0] + a, p[1] + b) for a, b in NEIGHBORS if (p[0] + a, p[1] + b) in walk]
        for pid, p in town_map.get("places", {}).items():
            if tuple(p["door"]) not in seen:
                out.append(f"place {pid} can't be reached")
    return out
