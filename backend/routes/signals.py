from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id
from backend.brain.visibility import LEVELS
from backend.db import get_client
from backend.models.api import SignalIn

router = APIRouter(prefix="/signals", tags=["signals"])


@router.post("", status_code=201)
def create_signal(body: SignalIn, uid: str = Depends(current_user_id)):
    """Share something with your towns. Posting it is the opt-in; the brain picks it up on its next pass."""
    visibility = body.value.get("visibility")
    if visibility is not None and visibility not in LEVELS:
        raise HTTPException(status_code=422, detail=f"value.visibility must be one of {LEVELS}")
    rows = (
        get_client().table("signals")
        .insert({"user_id": uid, "source": body.source, "type": body.type, "value": body.value})
        .execute().data
    )
    if not rows:
        raise HTTPException(status_code=500, detail="insert failed")
    return rows[0]


@router.get("")
def list_signals(limit: int = Query(50, ge=1, le=200), uid: str = Depends(current_user_id)):
    """Your own signals, newest first. Nobody else can read them."""
    return (
        get_client().table("signals").select("*").eq("user_id", uid)
        .order("created_at", desc=True).limit(limit).execute().data or []
    )
