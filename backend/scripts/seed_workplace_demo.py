"""A hand-built demo world: Maple Harbor, a small waterfront city where five friends work. Five new accounts,
friends only with each other (no link to anyone else in the database), full profiles, a 17x17 town laid out
tile by tile (not the town generator), calendars built around their jobs, and a lived-in feed.

    python -m backend.scripts.seed_workplace_demo --check      # validate the map against the town rules
    python -m backend.scripts.seed_workplace_demo --preview    # print the town as JSON (for a 3D preview)
    DEMO_PASSWORD=... python -m backend.scripts.seed_workplace_demo --seed <backend url>

Seeding goes through the app's own API, signed in as each person, so every rule and trigger applies as it
would for real users. The password comes from DEMO_PASSWORD and is never stored in the repo.
"""

import json
import sys

SP, KC, KS = "simplepoly-city/", "city-kit-commercial/", "city-kit-suburban/"
N, ROADS = 17, (2, 6, 10, 14)
EMAIL_DOMAIN = "maple-harbor-demo.example.com"
TOWN_NAME = "Maple Harbor"

# ---- The people -----------------------------------------------------------------------------------------------
# key -> profile, identity in town, look, and home plot. Plots are 2x2 in the outer ring; the house, driveway and
# door (a road tile) sit in a straight line, as the town rules require. Order = join order = plot order.
PEOPLE = {
    "hana": {
        "display_name": "Hana Sato", "username": "hana_pours",
        "bio": "Owner + head barista at Daybreak Coffee. Up at 5, ceramics on Sundays, will remember your order.",
        "interests": ["coffee", "ceramics", "cycling", "indie music", "farmers markets"],
        "character": "character-female-b", "color": "#ff9500",
        "plot": {"house": [8, 0], "driveway": [8, 1], "door": [8, 2], "block": [7, 0, 8, 1], "model": KS + "building-type-f"},
        "house_name": "The Loft above the Kiln",
    },
    "nadia": {
        "display_name": "Nadia Okafor", "username": "nadia_nights",
        "bio": "ER nurse at St. Brigid. Night shifts, strong coffee, long runs. Ask me about the time a goose came in.",
        "interests": ["running", "baking", "true crime podcasts", "yoga", "coffee"],
        "character": "character-female-d", "color": "#ff2d55",
        "plot": {"house": [12, 0], "driveway": [12, 1], "door": [12, 2], "block": [11, 0, 12, 1], "model": SP + "building-house-02-color02"},
        "house_name": "Nadia's Nap Headquarters",
    },
    "marcus": {
        "display_name": "Marcus Chen", "username": "marcus_ships",
        "bio": "Software engineer at Brightline Labs. Bouldering most nights, board games on Fridays, keyboards always.",
        "interests": ["bouldering", "board games", "mechanical keyboards", "ramen", "sci-fi"],
        "character": "character-male-c", "color": "#5e5ce6",
        "plot": {"house": [16, 4], "driveway": [15, 4], "door": [14, 4], "block": [15, 3, 16, 4], "model": KS + "building-type-o"},
        "house_name": "The Server Room",
    },
    "sofia": {
        "display_name": "Sofia Reyes", "username": "sofia_cooks",
        "bio": "Sous chef at Olive & Ember. Market run every Sunday, salsa on Thursdays, film camera in my apron.",
        "interests": ["farmers markets", "salsa dancing", "film photography", "baking", "running"],
        "character": "character-female-e", "color": "#ffd60a",
        "plot": {"house": [7, 16], "driveway": [7, 15], "door": [7, 14], "block": [7, 15, 8, 16], "model": SP + "building-house-04-color02"},
        "house_name": "Casa Reyes",
    },
    "theo": {
        "display_name": "Theo Brooks", "username": "theo_teaches",
        "bio": "Chemistry teacher at Westbrook High + robotics coach. Pickup basketball, bouldering, bad puns (sodium funny).",
        "interests": ["bouldering", "basketball", "robotics", "sci-fi", "running"],
        "character": "character-male-e", "color": "#bf5af2",
        "plot": {"house": [0, 12], "driveway": [1, 12], "door": [2, 12], "block": [0, 11, 1, 12], "model": KS + "building-type-h"},
        "house_name": "The Lab",
    },
}

# ---- The places -----------------------------------------------------------------------------------------------
# Place ids agents know by type (cafe, gym, market, park, downtown) plus the workplaces. Each door is a road tile
# next to its building, unique so two places never share a doorstep.
PLACES = {
    "hospital": {"name": "St. Brigid Medical Center", "model": SP + "building-residential-color02", "tile": [3, 4], "door": [2, 4]},
    "office": {"name": "Brightline Labs", "model": KC + "building-skyscraper-a", "tile": [9, 4], "door": [10, 4]},
    "restaurant": {"name": "Olive & Ember", "model": SP + "building-restaurant", "tile": [12, 5], "door": [12, 6]},
    "school": {"name": "Westbrook High", "model": SP + "building-residential-color01", "tile": [4, 11], "door": [4, 10]},
    "cafe": {"name": "Daybreak Coffee", "model": SP + "building-coffee-shop", "tile": [5, 7], "door": [6, 7]},
    "gym": {"name": "Crux Climbing Gym", "model": KC + "building-j", "tile": [11, 8], "door": [10, 8]},
    "market": {"name": "Harbor Market", "model": SP + "building-super-market", "tile": [8, 11], "door": [8, 10]},
    "bar": {"name": "The Night Shift", "model": SP + "building-bar", "tile": [11, 12], "door": [10, 12]},
    "downtown": {"name": "Harbor Square", "tile": [7, 5], "door": [7, 6]},
    "park": {"name": "Harbor Green", "tile": [8, 7], "door": [8, 6]},
    "pier": {"name": "the Pier", "tile": [15, 12], "door": [14, 12]},
}

# ---- The map --------------------------------------------------------------------------------------------------
# Every tile is chosen. Rows are y = 0..16, columns x = 0..16; roads run along 2, 6, 10 and 14 both ways.
# Inner blocks (between the roads) are the city: workplaces, towers and shops, densest downtown (top middle).
# The outer ring is the neighbourhood: the five homes, background houses, gardens, a pocket park and, in the
# bottom-right corner, the harbor with its pier.
INNER = {
    # Medical district (top left): the hospital with a pharmacy and clinics around a courtyard
    (3, 3): KC + "building-f", (4, 3): SP + "building-residential-color03", (5, 3): KC + "building-g",
    (4, 4): "plaza", (5, 4): SP + "building-sky-small-color01",
    (3, 5): SP + "building-drug-store", (4, 5): KC + "building-a", (5, 5): "garden",
    # Downtown (top middle): the tallest towers, Brightline Labs, and Harbor Square
    (7, 3): KC + "building-skyscraper-b", (8, 3): SP + "building-sky-big-color02", (9, 3): KC + "building-skyscraper-c",
    (7, 4): KC + "building-skyscraper-d", (8, 4): SP + "building-sky-big-color01",
    (8, 5): KC + "building-m", (9, 5): SP + "building-sky-small-color02",
    # Restaurant row (top right)
    (11, 3): KC + "building-h", (12, 3): SP + "building-clothing", (13, 3): KC + "building-l",
    (11, 4): SP + "building-music-store", (12, 4): "patio", (13, 4): KC + "building-b",
    (11, 5): SP + "building-pizza", (13, 5): SP + "building-bakery",
    # Café corner (middle left), facing the park
    (3, 7): SP + "building-books-shop", (4, 7): SP + "building-gift-shop",
    (3, 8): KC + "building-c", (4, 8): "garden", (5, 8): SP + "building-fast-food",
    (3, 9): KC + "building-d", (4, 9): KC + "building-i", (5, 9): SP + "building-shoes-shop",
    # Harbor Green, the central park (the pond sits dead centre)
    (7, 7): "tree", (8, 7): "park", (9, 7): "tree", (7, 8): "park", (8, 8): "pond", (9, 8): "park",
    (7, 9): "tree", (8, 9): "park", (9, 9): "tree",
    # Gym block (middle right)
    (11, 7): SP + "building-sky-small-color03", (12, 7): KC + "building-k", (13, 7): SP + "building-residential-color03",
    (12, 8): "plaza", (13, 8): KC + "building-e",
    (11, 9): SP + "building-chicken-shop", (12, 9): KC + "building-n", (13, 9): SP + "building-fruits-shop",
    # School block (bottom left): Westbrook High with its sports field
    (3, 11): KC + "building-e", (5, 11): KC + "building-c",
    (3, 12): "garden", (4, 12): "plaza", (5, 12): SP + "building-residential-color02",
    (3, 13): "tree", (4, 13): SP + "building-books-shop", (5, 13): "oak",
    # Market block (bottom middle)
    (7, 11): SP + "building-fruits-shop", (9, 11): SP + "building-bakery",
    (7, 12): "patio", (8, 12): "plaza", (9, 12): SP + "building-gift-shop",
    (7, 13): KC + "building-k", (8, 13): SP + "building-residential-color01", (9, 13): KC + "building-a",
    # Night Shift block (bottom right): the pub and the waterfront shops
    (11, 11): SP + "building-coffee-shop", (12, 11): SP + "building-pizza", (13, 11): KC + "building-g",
    (12, 12): "patio", (13, 12): SP + "building-music-store",
    (11, 13): KC + "building-h", (12, 13): SP + "building-drug-store", (13, 13): "garden",
}

OUTER = {
    # Top band (y 0-1): the pocket park in the corner, Hana's and Nadia's homes, houses between
    (0, 0): "oak", (1, 0): "bench-s", (0, 1): "bench-e", (1, 1): "fountain",
    (3, 0): KS + "building-type-b", (4, 0): "tree", (5, 0): KS + "building-type-c",
    (3, 1): "garden", (4, 1): KS + "building-type-e", (5, 1): "picnic",
    (9, 0): "tree", (9, 1): KS + "building-type-n",
    (13, 0): "oak", (13, 1): SP + "building-house-01-color02",
    (15, 0): KS + "building-type-q", (16, 0): "tree", (15, 1): "garden", (16, 1): "picnic",
    # Right band (x 15-16): Marcus's home, then houses down to the harbor
    (15, 5): KS + "building-type-s", (16, 5): "tree",
    (15, 7): SP + "building-house-03-color02", (16, 7): "garden", (15, 8): "tree", (16, 8): "oak",
    (15, 9): KS + "building-type-t", (16, 9): "picnic",
    # The harbor (bottom right): water, with the pier running out from the road
    (15, 11): "lake", (16, 11): "lake", (15, 12): "path", (16, 12): "lake", (15, 13): "lake", (16, 13): "lake",
    (11, 15): "lake", (12, 15): "lake", (13, 15): "lake", (11, 16): "lake", (12, 16): "lake", (13, 16): "lake",
    (15, 15): "lake", (16, 15): "lake", (15, 16): "lake", (16, 16): "lake",
    # Bottom band (y 15-16): Sofia's home and her street
    (0, 15): "tree", (1, 15): "garden", (0, 16): "oak", (1, 16): "picnic",
    (3, 15): SP + "building-house-01-color03", (4, 15): "garden", (5, 15): KS + "building-type-u",
    (3, 16): "tree", (4, 16): KS + "building-type-g", (5, 16): "oak",
    (9, 15): KS + "building-type-j", (9, 16): "garden",
    # Left band (x 0-1): Theo's home, houses and gardens
    (0, 3): KS + "building-type-k", (1, 3): "garden", (0, 4): "tree", (1, 4): SP + "building-house-03-color03",
    (0, 5): "picnic", (1, 5): "oak",
    (0, 7): "garden", (1, 7): KS + "building-type-m", (0, 8): "oak", (1, 8): "patio",
    (0, 9): KS + "building-type-p", (1, 9): "tree",
    (0, 13): "garden", (1, 13): KS + "building-type-r",
}
BACKGROUND_COLOR = "#b9aa98"  # the muted roof colour every background house shares


def build() -> tuple[list[list[str]], dict]:
    tiles = [["road" if x in ROADS or y in ROADS else "" for x in range(N)] for y in range(N)]
    for (x, y), kind in {**INNER, **OUTER}.items():
        assert tiles[y][x] == "", f"({x}, {y}) set twice or on a road"
        tiles[y][x] = kind
    for p in PLACES.values():
        x, y = p["tile"]
        if p.get("model"):
            assert tiles[y][x] == "", f"place tile ({x}, {y}) already used"
            tiles[y][x] = p["model"]
        elif not tiles[y][x]:
            tiles[y][x] = "plaza"
    slots = []
    for person in PEOPLE.values():
        plot = person["plot"]
        b = plot["block"]
        for x in range(b[0], b[2] + 1):
            for y in range(b[1], b[3] + 1):
                assert tiles[y][x] == "", f"plot tile ({x}, {y}) already used"
                tiles[y][x] = "garden"  # an unclaimed plot shows as garden; joining turns it into the home
        slots.append(dict(plot))
    empty = [(x, y) for y in range(N) for x in range(N) if not tiles[y][x]]
    assert not empty, f"tiles left unset: {empty}"
    homes = [{"model": k, "house": [x, y]} for y, row in enumerate(tiles) for x, k in enumerate(row)
             if k.startswith(KS) or "building-house" in k]
    town_map = {
        "places": {pid: {k: v for k, v in p.items()} for pid, p in PLACES.items()},
        "home_slots": slots,
        "background_homes": {"color": BACKGROUND_COLOR, "homes": homes},
        "landscape": "green",
        "style": "city",
        "theme": "A small waterfront city where five friends work: the hospital, a downtown startup, a restaurant, the high school and the café.",
    }
    return tiles, town_map


# ---- What they share ------------------------------------------------------------------------------------------
# Posts, written as each person, backdated so the feed reads like the last day and a half. `hours_ago` is from the
# moment of seeding. Audience "town" = only Maple Harbor sees it; "friends" = all their friends.
POSTS = [
    {"by": "hana", "hours_ago": 30, "audience": "town",
     "text": "Daybreak turns 2 this Saturday ☕🎂 Free pastry for anyone who comes in wearing something orange. Thank you for two years of 6am regulars.",
     "reactions": {"nadia": "❤️", "marcus": "🎉", "sofia": "🎉", "theo": "❤️"},
     "comments": [("nadia", 29, "I will be there at 7:15 in the most orange scrubs I own"),
                  ("theo", 28, "Two years already?! Putting it on the robotics calendar as a field trip"),
                  ("marcus", 27, "Orange hoodie is ready.")]},
    {"by": "nadia", "hours_ago": 18, "audience": "friends",
     "text": "Three night shifts down, one to go. If you see me at Daybreak at 7:15am looking like a raccoon, no you didn't.",
     "reactions": {"hana": "😂", "sofia": "❤️", "theo": "😂"},
     "comments": [("hana", 17, "Your usual will be waiting. Oat milk, extra shot, no judgment 🦝"),
                  ("sofia", 16, "There's soup in your fridge. Don't argue.")]},
    {"by": "marcus", "hours_ago": 14, "audience": "town",
     "text": "Shipped the thing we've been building for four months 🚀 Celebrating at Crux tomorrow, first round of chalk is on me. Theo, you're coming.",
     "reactions": {"theo": "🎉", "nadia": "👏", "sofia": "🎉", "hana": "👏"},
     "comments": [("theo", 13, "I'm in. Loser buys ramen."),
                  ("sofia", 12, "Congrats!! What did you ship? Explain it like I'm a risotto"),
                  ("marcus", 12, "An app that shows hospitals which beds are free, live. Nadia was our first tester 😅"),
                  ("nadia", 11, "Can confirm. It's the only software at St. Brigid I don't yell at")]},
    {"by": "sofia", "hours_ago": 9, "audience": "town",
     "text": "New fall menu drops Tuesday at Olive & Ember 🍂 Roasted squash risotto with brown butter and sage. Friends & family tasting Monday at 6, bring honest opinions.",
     "reactions": {"hana": "❤️", "marcus": "😮", "theo": "❤️", "nadia": "❤️"},
     "comments": [("hana", 8, "I'll trade you a pumpkin latte for a spoonful"),
                  ("marcus", 8, "Monday at 6, calendar cleared"),
                  ("theo", 7, "Honest opinion incoming: it will be perfect")]},
    {"by": "theo", "hours_ago": 5, "audience": "friends",
     "text": "My robotics kids just qualified for regionals!!! 🤖 Three of them stayed until 9pm last week rewiring the arm. Proudest teacher in Maple Harbor.",
     "reactions": {"nadia": "🎉", "marcus": "👏", "sofia": "🎉", "hana": "❤️"},
     "comments": [("nadia", 4.5, "THEO!! 🎉 Tell the kids the ER is proud of them"),
                  ("marcus", 4, "Need a mentor for regionals? I've got Thursdays free"),
                  ("theo", 3.5, "Marcus, you're hired. Unpaid. Snacks provided.")]},
    {"by": "hana", "hours_ago": 2, "audience": "friends",
     "text": "Testing a pumpkin cardamom latte tomorrow morning. Need three volunteers with strong opinions ☕ First cups are free.",
     "reactions": {"sofia": "❤️", "nadia": "🎉"},
     "comments": [("sofia", 1.5, "Volunteer #1 reporting for duty"),
                  ("nadia", 1, "Volunteer #2, straight off shift")]},
    {"by": "sofia", "hours_ago": 0.5, "audience": "town",
     "text": "Market run at 8 before brunch. Anyone want anything? The mushroom guy is back 🍄",
     "reactions": {"hana": "❤️"},
     "comments": [("theo", 0.3, "Honey, the good kind. I'll Venmo you")]},
]

# Things they chose to share with their town, beyond posts. The town brain reads these and turns them into
# town news, moods and the connections it notices (posts themselves never become news).
LIFE_SIGNALS = [
    ("theo", "news", {"text": "robotics team qualified for regionals"}),
    ("sofia", "news", {"text": "launching the new fall menu at Olive & Ember on Tuesday"}),
    ("marcus", "news", {"text": "shipped a big launch at work after four months"}),
    ("hana", "news", {"text": "Daybreak Coffee turns two on Saturday"}),
    ("nadia", "mood", {"mood": "rough_week", "text": "working four night shifts in a row at the hospital"}),
    ("marcus", "interest_mention", {"interest": "bouldering"}),
    ("theo", "interest_mention", {"interest": "bouldering"}),
    ("sofia", "interest_mention", {"interest": "farmers markets"}),
    ("hana", "interest_mention", {"interest": "farmers markets"}),
]

# Calendars, in Eastern time. Day 0 is the day of seeding (a Sunday for the demo). Group events list everyone
# going; the first person creates it.
EVENTS = [
    # Sunday
    {"day": 0, "start": "06:30", "end": "14:00", "who": ["hana"], "title": "Opening shift at Daybreak", "kind": "work", "at": "cafe"},
    {"day": 0, "start": "08:00", "end": "09:30", "who": ["sofia"], "title": "Market run for the restaurant", "kind": "work", "at": "market"},
    {"day": 0, "start": "10:30", "end": "12:00", "who": ["marcus", "nadia", "sofia", "theo"], "title": "Sunday brunch", "kind": "social", "at": "cafe"},
    {"day": 0, "start": "14:00", "end": "22:00", "who": ["sofia"], "title": "Dinner service", "kind": "work", "at": "restaurant"},
    {"day": 0, "start": "15:00", "end": "17:00", "who": ["marcus", "theo"], "title": "Launch celebration climb", "kind": "social", "at": "gym"},
    {"day": 0, "start": "16:00", "end": "17:00", "who": ["nadia"], "title": "Run around Harbor Green", "kind": "activity", "at": "park"},
    {"day": 0, "start": "15:00", "end": "16:30", "who": ["hana"], "title": "Stock up for the week", "kind": "activity", "at": "market"},
    {"day": 0, "start": "20:00", "end": "22:00", "who": ["marcus", "theo", "hana", "nadia"], "title": "Trivia night", "kind": "social", "at": "bar"},
    # Monday
    {"day": 1, "start": "06:30", "end": "14:00", "who": ["hana"], "title": "Opening shift at Daybreak", "kind": "work", "at": "cafe"},
    {"day": 1, "start": "07:30", "end": "15:30", "who": ["theo"], "title": "Teaching chemistry", "kind": "work", "at": "school"},
    {"day": 1, "start": "09:30", "end": "17:30", "who": ["marcus"], "title": "Work", "kind": "work", "at": "office"},
    {"day": 1, "start": "10:00", "end": "11:00", "who": ["sofia"], "title": "Market run for the tasting", "kind": "work", "at": "market"},
    {"day": 1, "start": "15:30", "end": "17:30", "who": ["theo"], "title": "Robotics practice", "kind": "work", "at": "school"},
    {"day": 1, "start": "15:00", "end": "21:00", "who": ["sofia"], "title": "Tasting prep and service", "kind": "work", "at": "restaurant"},
    {"day": 1, "start": "18:00", "end": "19:30", "who": ["marcus", "theo", "hana"], "title": "Fall menu tasting", "kind": "social", "at": "restaurant"},
    {"day": 1, "start": "19:00", "end": "23:59", "who": ["nadia"], "title": "Night shift", "kind": "work", "at": "hospital"},
    # Tuesday
    {"day": 2, "start": "00:00", "end": "07:00", "who": ["nadia"], "title": "Night shift", "kind": "work", "at": "hospital"},
    {"day": 2, "start": "06:30", "end": "14:00", "who": ["hana"], "title": "Opening shift at Daybreak", "kind": "work", "at": "cafe"},
    {"day": 2, "start": "07:30", "end": "15:30", "who": ["theo"], "title": "Teaching chemistry", "kind": "work", "at": "school"},
    {"day": 2, "start": "09:30", "end": "17:30", "who": ["marcus"], "title": "Work", "kind": "work", "at": "office"},
    {"day": 2, "start": "14:00", "end": "23:00", "who": ["sofia"], "title": "Fall menu launch night", "kind": "work", "at": "restaurant"},
    {"day": 2, "start": "19:00", "end": "21:00", "who": ["marcus", "theo"], "title": "Bouldering", "kind": "activity", "at": "gym"},
    {"day": 2, "start": "19:00", "end": "23:59", "who": ["nadia"], "title": "Night shift", "kind": "work", "at": "hospital"},
]

# Notes left in each other's 3D mailboxes
MAIL = [
    ("nadia", "hana", "Left your spare key under the cactus. Thank you for the soup last week 🧡"),
    ("theo", "marcus", "Regionals are Nov 14. Bring your laptop and your patience. And snacks."),
    ("sofia", "nadia", "Tasting is Monday at 6. I'll save you a to-go box for your shift."),
    ("marcus", "sofia", "Put me down for two plates of that risotto. Research purposes."),
]


def check() -> list[str]:
    from backend.towngen.layout import problems

    tiles, town_map = build()
    return problems(tiles, town_map, homes_needed=len(PEOPLE))


# ---- Seeding ---------------------------------------------------------------------------------------------------

def email_of(key: str) -> str:
    return f"{key}@{EMAIL_DOMAIN}"


class Person:
    """One demo account, signed in, calling the app's API as themselves."""

    def __init__(self, key: str, api_base: str, token: str, uid: str):
        import httpx

        self.key, self.uid = key, uid
        self.http = httpx.Client(base_url=api_base, headers={"Authorization": f"Bearer {token}"}, timeout=60)

    def call(self, method: str, path: str, body=None):
        res = self.http.request(method, path, json=body)
        if res.status_code >= 400:
            raise RuntimeError(f"{self.key} {method} {path} -> {res.status_code}: {res.text[:300]}")
        return res.json() if res.content else None


def sign_in(key: str, password: str):
    from supabase import create_client

    from backend.config import settings

    client = create_client(settings.SUPABASE_URL, settings.SUPABASE_PUBLISHABLE_KEY)
    session = client.auth.sign_in_with_password({"email": email_of(key), "password": password}).session
    return session.access_token, session.user.id


def reset(api_base: str, password: str) -> None:
    """Delete the demo accounts (and so their town) if they exist, through DELETE /me."""
    for key in PEOPLE:
        try:
            token, uid = sign_in(key, password)
        except Exception:
            continue
        Person(key, api_base, token, uid).call("DELETE", "/me")
        print(f"deleted {key}")


def seed(api_base: str, password: str) -> dict:
    from datetime import datetime, timedelta, timezone
    from zoneinfo import ZoneInfo

    from backend.db import get_client

    admin = get_client()
    tz = ZoneInfo("America/New_York")
    now = datetime.now(timezone.utc)
    people: dict[str, Person] = {}

    # 1. Accounts and full profiles
    for key, p in PEOPLE.items():
        admin.auth.admin.create_user({"email": email_of(key), "password": password, "email_confirm": True,
                                      "user_metadata": {"name": p["display_name"]}})
        token, uid = sign_in(key, password)
        me = people[key] = Person(key, api_base, token, uid)
        me.call("PATCH", "/me", {"username": p["username"], "display_name": p["display_name"], "bio": p["bio"],
                                 "interests": p["interests"], "timezone": "America/New_York",
                                 "avatar": {"character": p["character"], "color": p["color"]}})
        print(f"account {key}: {uid}")

    # 2. Friends with each other, and nobody else
    keys = list(PEOPLE)
    for i, a in enumerate(keys):
        for b in keys[i + 1:]:
            people[a].call("POST", "/friends/requests", {"username": PEOPLE[b]["username"]})
            pending = people[b].call("GET", "/friends/requests")
            incoming = pending.get("incoming", pending) if isinstance(pending, dict) else pending
            req = next(r for r in incoming if r.get("from_user") == people[a].uid or (r.get("profile") or r.get("from") or {}).get("id") == people[a].uid)
            people[b].call("POST", f"/friends/requests/{req['id']}/respond", {"status": "accepted"})
    print("friends: all 10 pairs")

    # 3. The town: the first person creates it with the hand-built map, the rest join with its code.
    #    Plots are claimed in join order, which is PEOPLE order, so everyone lands on their own plot.
    tiles, town_map = build()
    first = keys[0]
    town = people[first].call("POST", "/towns", {"name": TOWN_NAME, "tiles": tiles, "map": town_map,
                                                "me": {"name": PEOPLE[first]["display_name"].split()[0], "color": PEOPLE[first]["color"]}})
    tid = town["id"]
    for key in keys[1:]:
        people[key].call("POST", "/towns/join", {"invite_code": town["invite_code"],
                                                 "me": {"name": PEOPLE[key]["display_name"].split()[0], "color": PEOPLE[key]["color"]}})
    for key in keys:
        people[key].call("PATCH", f"/towns/{tid}/members/me/home", {"name": PEOPLE[key]["house_name"]})
    print(f"town {TOWN_NAME}: {tid} (invite code {town['invite_code']})")

    # 4. Calendars
    today = now.astimezone(tz).date()
    def at(day: int, hhmm: str) -> str:
        h, m = map(int, hhmm.split(":"))
        return datetime(today.year, today.month, today.day, h, m, tzinfo=tz).__add__(timedelta(days=day)).isoformat()
    for ev in EVENTS:
        owner, *others = ev["who"]
        people[owner].call("POST", f"/towns/{tid}/events", {
            "title": ev["title"], "kind": ev["kind"], "start": at(ev["day"], ev["start"]), "end": at(ev["day"], ev["end"]),
            "building_id": ev["at"], "travel_minutes": 10, "participant_ids": [people[k].uid for k in others]})
    print(f"calendar: {len(EVENTS)} events")

    # 5. Posts, reactions and comments, backdated so the feed reads like the last day and a half
    for post in POSTS:
        value = {"text": post["text"], "audience": post["audience"]}
        if post["audience"] == "town":
            value["town_id"] = tid
        sig = people[post["by"]].call("POST", "/signals", {"source": "manual", "type": "post", "value": value})
        sid = sig["id"] if isinstance(sig, dict) else sig[0]["id"]
        admin.table("signals").update({"created_at": (now - timedelta(hours=post["hours_ago"])).isoformat()}).eq("id", sid).execute()
        for key, emoji in post["reactions"].items():
            people[key].call("PUT", f"/posts/{sid}/reaction", {"emoji": emoji})
        for key, hours, text in post["comments"]:
            c = people[key].call("POST", f"/posts/{sid}/comments", {"text": text})
            cid = c.get("id") or (c.get("comment") or {}).get("id")
            if cid:
                admin.table("post_comments").update({"created_at": (now - timedelta(hours=hours)).isoformat()}).eq("id", cid).execute()
    print(f"feed: {len(POSTS)} posts with reactions and comments")

    # 6. What they shared with the town brain, and notes in each other's mailboxes
    for key, kind, value in LIFE_SIGNALS:
        people[key].call("POST", "/signals", {"source": "manual", "type": kind, "value": value})
    for frm, to, text in MAIL:
        people[frm].call("POST", f"/towns/{tid}/mailbox", {"to_user_id": people[to].uid, "text": text})
    print(f"shared {len(LIFE_SIGNALS)} life updates, {len(MAIL)} mailbox notes")
    return {"town_id": tid, "invite_code": town["invite_code"], "users": {k: people[k].uid for k in keys}}


if __name__ == "__main__":
    args = sys.argv[1:]
    if "--check" in args:
        issues = check()
        print("\n".join(issues) if issues else "Maple Harbor passes the town rules")
        sys.exit(1 if issues else 0)
    if "--preview" in args:
        tiles, town_map = build()
        print(json.dumps({"name": TOWN_NAME, "tiles": tiles, "map": town_map, "people": PEOPLE}))
        sys.exit(0)
    if "--seed" in args or "--reset" in args:
        import os

        password = os.environ.get("DEMO_PASSWORD")
        if not password:
            sys.exit("set DEMO_PASSWORD")
        base = next((x for x in args if x.startswith("http")), "http://127.0.0.1:8000")
        if "--reset" in args:
            reset(base, password)
        if "--seed" in args:
            print(json.dumps(seed(base, password), indent=1))
        sys.exit(0)
    sys.exit(__doc__)
