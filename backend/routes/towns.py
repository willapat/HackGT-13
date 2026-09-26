from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.db import get_client

router = APIRouter()


class JoinBody(BaseModel):
    invite_code: str


@router.post("/towns/{town_id}/join")
def join_town(town_id: str, body: JoinBody):
    """P1-ish but listed in §10. Uses towns.invite_code (no town_invites table in live schema)."""
    raise HTTPException(
        status_code=501,
        detail="Join via supabase.rpc('join_town', { code }) on the frontend. Server-side invite max-uses is P1.",
    )
