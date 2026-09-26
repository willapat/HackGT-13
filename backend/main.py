from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.loops.agent_loop import agent_loop
from backend.loops.brain_loop import brain_loop
from backend.loops.calendar_loop import calendar_loop
from backend.routes import calendar, demo, events, friends, invites, me, signals, towns


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    tasks = []
    # Calendar sync isn't AI, so it runs even with DISABLE_LOOPS=1 (DISABLE_CALENDAR_SYNC=1 turns it off).
    if os.getenv("DISABLE_CALENDAR_SYNC") != "1":
        tasks.append(asyncio.create_task(calendar_loop()))
    if os.getenv("DISABLE_LOOPS") != "1":
        tasks += [asyncio.create_task(brain_loop()), asyncio.create_task(agent_loop())]
    yield
    for task in tasks:
        task.cancel()


app = FastAPI(title="Tiny Town", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
for module in (me, calendar, friends, invites, signals, towns, events, demo):
    app.include_router(module.router)


# Newer FastAPI router include can drop GET when POST is also registered on the same path.
app.add_api_route("/demo/trigger/{scenario}", demo.trigger_demo, methods=["GET"])


@app.get("/health")
def health():
    return {"ok": True}
