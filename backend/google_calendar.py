"""Google Calendar → Luma: your character goes where your calendar says.

A person connects Google in the account app (read-only access to events); the backend keeps their
refresh token in `calendar_connections` (backend-only). Every CALENDAR_SYNC_INTERVAL_SECONDS the calendar
loop reads their events for the next CALENDAR_SYNC_DAYS and replaces their imported `events`, one copy per
town they're in. Each event's title and location are matched against that town's places ("Market" →
the market): a match sends the character there, anything else sends them home. Only the matched place
is stored ("At the Market"), never the event's own title or details, so townmates don't see them.
"""

import re
import unicodedata
from datetime import datetime, timedelta, timezone

import httpx

from backend.calendar_drive import estimate_travel_minutes
from backend.config import settings
from backend.db import now_iso, parse_ts
from backend.models.enums import EventStatus, EventType, ParticipantStatus
from backend.town_map import PLACE_TYPES, house_building_id

PROVIDER = "google"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


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


def list_events(token: str, start: datetime, end: datetime) -> list[dict]:
    """Timed events on the primary calendar in [start, end): {start, end, title, location}.
    Skips all-day events, events marked Free, and ones you declined, like Google's own busy times do."""
    params = {"timeMin": start.isoformat(), "timeMax": end.isoformat(), "singleEvents": "true",
              "orderBy": "startTime", "maxResults": "250"}
    resp = httpx.get(EVENTS_URL, headers={"Authorization": f"Bearer {token}"}, params=params, timeout=15)
    if resp.status_code == 403:
        raise CalendarError("Luma can't read your events yet. Reconnect Google Calendar and allow access to your events.")
    resp.raise_for_status()
    out = []
    for ev in resp.json().get("items", []):
        s, e = (ev.get("start") or {}).get("dateTime"), (ev.get("end") or {}).get("dateTime")
        declined = any(a.get("self") and a.get("responseStatus") == "declined" for a in ev.get("attendees") or [])
        if not s or not e or ev.get("status") == "cancelled" or ev.get("transparency") == "transparent" or declined:
            continue
        out.append({"start": parse_ts(s), "end": parse_ts(e), "title": ev.get("summary") or "", "location": ev.get("location") or ""})
    return out


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
    rows = []
    for t in towns:
        places = _town_places(t.get("towns"))
        for ev in events:
            place = match_place(places, ev["title"], ev["location"])
            where = place["id"] if place else home
            rows.append({
                "town_id": t["town_id"], "type": EventType.personal.value,
                # Only the place townmates can see, never the calendar's own title
                "title": f"At {place.get('name') or place['id'].replace('_', ' ').title()}" if place else "Busy",
                "kind": "activity" if place else "appointment",
                "start_at": ev["start"].isoformat(), "end_at": ev["end"].isoformat(), "building_id": where,
                "travel_minutes": estimate_travel_minutes(where), "status": EventStatus.active.value,
                "imported_from": PROVIDER, "imported_for": user_id,
            })
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
        events = list_events(access_token(rows[0]["refresh_token"]), start, end)
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
    db.table("calendar_connections").delete().eq("user_id", user_id).execute()
    if rows:
        try:
            httpx.post(REVOKE_URL, data={"token": rows[0]["refresh_token"]}, timeout=10)
        except httpx.HTTPError:
            pass
