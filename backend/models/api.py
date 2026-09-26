"""Request bodies for the REST API. Responses are the Supabase rows as-is."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, BeforeValidator, Field

# Matches the profiles.username check constraint; input is trimmed and lowercased first.
Username = Annotated[
    str, BeforeValidator(lambda v: v.strip().lower() if isinstance(v, str) else v), Field(pattern=r"^[a-z0-9_]{3,20}$")
]


class ProfileUpdate(BaseModel):
    username: Username | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=50)
    avatar: dict | None = None  # asset manifest keys
    interests: list[str] | None = Field(default=None, max_length=30)


class TownCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    tiles: list[list[str]] = Field(default_factory=list)  # tiles[y][x], asset manifest keys


class TownUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    tiles: list[list[str]] | None = None


class JoinTown(BaseModel):
    invite_code: str = Field(min_length=1, max_length=20)


class HouseUpdate(BaseModel):
    house_x: int = Field(ge=0)
    house_y: int = Field(ge=0)


class MoveIn(BaseModel):
    building_id: str = Field(min_length=1, max_length=80)  # a place id ("cafe") or "house:<user_id>"
    from_x: float = Field(ge=0)  # where your character is right now (fractional mid-walk is fine)
    from_y: float = Field(ge=0)


class SignalIn(BaseModel):
    source: str = Field(min_length=1, max_length=40)  # 'manual', 'calendar', 'music', ...
    type: str = Field(min_length=1, max_length=40)
    value: dict  # may include "visibility": "full" | "vague" | "hidden"


class ClockIn(BaseModel):
    """Drive the shared town clock from the 3D time slider."""

    hour: float | None = Field(default=None, ge=0, le=24)
    live: bool = False
    fast: bool = False


class EventCreate(BaseModel):
    """A calendar item the user is sharing: class, work, gym, dinner, etc."""

    title: str = Field(min_length=1, max_length=120)
    text: str | None = Field(default=None, max_length=1000)
    kind: str = Field(default="activity", max_length=40)  # class, work, social, activity, appointment
    start: str  # ISO timestamp
    end: str
    building_id: str | None = None
    travel_minutes: int | None = Field(default=None, ge=1, le=120)
    participant_ids: list[UUID] = Field(default_factory=list, max_length=10)  # other people going, besides you


class Respond(BaseModel):
    """Answer to an event, friend request, or town invite."""

    status: Literal["accepted", "declined"]


class FriendRequestIn(BaseModel):
    username: Username


class TownInviteIn(BaseModel):
    user_id: UUID  # must already be your friend
