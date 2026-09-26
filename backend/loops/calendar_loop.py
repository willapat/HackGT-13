import asyncio

from backend.config import settings
from backend.db import get_client
from backend.google_calendar import sync_all
from backend.loops import log_loop_error


async def calendar_loop():
    """Re-reads everyone's connected Google Calendar every few minutes (no public URL needed)."""
    while True:
        try:
            await asyncio.to_thread(sync_all, get_client())
        except Exception as e:
            log_loop_error("calendar_loop", e)
        await asyncio.sleep(settings.CALENDAR_SYNC_INTERVAL_SECONDS)
