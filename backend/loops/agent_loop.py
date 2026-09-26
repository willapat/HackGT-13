import asyncio

from backend.agent.agent import decide_for_character
from backend.config import settings
from backend.db import claim_due_agents, get_active_town_ids
from backend.loops import log_loop_error


async def agent_loop():
    while True:
        try:
            for town_id in get_active_town_ids():
                claimed = await claim_due_agents(town_id, limit=10)
                for row in claimed:
                    await decide_for_character(town_id, row["user_id"])
        except Exception as e:
            log_loop_error("agent_loop", e)
        await asyncio.sleep(settings.AGENT_LOOP_INTERVAL_SECONDS)
