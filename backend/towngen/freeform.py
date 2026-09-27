"""Drawn towns: the model draws the whole map as rows of LEGEND characters, so a town can be a city, a cabin
retreat in the woods, an island or a beach boardwalk. This code keeps only what the app needs to work:

- every named place and every friend's home has a door on walkable ground (road, trail, lawn or sand)
- every door can reach every other door (trails are carved through scenery where the drawing leaves gaps)
- one home plot (house + driveway) per member the town's size holds, spread out, on the model's "H" spots first

Anything else about the look is the model's call. A town that outgrows its plots grows outward (grow): a ring of
its outskirts is added around the old map, roads and trails run out into it, and new plots go there.
"""

import heapq
import random
import zlib

from backend.town_map import shared_tiles
from backend.towngen.catalog import BUILDINGS, HOUSES, MID, SMALL, STADIUM, TALL, TownPlan

LEGEND = {
    "#": "road", "=": "path", ".": "park", "s": "sand", "~": "lake", "T": "forest", "t": "oak", "r": "rocks",
    "f": "garden", "p": "picnic", "c": "campfire", "z": "plaza", "o": "patio", "F": "farm", "S": "stadium",
    "b": "building", "h": "house", "H": "home-spot",
}
WALKABLE = {"road", "path", "park", "sand", "bridge"}
MIN_SIZE, MAX_SIZE = 11, 31
NEIGHBORS = ((1, 0), (-1, 0), (0, 1), (0, -1))
# Tiles a place or a home may be built over (never roads, trails, water, landmarks or other buildings' plots)
BUILDABLE = {"building", "house", "home-spot", "forest", "oak", "rocks", "garden", "picnic", "plaza", "patio", "park", "sand"}
# Cost of carving a trail through each kind when joining up the map; missing = can't carve (landmarks, plots)
CARVE = {"forest": 1, "oak": 1, "rocks": 1, "garden": 1, "picnic": 1, "plaza": 1, "patio": 1, "campfire": 3,
         "home-spot": 1, "building": 4, "lake": 6}
LANDMARK_SIZE = {"farm": 2, "stadium": 3}


def odd(n: int) -> int:
    return n if n % 2 else n + 1


def slot_cap(size: int) -> int:
    """How many home plots a map of this size holds (the largest tier that fits it)."""
    from backend.towngen import TIERS  # avoid a circular import at module load
    return max([cap for cap, s in TIERS if s <= size] or [TIERS[0][0]])


def outskirts_kind(plan: TownPlan) -> str:
    kind = LEGEND.get(plan.outskirts, "park")
    return kind if kind in {"park", "sand", "forest", "lake", "oak", "rocks", "garden"} else "park"


class Map:
    """A square grid of tile kinds plus the town's places, plots and landmarks while it's being built."""

    def __init__(self, T: list[list[str]], rng: random.Random):
        self.T, self.n, self.rng = T, len(T), rng
        self.places: dict[str, dict] = {}
        self.slots: list[dict] = []
        self.protected: set[tuple[int, int]] = set()  # place tiles, plots, landmarks: never carved or built over
        self.main: set[tuple[int, int]] = set()  # the biggest connected walkable area: doors go on it when they can

    def find_main(self) -> None:
        comp, sizes = self.components()
        biggest = max(range(len(sizes)), key=lambda i: sizes[i]) if sizes else None
        self.main = {t for t, i in comp.items() if i == biggest}

    def inb(self, x, y):
        return 0 <= x < self.n and 0 <= y < self.n

    def kind(self, x, y):
        k = self.T[y][x]
        return "building" if "/" in k else k  # a drawn "b"/"h" once it holds its model

    def walkable(self, x, y):
        return self.inb(x, y) and self.T[y][x] in WALKABLE

    def cells(self):
        return ((x, y) for y in range(self.n) for x in range(self.n))

    def door_for(self, x, y):
        """The best walkable neighbour to use as a door: a road, then a trail, sand, then lawn."""
        rank = {"road": 0, "bridge": 0, "path": 1, "sand": 2, "park": 3}
        options = [((x + dx, y + dy) not in self.main, rank[self.T[y + dy][x + dx]], (x + dx, y + dy))
                   for dx, dy in NEIGHBORS if self.walkable(x + dx, y + dy)]
        return min(options)[2] if options else None

    # ---- Landmarks: exactly one complete k x k block each, everything else of that kind becomes lawn
    def settle_landmark(self, kind: str, wanted: bool | None) -> bool:
        k = LANDMARK_SIZE[kind]
        blocks = [[(x, y) for y in range(y0, y0 + k) for x in range(x0, x0 + k)]
                  for y0 in range(self.n - k + 1) for x0 in range(self.n - k + 1)]
        drawn = [b for b in blocks if all(self.T[y][x] == kind for x, y in b)]
        spot = drawn[0] if drawn and wanted is not False else None
        if spot is None and wanted:  # asked for but not drawn (or drawn wrong): find room, away from trails and roads
            room = BUILDABLE - {"building", "house"}
            options = [b for b in blocks if all(self.kind(x, y) in room and (x, y) not in self.protected for x, y in b)]
            if options:
                spot = min(options, key=lambda b: (sum(self.walkable(*t) for t in b), self.rng.random()))
        keep = set(spot or [])
        for x, y in self.cells():
            if self.T[y][x] == kind and (x, y) not in keep:
                self.T[y][x] = "park"
        for x, y in keep:
            self.T[y][x] = kind
        self.protected |= keep
        return bool(keep)

    # ---- Named places: on (or as near as possible to) where the model put them, each with a door
    def add_place(self, pid: str, name: str, model: str | None, at: list[int] | None) -> None:
        target = (min(max(at[0], 0), self.n - 1), min(max(at[1], 0), self.n - 1)) if at else None
        if model is None:  # an outdoor spot (a campfire circle, a beach): the tile stays as drawn
            taken = {tuple(p["tile"]) for p in self.places.values()}
            free = [t for t in self.cells() if t not in taken]  # never a tile another place already has
            if not free:
                return
            tile = min(free, key=lambda t: abs(t[0] - target[0]) + abs(t[1] - target[1])) if target else \
                self.spread_spot([t for t in free if self.walkable(*t)] or free)
            door = tile if self.walkable(*tile) else self.door_for(*tile) or self.make_door(*tile)
            self.protected |= {tile, door}
            self.places[pid] = {"name": name, "tile": list(tile), "door": list(door)}
            return
        pool = [t for t in self.cells() if self.kind(*t) in BUILDABLE and t not in self.protected]
        if not pool:
            return
        if target:  # near where it was drawn, but a tile with a way in (best on the main network) is worth a short move;
            # without one a trail gets cut to it. Prefer tiles drawn as buildings over lawn people walk on.
            def cost(t):
                door = self.door_for(*t)
                return (abs(t[0] - target[0]) + abs(t[1] - target[1]) + (0.5 if self.walkable(*t) else 0)
                        + (3 if door is None else 0 if door in self.main else 2))
            tile = min(pool, key=cost)
        else:
            tile = self.spread_spot([t for t in pool if self.door_for(*t) in self.main] or pool)
        door = self.door_for(*tile) or self.make_door(*tile)
        self.T[tile[1]][tile[0]] = model
        self.protected |= {tile, door}
        self.places[pid] = {"name": name, "model": model, "tile": list(tile), "door": list(door)}

    def make_door(self, x, y):
        """No walkable neighbour: turn one into trail (join_up links it to the rest later)."""
        options = [(x + dx, y + dy) for dx, dy in NEIGHBORS if self.inb(x + dx, y + dy) and (x + dx, y + dy) not in self.protected
                   and self.kind(x + dx, y + dy) in CARVE]
        door = min(options, key=lambda t: CARVE[self.kind(*t)]) if options else (x, y)
        self.T[door[1]][door[0]] = "path"
        return door

    def spread_spot(self, pool=None):
        """A tile far from the places already placed (and from the edge), for places the model didn't position."""
        pool = pool or [t for t in self.cells() if self.walkable(*t)] or list(self.cells())
        taken = [tuple(p["tile"]) for p in self.places.values()]
        c = self.n // 2
        score = lambda t: (min((abs(t[0] - a) + abs(t[1] - b) for a, b in taken), default=0)
                           - 0.3 * (abs(t[0] - c) + abs(t[1] - c)) + self.rng.random())
        return max(pool, key=score)

    # ---- Friends' home plots: a house and a driveway leading straight to walkable ground
    def add_slots(self, want: int, house_models: list[str], allowed=None, network_only: bool = False) -> int:
        """`allowed(house)` limits where houses may go; `network_only` = driveways meet a road or trail, never lawn
        (composed towns, whose network is built on purpose)."""
        homeable = lambda x, y: self.inb(x, y) and self.kind(x, y) in BUILDABLE - {"building", "house"} and (x, y) not in self.protected
        # A driveway may also sit on a trail (join_up then routes the trail around it): the model often draws its
        # home spots right beside one
        drivable = lambda x, y: homeable(x, y) or (not network_only and self.inb(x, y) and self.T[y][x] == "path" and (x, y) not in self.protected)
        door_ok = lambda x, y: self.walkable(x, y) and (not network_only or self.T[y][x] in ("road", "path", "bridge"))
        cands = []
        for x, y in self.cells():
            if not homeable(x, y) or (allowed and not allowed((x, y))):
                continue
            for dx, dy in NEIGHBORS:
                d, w = (x + dx, y + dy), (x + 2 * dx, y + 2 * dy)
                if drivable(*d) and door_ok(*w) and w not in self.protected:
                    cands.append(((x, y), d, w))
        on_main = [cd for cd in cands if cd[2] in self.main]
        if len({cd[0] for cd in on_main}) >= want * 2:  # plenty of room on the main network: keep doors there
            cands = on_main
        added = 0
        homes = [tuple(s["house"]) for s in self.slots]
        others = [tuple(p["tile"]) for p in self.places.values()]
        for _ in range(want):
            used = self.protected
            options = [cd for cd in cands if not ({cd[0], cd[1], cd[2]} & used)]
            if not options:
                break
            # The model's "H" spots first; then as far as possible from other homes (and a little from places)
            gap = lambda t: min((abs(t[0] - a) + abs(t[1] - b) for a, b in homes), default=self.n)
            near_place = lambda t: min((abs(t[0] - a) + abs(t[1] - b) for a, b in others), default=self.n)
            house, drive, door = max(options, key=lambda cd: (self.T[cd[0][1]][cd[0][0]] == "home-spot",
                                                             gap(cd[0]) + 0.2 * min(near_place(cd[0]), 4) + self.rng.random()
                                                             - (2 if self.T[cd[1][1]][cd[1][0]] == "path" else 0)))
            (hx, hy), (dx, dy) = house, drive
            self.slots.append({"house": [hx, hy], "driveway": [dx, dy], "door": list(door),
                               "block": [min(hx, dx), min(hy, dy), max(hx, dx), max(hy, dy)],
                               "model": self.rng.choice(house_models)})
            for x, y in (house, drive):
                self.T[y][x] = "garden"  # unclaimed plots show as garden until someone moves in
            self.protected |= {house, drive, door}
            homes.append(house)
            added += 1
        return added

    # ---- Make every door reachable from every other, carving trails through scenery where needed
    def components(self):
        comp, sizes = {}, []
        for start in self.cells():
            if start in comp or not self.walkable(*start):
                continue
            i, todo, count = len(sizes), [start], 0
            comp[start] = i
            while todo:
                x, y = todo.pop()
                count += 1
                for dx, dy in NEIGHBORS:
                    q = (x + dx, y + dy)
                    if q not in comp and self.walkable(*q):
                        comp[q] = i
                        todo.append(q)
            sizes.append(count)
        return comp, sizes

    def doors(self):
        return [tuple(p["door"]) for p in self.places.values()] + [tuple(s["door"]) for s in self.slots]

    def join_up(self) -> None:
        for _ in range(64):
            comp, sizes = self.components()
            groups = {comp[d] for d in self.doors() if d in comp}
            if len(groups) <= 1:
                return
            main = max(groups, key=lambda g: sizes[g])
            other = next(g for g in groups if g != main)
            # Cheapest trail from the main network to the stranded one (Dijkstra over carvable tiles)
            dist, prev, heap = {}, {}, []
            for t, g in comp.items():
                if g == main:
                    dist[t] = 0
                    heapq.heappush(heap, (0, t))
            goal = None
            while heap:
                d, t = heapq.heappop(heap)
                if d > dist.get(t, 1e9):
                    continue
                if comp.get(t) == other:
                    goal = t
                    break
                for dx, dy in NEIGHBORS:
                    q = (t[0] + dx, t[1] + dy)
                    if not self.inb(*q) or (q in self.protected and not self.walkable(*q)):
                        continue
                    step = 0.1 if self.walkable(*q) else CARVE.get(self.kind(*q))
                    if step is None:
                        continue
                    if d + step < dist.get(q, 1e9):
                        dist[q], prev[q] = d + step, t
                        heapq.heappush(heap, (d + step, q))
            if goal is None:  # walled in by places and plots: give up those plots (a town has spares) rather than the town
                stranded = [sl for sl in self.slots if comp.get(tuple(sl["door"])) == other]
                if not stranded:
                    print(f"[towngen] couldn't join a stranded part of the map ({sizes[other]} tiles)", flush=True)
                    return
                self.slots = [sl for sl in self.slots if sl not in stranded]
                continue
            t = goal
            while t in prev:
                if not self.walkable(*t):
                    self.T[t[1]][t[0]] = "path"
                t = prev[t]

    def finish(self, plan: TownPlan, extra: dict | None = None) -> tuple[list[list[str]], dict]:
        """Leftover "H" spots become lawn; background houses are every house model that isn't a place or plot."""
        place_tiles = {tuple(p["tile"]) for p in self.places.values()}
        homes = []
        for x, y in self.cells():
            if self.T[y][x] == "home-spot":
                self.T[y][x] = "park"
            elif self.T[y][x] in HOUSES and (x, y) not in place_tiles:
                homes.append({"model": self.T[y][x], "house": [x, y]})
        town_map = {"places": self.places, "home_slots": self.slots,
                    "background_homes": {"color": plan.background_color, "homes": homes}, "drawn": True}
        if any(self.T[y][x] == "stadium" for x, y in self.cells()):
            town_map["landmarks"] = {"stadium": {"model": STADIUM}}
        if plan.theme:
            town_map["theme"] = plan.theme
        town_map.update(extra or {})
        return self.T, town_map


def palettes(plan: TownPlan, size: int) -> tuple[list[str], list[str]]:
    buildings = [m for m in plan.buildings if m in BUILDINGS or m in HOUSES] or (MID + TALL if size >= 17 else SMALL + MID)
    houses = [m for m in plan.houses if m in HOUSES] or list(HOUSES)
    return buildings, houses


def varied(T, x, y, options, rng):
    """A random pick that differs from the tiles around (x, y), so neighbours never repeat."""
    near = {T[y + dy][x + dx] for dx, dy in NEIGHBORS if 0 <= y + dy < len(T) and 0 <= x + dx < len(T)}
    return rng.choice([o for o in options if o not in near] or options)


def build(plan: TownPlan, members: int, min_size: int) -> tuple[list[list[str]], dict]:
    """Turn the model's drawing into tiles + map, repairing only what would break the app."""
    rng = random.Random(zlib.crc32(f"{plan.name}|{plan.theme}|{''.join(plan.rows)}".encode()))
    rows = [r.replace(" ", "") for r in plan.rows]
    h, w = len(rows), max((len(r) for r in rows), default=0)
    n = odd(min(MAX_SIZE, max(min_size, h, w)))
    fill = outskirts_kind(plan)
    oy, ox = (n - min(h, n)) // 2, (n - min(w, n)) // 2  # a small drawing sits in the middle of the grid
    T = [[fill] * n for _ in range(n)]
    for y, row in enumerate(rows[:n]):
        for x, ch in enumerate(row[:n]):
            T[y + oy][x + ox] = LEGEND.get(ch, fill)
    buildings, houses = palettes(plan, n)
    for x, y in ((x, y) for y in range(n) for x in range(n)):  # "b"/"h" become real models, no two alike side by side
        if T[y][x] == "building":
            T[y][x] = varied(T, x, y, buildings, rng)
        elif T[y][x] == "house":
            T[y][x] = varied(T, x, y, houses, rng)
    m = Map(T, rng)
    m.find_main()
    for kind in ("stadium", "farm"):  # a place named for one ("stadium") means it has to be there
        named = any(p.id == kind for p in plan.places)
        wanted = (kind in plan.landmarks) if plan.exact_landmarks else (True if named else None)
        m.settle_landmark(kind, wanted)
    for p in plan.places:
        model = p.model if p.model in BUILDINGS or p.model in HOUSES else (None if p.model is None else rng.choice(SMALL))
        at = [int(p.at[0]) + ox, int(p.at[1]) + oy] if p.at else None
        spot = [t for t in m.cells() if m.T[t[1]][t[0]] == p.id] if p.id in LANDMARK_SIZE else []
        if spot:  # the stadium / farm place is the landmark itself, at its edge nearest a way in
            model, at = None, list(min(spot, key=lambda t: (m.door_for(*t) is None, t)))
        m.add_place(p.id, p.name, model, at)
    m.add_slots(max(members, slot_cap(n)), houses)
    m.join_up()
    return m.finish(plan)


def grow(town: dict, members: int) -> tuple[list[list[str]], dict]:
    """Add a ring of the town's outskirts around it until there's a plot for every member (up to MAX_SIZE).
    Roads and trails that reach the old edge run on into the new ground. Existing plots, places and names keep their
    spot (shifted), so everyone who re-claims in join order gets the same house back."""
    from backend.towngen import size_for
    old, town_map = town["tiles"], town["map"]
    plan = TownPlan.model_validate(town_map.get("plan") or {})
    n0 = len(old)
    for fill in (outskirts_kind(plan), "park"):  # if the outskirts leave no room for homes, fall back to lawn
        n = min(MAX_SIZE, max(size_for(members), n0 + 2))
        k = (n - n0) // 2
        T = [[fill] * n for _ in range(n)]
        for y, row in enumerate(old):
            for x, kind in enumerate(row):
                T[y + k][x + k] = kind
        shift = lambda p: [p[0] + k, p[1] + k]
        slots = []
        for s in town_map.get("home_slots") or []:
            slots.append({**s, "house": shift(s["house"]), "driveway": shift(s["driveway"]), "door": shift(s["door"]),
                          "block": shift(s["block"][:2]) + shift(s["block"][2:])})
            for x, y in ((s["house"][0] + k, s["house"][1] + k), (s["driveway"][0] + k, s["driveway"][1] + k)):
                T[y][x] = "garden"  # everyone re-claims in join order (routes/towns.regrow_town)
        # Roads and trails on the old edge carry on straight out to the new edge
        for i in range(n0):
            for (x, y), (dx, dy) in (((i, 0), (0, -1)), ((i, n0 - 1), (0, 1)), ((0, i), (-1, 0)), ((n0 - 1, i), (1, 0))):
                if old[y][x] in ("road", "path"):
                    for step in range(1, k + 1):
                        T[y + k + dy * step][x + k + dx * step] = old[y][x]
        rng = random.Random(zlib.crc32(f"{plan.name}|grow|{n}".encode()))
        if fill in ("forest", "oak"):  # a ragged edge of trees and clearings, not a solid wall
            for y in range(n):
                for x in range(n):
                    inside = k <= x < k + n0 and k <= y < k + n0
                    if not inside and T[y][x] == fill and rng.random() < 0.3:
                        T[y][x] = "park"
        m = Map(T, rng)
        m.slots = slots
        m.places = {pid: {**p, "tile": shift(p["tile"]), "door": shift(p["door"])} for pid, p in town_map.get("places", {}).items()}
        m.protected = ({tuple(p["tile"]) for p in m.places.values() if p.get("model")} | {tuple(p["door"]) for p in m.places.values()}
                       | {tuple(t) for s in slots for t in (s["house"], s["driveway"], s["door"])}
                       | {(x, y) for x, y in m.cells() if T[y][x] in ("farm", "stadium")})
        _, houses = palettes(plan, n)
        m.find_main()
        m.add_slots(max(members, slot_cap(n)) - len(slots), houses)
        if len(m.slots) >= members or n == MAX_SIZE:
            break
    m.join_up()
    keep = {k2: v for k2, v in town_map.items() if k2 not in ("places", "home_slots", "background_homes", "landmarks")}
    return m.finish(plan, keep)


def problems(tiles: list[list[str]], town_map: dict, homes_needed: int = 1) -> list[str]:
    """What would break the app in a drawn town. Empty list = OK."""
    out = shared_tiles(town_map.get("places") or {})
    n = len(tiles)
    if n < MIN_SIZE or any(len(r) != n for r in tiles):
        out.append("grid must be square and at least 11 wide")
    m = Map(tiles, random.Random(0))
    m.places, m.slots = town_map.get("places", {}), town_map.get("home_slots", [])
    if len(m.slots) < homes_needed:
        out.append(f"only {len(m.slots)} home plots, need {homes_needed}")
    for s in m.slots:
        (hx, hy), (dx, dy), door = s["house"], s["driveway"], s["door"]
        if not m.walkable(*door) or (2 * dx - door[0], 2 * dy - door[1]) != (hx, hy):
            out.append(f"home plot at {s['house']}: driveway doesn't lead straight from the house to walkable ground")
    for pid, p in m.places.items():
        if not m.walkable(*p["door"]):
            out.append(f"place {pid}'s door isn't on walkable ground")
    comp, _ = m.components()
    if len({comp.get(d) for d in m.doors()}) > 1:
        out.append("some doors can't reach the others")
    return out


# Classic-city tile words the model's legend doesn't have, as the closest legend character
_BACK = {**{v: k for k, v in LEGEND.items() if v not in ("building", "house", "home-spot")},
         "pond": "~", "water": "~", "tree": "t", "fountain": "z", "lot": "b", "yard": ".", "driveway": ".", "home": "H",
         "bench-n": "p", "bench-s": "p", "bench-e": "p", "bench-w": "p"}


def to_rows(tiles: list[list[str]], town_map: dict) -> list[str]:
    """A built town back in LEGEND characters (what the model draws), so a revision starts from what the user saw:
    repairs and all. Home plots show as "H" spots; buildings as "b", houses as "h"."""
    grid = [["h" if k in HOUSES else "b" if "/" in k else _BACK.get(k, ".") for k in row] for row in tiles]
    for s in town_map.get("home_slots") or []:
        (hx, hy), (dx, dy) = s["house"], s["driveway"]
        grid[hy][hx], grid[dy][dx] = "H", "."
    return ["".join(row) for row in grid]
