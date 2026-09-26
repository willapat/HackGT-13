"""Connect / sync / disconnect your Google Calendar (free/busy only). The refresh token never goes back out."""

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from backend.auth import current_user_id
from backend.db import get_client
from backend.google_calendar import PROVIDER, CalendarError, disconnect, sync_user

router = APIRouter(prefix="/me/calendar", tags=["calendar"])


class GoogleConnect(BaseModel):
    refresh_token: str = Field(min_length=10, max_length=2048)
    scopes: str | None = Field(default=None, max_length=1000)


def _status(db, uid: str) -> dict:
    rows = db.table("calendar_connections").select("provider, scopes, connected_at, last_synced_at, last_error") \
        .eq("user_id", uid).limit(1).execute().data
    if not rows:
        return {"connected": False}
    upcoming = (
        db.table("events").select("id, town_id, start_at").eq("imported_for", uid)
        .gte("end_at", datetime.now(timezone.utc).isoformat()).execute().data or []
    )
    blocks = {r["start_at"] for r in upcoming}  # the same block is copied into each town
    return {"connected": True, **rows[0], "upcoming_busy_blocks": len(blocks)}


@router.get("")
def calendar_status(uid: str = Depends(current_user_id)):
    return _status(get_client(), uid)


@router.post("/google")
def connect_google(body: GoogleConnect, uid: str = Depends(current_user_id)):
    """Save the Google refresh token from the sign-in redirect, then sync right away."""
    db = get_client()
    db.table("calendar_connections").upsert({
        "user_id": uid, "provider": PROVIDER, "refresh_token": body.refresh_token, "scopes": body.scopes,
        "connected_at": datetime.now(timezone.utc).isoformat(), "last_error": None,
    }, on_conflict="user_id").execute()
    try:
        sync_user(db, uid)
    except CalendarError:
        pass  # saved; the error is on the status for the page to show
    return _status(db, uid)


@router.post("/sync")
def sync_now(uid: str = Depends(current_user_id)):
    db = get_client()
    try:
        sync_user(db, uid)
    except CalendarError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _status(db, uid)


@router.delete("", status_code=204)
def disconnect_calendar(uid: str = Depends(current_user_id)):
    disconnect(get_client(), uid)
