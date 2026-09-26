"""Seed the current Tiny Town members with three days of calendars in DEMO_TOWN_ID.

    py -3 -m backend.scripts.seed_demo_schedules

Safe to re-run: reuses members by display name, and replaces only the calendar signals it wrote
before (value.seed = SEED_TAG) plus this town's personal events. Day 0 is today in town time.
"""

import secrets
from datetime import datetime, timedelta

from backend.config import settings
from backend.db import get_client
from backend.models.enums import EventStatus, EventType, ParticipantStatus
from backend.calendar_drive import destination_for, estimate_travel_minutes
from backend.schedules import CALENDAR_SOURCE, CALENDAR_TYPE, local_now

SEED_TAG = "demo_schedule"
EMAIL_DOMAIN = "tinytown-demo.example.com"

PEOPLE = {
    "Drew": ["climbing", "coffee"],
    "Romeer Dhillon": ["running", "climbing"],
    "bob": ["climbing", "video games"],
    "patrik": ["cooking", "climbing"],
}

# (day, person, start, end, title, kind, building_id, place, with)
SCHEDULE = [
    # Day 0 — Saturday
    (0, "Drew", "10:00", "14:00", "Shift at Bean There Café", "work", "cafe", None, []),
    (0, "Drew", "16:00", "18:00", "Bouldering session", "activity", "gym", None, []),
    (0, "Romeer Dhillon", "11:00", "13:00", "CS study group", "class", "library", None, []),
    (0, "Romeer Dhillon", "19:00", "21:00", "Dinner with bob", "social", "downtown", None, ["bob"]),
    (0, "bob", "09:00", "12:00", "Shift at the market", "work", "market", None, []),
    (0, "bob", "16:00", "18:00", "Climbing at Boulder Gym", "activity", "gym", None, []),
    (0, "bob", "19:00", "21:00", "Dinner with Romeer Dhillon", "social", "downtown", None, ["Romeer Dhillon"]),
    (0, "patrik", "13:00", "14:00", "Appointment", "appointment", "downtown", None, []),
    (0, "patrik", "17:00", "19:00", "Cooking night at home", "activity", None, "home", []),
    # Day 1 — Sunday
    (1, "Drew", "11:00", "12:30", "Brunch with patrik", "social", "cafe", None, ["patrik"]),
    (1, "Drew", "15:00", "17:00", "Study for Linear Algebra", "class", "library", None, []),
    (1, "Romeer Dhillon", "09:00", "10:30", "Morning run", "activity", "park", None, []),
    (1, "Romeer Dhillon", "14:00", "18:00", "Shift downtown", "work", "downtown", None, []),
    (1, "bob", "14:00", "16:00", "Study for Linear Algebra", "class", "library", None, []),
    (1, "bob", "19:00", "21:00", "Game night", "activity", None, "home", []),
    (1, "patrik", "11:00", "12:30", "Brunch with Drew", "social", "cafe", None, ["Drew"]),
    (1, "patrik", "16:00", "18:00", "Climbing at Boulder Gym", "activity", "gym", None, []),
    # Day 2 — Monday
    (2, "Drew", "09:30", "10:45", "Intro to Psychology", "class", "library", "campus", []),
    (2, "Drew", "14:00", "15:15", "Linear Algebra", "class", "library", "campus", []),
    (2, "Drew", "17:00", "21:00", "Shift at Bean There Café", "work", "cafe", None, []),
    (2, "Romeer Dhillon", "09:00", "17:00", "Internship", "work", "downtown", None, []),
    (2, "bob", "11:00", "12:15", "Data Structures", "class", "library", "campus", []),
    (2, "bob", "14:00", "15:15", "Linear Algebra", "class", "library", "campus", []),
    (2, "bob", "18:30", "20:00", "Dinner with patrik", "social", "cafe", None, ["patrik"]),
    (2, "patrik", "10:00", "14:00", "Research lab", "work", "library", "campus", []),
    (2, "patrik", "18:30", "20:00", "Dinner with bob", "social", "cafe", None, ["bob"]),
]


def _at(day: datetime, hhmm: str) -> str:
    h, m = map(int, hhmm.split(":"))
    return day.replace(hour=h, minute=m).isoformat()


def build_signals(ids: dict[str, str], today: datetime) -> list[dict]:
    """ids: display name -> user_id. today: midnight, town time."""
    rows = []
    for day, person, start, end, title, kind, building_id, place, with_ in SCHEDULE:
        date = today + timedelta(days=day)
        dest = destination_for({"building_id": building_id, "text": place, "kind": kind}, ids[person])
        value = {
            "title": title, "kind": kind, "start": _at(date, start), "end": _at(date, end),
            "building_id": dest, "seed": SEED_TAG,
        }
        if place:
            value["place"] = place
        if with_:
            value["with"] = [ids[n] for n in with_]
        rows.append({"user_id": ids[person], "source": CALENDAR_SOURCE, "type": CALENDAR_TYPE, "value": value})
    return rows


def _shared_title(title: str, with_: list[str]) -> str:
    if not with_:
        return title
    lower = title.lower()
    if lower.startswith("dinner with"):
        return "Dinner"
    if lower.startswith("brunch with"):
        return "Brunch"
    return title


def build_personal_events(ids: dict[str, str], today: datetime, town_id: str) -> list[dict]:
    """One event per unique block. Shared dinners/brunches become a single row with both people."""
    seen: set[tuple] = set()
    rows = []
    for day, person, start, end, title, kind, building_id, place, with_ in SCHEDULE:
        names = tuple(sorted([person, *with_]))
        key = (day, start, end, names)
        if key in seen:
            continue
        seen.add(key)
        date = today + timedelta(days=day)
        dest = destination_for({"building_id": building_id, "text": place, "kind": kind}, ids[person])
        rows.append({
            "town_id": town_id,
            "type": EventType.personal.value,
            "title": _shared_title(title, with_),
            "text": place,
            "kind": kind,
            "start_at": _at(date, start),
            "end_at": _at(date, end),
            "building_id": dest,
            "travel_minutes": estimate_travel_minutes(dest, place),
            "status": EventStatus.active.value,
            "_people": [ids[n] for n in names],
        })
    return rows


def _find_auth_user(db, email: str) -> str | None:
    page = 1
    while True:
        users = db.auth.admin.list_users(page=page, per_page=200)
        for u in users:
            if (u.email or "").lower() == email:
                return u.id
        if len(users) < 200:
            return None
        page += 1


def ensure_members(db, town_id: str) -> dict[str, str]:
    rows = (
        db.table("town_members").select("user_id, profiles(display_name)").eq("town_id", town_id)
        .execute().data or []
    )
    by_name = {((r.get("profiles") or {}).get("display_name") or "").strip().lower(): r["user_id"] for r in rows}
    ids = {}
    for name, interests in PEOPLE.items():
        uid = by_name.get(name.lower())
        if not uid:
            email = f"{name.lower()}@{EMAIL_DOMAIN}"
            uid = _find_auth_user(db, email)
            if not uid:
                user = db.auth.admin.create_user(
                    {"email": email, "password": secrets.token_urlsafe(24), "email_confirm": True,
                     "user_metadata": {"name": name}}
                ).user
                uid = user.id
                print(f"created demo account {name} ({email})")
            db.table("profiles").update({"display_name": name}).eq("id", uid).execute()
            db.table("town_members").upsert({"town_id": town_id, "user_id": uid}, on_conflict="town_id,user_id").execute()
            print(f"added {name} to the town")
        profile = db.table("profiles").select("interests").eq("id", uid).limit(1).execute().data or [{}]
        merged = list(dict.fromkeys([*(profile[0].get("interests") or []), *interests]))
        db.table("profiles").update({"interests": merged}).eq("id", uid).execute()
        ids[name] = uid
    return ids


def main() -> None:
    town_id = settings.DEMO_TOWN_ID
    if not town_id:
        raise SystemExit("DEMO_TOWN_ID is not set")
    db = get_client()
    ids = ensure_members(db, town_id)
    removed = (
        db.table("signals").delete().in_("user_id", list(ids.values()))
        .eq("source", CALENDAR_SOURCE).eq("type", CALENDAR_TYPE).eq("value->>seed", SEED_TAG)
        .execute().data or []
    )
    today = local_now().replace(hour=0, minute=0, second=0, microsecond=0)
    rows = build_signals(ids, today)
    db.table("signals").insert(rows).execute()
    old_events = (
        db.table("events").delete().eq("town_id", town_id).eq("type", EventType.personal.value).execute().data or []
    )
    personal = build_personal_events(ids, today, town_id)
    created = 0
    for ev in personal:
        people = ev.pop("_people")
        rec = db.table("events").insert(ev).execute().data or []
        if not rec:
            continue
        db.table("event_participants").insert(
            [{"event_id": rec[0]["id"], "user_id": uid, "status": ParticipantStatus.accepted.value} for uid in people]
        ).execute()
        created += 1
    last = today + timedelta(days=max(r[0] for r in SCHEDULE))
    print(f"replaced {len(removed)} old calendar signals with {len(rows)} for {', '.join(ids)}")
    print(f"cleared {len(old_events)} events; wrote {created} personal events")
    print(f"schedule covers {today:%a %b %d} - {last:%a %b %d}")


if __name__ == "__main__":
    main()
