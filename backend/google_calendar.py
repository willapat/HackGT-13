"""Google Calendar → Luma: your character goes where your calendar says.

A person connects Google in the account app (read-only access to events); the backend keeps their
refresh token in `calendar_connections` (backend-only). Every CALENDAR_SYNC_INTERVAL_SECONDS the calendar
loop reads events on every calendar under My calendars for the next CALENDAR_SYNC_DAYS and replaces their
imported `events`, one copy per town they're in. Each event's title and location are matched against that town's places ("Market" →
the market); events that don't name one are sorted by the model in `calendar_places` ("CS 1332" →
university), and anything else goes downtown or home. Only the place is stored ("At the Market"), never
the event's own title or details, so townmates don't see them.
"""

import re
import unicodedata
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx

from backend.calendar_places import Guesser, place_label, resolve_building, travel_minutes_for
from backend.config import settings
from backend.db import now_iso, parse_ts
from backend.models.enums import EventStatus, EventType, ParticipantStatus
from backend.town_map import PLACE_TYPES, house_building_id

PROVIDER = "google"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/{calendar_id}/events"
RECONNECT = "Luma can only see your main calendar until you reconnect. Reconnect Google Calendar so it can read every calendar under My calendars."


class CalendarError(Exception):
    """Something the person should see (e.g. access revoked: reconnect)."""


def access_token(refresh_token: str) -> str:
    if not settings.GOOGLE_CLIENT_ID or not settings.GOOGLE_CLIENT_SECRET:
        raise CalendarError("The backend is missing GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env")
    resp = httpx.post(TOKEN_URL, data={
        "client_id": settings.GOOGLE_CLIENT_ID,
        "client_secret": settings.GOOGLE_CLIENT_SECRET,
        "refresh_token": refresh_token,
        "grant_type": "refresh_token",
    }, timeout=15)
    if resp.status_code == 400 and resp.json().get("error") == "invalid_grant":
        raise CalendarError("Google access was removed or expired. Reconnect Google Calendar.")
    resp.raise_for_status()
    return resp.json()["access_token"]


def _pages(token: str, url: str, params: dict) -> list[dict]:
    items = []
    while True:
        resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=15)
        if resp.status_code == 403:
            raise CalendarError(RECONNECT)
        resp.raise_for_status()
        body = resp.json()
        items.extend(body.get("items") or [])
        page = body.get("nextPageToken")
        if not page:
            return items
        params = {**params, "pageToken": page}


def list_my_calendars(token: str) -> list[str]:
    """Calendar ids under My calendars: ones you own. Subscribed calendars (Other calendars) are left out."""
    rows = _pages(token, CALENDAR_LIST_URL, {"maxResults": "250"})
    owned = [c["id"] for c in rows if c.get("id") and c.get("accessRole") == "owner" and not c.get("deleted")]
    return owned or ["primary"]


def list_events(token: str, start: datetime, end: datetime, calendar_id: str = "primary") -> list[dict]:
    """Timed events on one calendar in [start, end): {start, end, title, location}.
    Skips all-day events, events marked Free, and ones you declined, like Google's own busy times do."""
    url = EVENTS_URL.format(calendar_id=quote(calendar_id, safe=""))
    params = {"timeMin": start.isoformat(), "timeMax": end.isoformat(), "singleEvents": "true",
              "orderBy": "startTime", "maxResults": "250"}
    out = []
    for ev in _pages(token, url, params):
        s, e = (ev.get("start") or {}).get("dateTime"), (ev.get("end") or {}).get("dateTime")
        declined = any(a.get("self") and a.get("responseStatus") == "declined" for a in ev.get("attendees") or [])
        if not s or not e or ev.get("status") == "cancelled" or ev.get("transparency") == "transparent" or declined:
            continue
        out.append({"start": parse_ts(s), "end": parse_ts(e), "title": ev.get("summary") or "", "location": ev.get("location") or ""})
    return out


def _can_list_calendars(scopes: str | None) -> bool:
    scopes = scopes or ""
    return "calendarlist.readonly" in scopes or "calendar.readonly" in scopes


def _words(text: str) -> list[str]:
    """Lowercase words without accents, so "Café" matches "cafe"."""
    plain = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()
    return re.findall(r"[a-z0-9]+", plain)


def match_place(places: list[dict], title: str, location: str) -> dict | None:
    """The town place an event names in its title or location, by whole words. Longest name wins, so
    "Farmers Market" beats "Market" and "Pocket Park" beats "Park"."""
    text = f" {' '.join(_words(f'{title} {location}'))} "
    best, best_len = None, 0
    for p in places:
        for label in (p["id"].replace("_", " "), p.get("name") or ""):
            phrase = " ".join(_words(label))
            if phrase and f" {phrase} " in text and len(phrase) > best_len:
                best, best_len = p, len(phrase)
    return best


def _town_places(town: dict | None) -> list[dict]:
    """The town's named places ({id, name}); towns without a map yet have the standard ones."""
    places = ((town or {}).get("map") or {}).get("places") or {}
    return [{"id": pid, "name": p.get("name")} for pid, p in places.items()] or [{"id": pid, "name": None} for pid in PLACE_TYPES]


def replace_imported(db, user_id: str, events: list[dict]) -> int:
    """Swap this person's imported events for `events`, one copy per town, each sent to the matching place."""
    db.table("events").delete().eq("imported_for", user_id).execute()
    towns = db.table("town_members").select("town_id, towns(map)").eq("user_id", user_id).execute().data or []
    if not events or not towns:
        return 0
    home = house_building_id(user_id)
    guesser = Guesser(db, user_id)
    rows = []
    for t in towns:
        places = _town_places(t.get("towns"))
        for ev in events:
            place = match_place(places, ev["title"], ev["location"])
            if place:
                where, name = place["id"], place_label(place)
            else:
                where, name = resolve_building(places, guesser.choose(t["town_id"], places, ev["title"], ev["location"]), home)
            start = ev["start"].isoformat()
            rows.append({
                "town_id": t["town_id"], "type": EventType.personal.value,
                # Only the place townmates can see, never the calendar's own title
                "title": f"At {name}" if name else "Busy",
                "kind": "activity" if name else "appointment",
                "start_at": start, "end_at": ev["end"].isoformat(), "building_id": where,
                "travel_minutes": travel_minutes_for(user_id, start, where), "status": EventStatus.active.value,
                "imported_from": PROVIDER, "imported_for": user_id,
            })
    guesser.save()
    created = db.table("events").insert(rows).execute().data or []
    if created:
        db.table("event_participants").insert([
            {"event_id": ev["id"], "user_id": user_id, "status": ParticipantStatus.accepted.value} for ev in created
        ]).execute()
    return len(events)


def sync_user(db, user_id: str) -> dict:
    """Refresh one person's imported busy times. Records success or the error on their connection."""
    rows = db.table("calendar_connections").select("*").eq("user_id", user_id).limit(1).execute().data
    if not rows:
        raise CalendarError("Google Calendar isn't connected.")
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(days=settings.CALENDAR_SYNC_DAYS)
    try:
        if not _can_list_calendars(rows[0].get("scopes")):
            raise CalendarError(RECONNECT)
        token = access_token(rows[0]["refresh_token"])
        events, seen = [], set()
        for calendar_id in list_my_calendars(token):
            for ev in list_events(token, start, end, calendar_id):
                key = (ev["start"], ev["end"], ev["title"], ev["location"])
                if key not in seen:
                    seen.add(key)
                    events.append(ev)
        count = replace_imported(db, user_id, events)
    except CalendarError as e:
        db.table("calendar_connections").update({"last_error": str(e)}).eq("user_id", user_id).execute()
        raise
    except httpx.HTTPError as e:
        db.table("calendar_connections").update({"last_error": "Couldn't reach Google. Will retry."}).eq("user_id", user_id).execute()
        raise CalendarError("Couldn't reach Google. Try again in a bit.") from e
    db.table("calendar_connections").update({"last_synced_at": now_iso(), "last_error": None}).eq("user_id", user_id).execute()
    return {"events": count}


def sync_all(db) -> None:
    for row in db.table("calendar_connections").select("user_id").execute().data or []:
        try:
            sync_user(db, row["user_id"])
        except Exception as e:  # one person's calendar never stops the others
            print(f"calendar sync failed for {row['user_id']}: {e}")


def disconnect(db, user_id: str) -> None:
    """Forget the connection, remove imported events, and tell Google to revoke access (best effort)."""
    rows = db.table("calendar_connections").select("refresh_token").eq("user_id", user_id).limit(1).execute().data
    db.table("events").delete().eq("imported_for", user_id).execute()
    try:
        db.table("calendar_place_guesses").delete().eq("user_id", user_id).execute()
    except Exception as e:  # table not migrated yet
        print(f"calendar place cache cleanup failed: {type(e).__name__}")
    db.table("calendar_connections").delete().eq("user_id", user_id).execute()
    if rows:
        try:
            httpx.post(REVOKE_URL, data={"token": rows[0]["refresh_token"]}, timeout=10)
        except httpx.HTTPError:
            pass
