import asyncio

from backend.brain.brain import run_brain_for_town
from backend.config import settings
from backend.db import get_client, towns_with_unprocessed_signals
from backend.loops import log_loop_error


async def brain_loop():
    while True:
        try:
            for town_id in await asyncio.to_thread(towns_with_unprocessed_signals, get_client()):
                await asyncio.to_thread(run_brain_for_town, town_id)
        except Exception as e:
            log_loop_error("brain_loop", e)
        await asyncio.sleep(settings.BRAIN_LOOP_INTERVAL_SECONDS)
