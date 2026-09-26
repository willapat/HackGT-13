"""Google Calendar → Luma, free/busy only.

A person connects Google in the account app; the backend keeps their refresh token in
`calendar_connections` (backend-only). Every CALENDAR_SYNC_INTERVAL_SECONDS the calendar loop asks
Google when they're busy over the next CALENDAR_SYNC_DAYS and replaces their imported `events`:
one `personal` "Busy" event per block, in every town they're in, at their own house. No titles or
details are read, only busy times, so nothing is made up or over-shared about anyone.
"""

from datetime import datetime, timedelta, timezone

import httpx

from backend.calendar_drive import estimate_travel_minutes
from backend.config import settings
from backend.db import now_iso, parse_ts
from backend.models.enums import EventStatus, EventType, ParticipantStatus
from backend.town_map import house_building_id

PROVIDER = "google"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy"


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


def busy_times(token: str, start: datetime, end: datetime) -> list[tuple[datetime, datetime]]:
    """Busy blocks on the person's primary calendar in [start, end). Google merges overlaps already."""
    resp = httpx.post(FREEBUSY_URL, headers={"Authorization": f"Bearer {token}"}, json={
        "timeMin": start.isoformat(), "timeMax": end.isoformat(), "items": [{"id": "primary"}],
    }, timeout=15)
    if resp.status_code == 403:
        raise CalendarError("Luma isn't allowed to see your free/busy times. Reconnect and allow calendar access.")
    resp.raise_for_status()
    cal = resp.json().get("calendars", {}).get("primary", {})
    if cal.get("errors"):
        raise CalendarError(f"Google couldn't read your calendar ({cal['errors'][0].get('reason', 'unknown')}).")
    return [(parse_ts(b["start"]), parse_ts(b["end"])) for b in cal.get("busy", [])]


def replace_imported(db, user_id: str, blocks: list[tuple[datetime, datetime]]) -> int:
    """Swap this person's imported events for `blocks`, copied into every town they're in."""
    db.table("events").delete().eq("imported_for", user_id).execute()
    towns = db.table("town_members").select("town_id").eq("user_id", user_id).execute().data or []
    if not blocks or not towns:
        return 0
    home = house_building_id(user_id)
    rows = [{
        "town_id": t["town_id"], "type": EventType.personal.value, "title": "Busy", "kind": "appointment",
        "start_at": s.isoformat(), "end_at": e.isoformat(), "building_id": home,
        "travel_minutes": estimate_travel_minutes(home), "status": EventStatus.active.value,
        "imported_from": PROVIDER, "imported_for": user_id,
    } for t in towns for s, e in blocks]
    created = db.table("events").insert(rows).execute().data or []
    if created:
        db.table("event_participants").insert([
            {"event_id": ev["id"], "user_id": user_id, "status": ParticipantStatus.accepted.value} for ev in created
        ]).execute()
    return len(blocks)


def sync_user(db, user_id: str) -> dict:
    """Refresh one person's imported busy times. Records success or the error on their connection."""
    rows = db.table("calendar_connections").select("*").eq("user_id", user_id).limit(1).execute().data
    if not rows:
        raise CalendarError("Google Calendar isn't connected.")
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    end = start + timedelta(days=settings.CALENDAR_SYNC_DAYS)
    try:
        blocks = busy_times(access_token(rows[0]["refresh_token"]), start, end)
        count = replace_imported(db, user_id, blocks)
    except CalendarError as e:
        db.table("calendar_connections").update({"last_error": str(e)}).eq("user_id", user_id).execute()
        raise
    except httpx.HTTPError as e:
        db.table("calendar_connections").update({"last_error": "Couldn't reach Google. Will retry."}).eq("user_id", user_id).execute()
        raise CalendarError("Couldn't reach Google. Try again in a bit.") from e
    db.table("calendar_connections").update({"last_synced_at": now_iso(), "last_error": None}).eq("user_id", user_id).execute()
    return {"busy_blocks": count}


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
