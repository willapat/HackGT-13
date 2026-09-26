from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.loops.agent_loop import agent_loop
from backend.loops.brain_loop import brain_loop
from backend.routes import demo, events, me, signals, towns


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    if os.getenv("DISABLE_LOOPS") == "1":
        yield
        return
    brain_task = asyncio.create_task(brain_loop())
    agent_task = asyncio.create_task(agent_loop())
    yield
    brain_task.cancel()
    agent_task.cancel()


app = FastAPI(title="Tiny Town", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
for module in (me, signals, towns, events, demo):
    app.include_router(module.router)


@app.get("/health")
def health():
    return {"ok": True}
