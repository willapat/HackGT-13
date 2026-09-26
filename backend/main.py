from contextlib import asynccontextmanager
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from postgrest.exceptions import APIError

from backend.loops.agent_loop import agent_loop
from backend.loops.brain_loop import brain_loop
from backend.routes import demo, events, friends, invites, me, signals, towns


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


app = FastAPI(title="Luma", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# Database errors come back as JSON (with CORS headers) instead of a bare 500 the browser reports as
# "can't reach the backend". A missing column means a migration hasn't been applied yet.
@app.exception_handler(APIError)
def database_error(request: Request, exc: APIError):
    if exc.code in ("PGRST204", "42703"):
        return JSONResponse(status_code=503, content={"detail": "The database is missing a column this needs. Apply the latest migration (it lands when the branch merges to main)."})
    return JSONResponse(status_code=502, content={"detail": f"Database error: {exc.message}"})


for module in (me, friends, invites, signals, towns, events, demo):
    app.include_router(module.router)


# Newer FastAPI router include can drop GET when POST is also registered on the same path.
app.add_api_route("/demo/trigger/{scenario}", demo.trigger_demo, methods=["GET"])


@app.get("/health")
def health():
    return {"ok": True}
