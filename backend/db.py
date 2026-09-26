"""Thin supabase-py wrapper. Query composition and atomic claim only — no business logic."""

from datetime import datetime, timezone

from supabase import Client, create_client

from backend.config import settings

# Manifest keys the frontend already uses. DB stores these ids, not asset files.
TOWN_BUILDINGS = [
    {"id": "library", "type": "library"},
    {"id": "gym", "type": "gym"},
    {"id": "cafe", "type": "cafe"},
    {"id": "market", "type": "market"},
    {"id": "park", "type": "park"},
    {"id": "downtown", "type": "square"},
]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_client() -> Client:
    if not settings.SUPABASE_URL or not settings.SUPABASE_SECRET_KEY:
        raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SECRET_KEY)


def house_building_id(user_id: str) -> str:
    return f"house:{user_id}"


def buildings_for_town(member_user_ids: list[str]) -> list[dict]:
    houses = [{"id": house_building_id(uid), "type": "house"} for uid in member_user_ids]
    return [*TOWN_BUILDINGS, *houses]


async def claim_due_agents(town_id: str, limit: int = 10) -> list[dict]:
    """Atomically claim agents whose next_decision_at <= now(). See claim_due_agents RPC."""
    client = get_client()
    resp = client.rpc("claim_due_agents", {"p_town_id": town_id, "p_limit": limit}).execute()
    return resp.data or []


def towns_with_unprocessed_signals() -> list[dict]:
    client = get_client()
    resp = client.rpc("towns_with_unprocessed_signals").execute()
    return resp.data or []


def get_active_town_ids() -> list[str]:
    client = get_client()
    resp = client.table("towns").select("id").execute()
    return [row["id"] for row in (resp.data or [])]
