from datetime import datetime

from pydantic import BaseModel


class SignalIn(BaseModel):
    """What the client POSTs to /signals."""

    user_id: str
    source: str
    type: str
    value: dict


class SignalRecord(SignalIn):
    id: str
    created_at: datetime
    expires_at: datetime | None = None
