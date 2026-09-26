from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException

from backend.db import get_client
from backend.models.signals import SignalIn, SignalRecord

router = APIRouter()


@router.post("/signals", response_model=SignalRecord)
def create_signal(body: SignalIn):
    db = get_client()
    consent = (
        db.table("consents")
        .select("user_id, revoked_at")
        .eq("user_id", body.user_id)
        .eq("source", body.source)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not consent or consent[0].get("revoked_at"):
        raise HTTPException(status_code=403, detail="no unrevoked consent for this source")
    created = datetime.now(timezone.utc)
    expires = created + timedelta(days=7)
    row = (
        db.table("signals")
        .insert(
            {
                "user_id": body.user_id,
                "source": body.source,
                "type": body.type,
                "value": body.value,
                "expires_at": expires.isoformat(),
            }
        )
        .execute()
        .data
        or []
    )
    if not row:
        raise HTTPException(status_code=500, detail="insert failed")
    rec = row[0]
    return SignalRecord(
        id=rec["id"],
        user_id=rec["user_id"],
        source=rec["source"],
        type=rec["type"],
        value=rec["value"],
        created_at=rec["created_at"],
        expires_at=rec.get("expires_at"),
    )
