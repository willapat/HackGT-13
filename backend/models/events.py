from typing import Optional

from pydantic import BaseModel


class EventParticipantUpdate(BaseModel):
    event_id: str
    user_id: str
    status: str


class ActionTaskResult(BaseModel):
    event_id: str
    steps: list[dict]
    result: Optional[dict] = None
    error: Optional[str] = None
