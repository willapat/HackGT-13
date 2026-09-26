import asyncio

from backend.agent.agent import decide_for_character
from backend.config import settings
from backend.db import claim_due_agents, get_client
from backend.lease import claim_agent_lease
from backend.loops import log_loop_error


async def agent_loop():
    waiting = False
    while True:
        try:
            # supabase-py and OpenRouter calls are sync; threads keep the API responsive.
            if not await asyncio.to_thread(claim_agent_lease):
                if not waiting:
                    print("[agent_loop] another process holds the writer lease — skipping", flush=True)
                    waiting = True
            else:
                waiting = False
                for row in await asyncio.to_thread(claim_due_agents, get_client()):
                    await asyncio.to_thread(decide_for_character, row["town_id"], row["user_id"])
        except Exception as e:
            log_loop_error("agent_loop", e)
        await asyncio.sleep(settings.AGENT_LOOP_INTERVAL_SECONDS)
