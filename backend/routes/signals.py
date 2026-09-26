from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id, require_member
from backend.brain.visibility import LEVELS
from backend.db import get_client
from backend.models.api import SignalIn

router = APIRouter(prefix="/signals", tags=["signals"])


AUDIENCES = ("town", "friends", "private")


@router.post("", status_code=201)
def create_signal(body: SignalIn, uid: str = Depends(current_user_id)):
    """Share something with your towns. Posting it is the opt-in; the brain picks it up on its next pass.

    A post can say who it's for in `value.audience`: "town" (with `value.town_id`, one town you're in),
    "friends" (your friends see it on their feed; all your towns' brains read it), or "private" (nobody sees
    it; your towns may only change your character's mood from it, so it's stored with visibility "mood")."""
    audience = body.value.get("audience")
    if audience is not None:
        if audience not in AUDIENCES:
            raise HTTPException(status_code=422, detail=f"value.audience must be one of {AUDIENCES}")
        if audience == "town":
            tid = str(body.value.get("town_id") or "")
            if not tid:
                raise HTTPException(status_code=422, detail="pick which town this post is for")
            require_member(get_client(), tid, uid)
        else:
            body.value.pop("town_id", None)
        body.value["visibility"] = "mood" if audience == "private" else body.value.get("visibility", "full")
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
