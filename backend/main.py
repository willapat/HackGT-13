from contextlib import asynccontextmanager
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.loops.agent_loop import agent_loop
from backend.loops.brain_loop import brain_loop
from backend.routes.demo import router as demo_router
from backend.routes.events import router as events_router
from backend.routes.interests import router as interests_router
from backend.routes.signals import router as signals_router
from backend.routes.towns import router as towns_router


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
app.include_router(signals_router)
app.include_router(towns_router)
app.include_router(interests_router)
app.include_router(events_router)
app.include_router(demo_router)


@app.get("/health")
def health():
    return {"ok": True}
