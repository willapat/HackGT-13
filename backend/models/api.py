"""Request bodies for the REST API. Responses are the Supabase rows as-is."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field


class ProfileUpdate(BaseModel):
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


class SignalIn(BaseModel):
    source: str = Field(min_length=1, max_length=40)  # 'manual', 'calendar', 'music', ...
    type: str = Field(min_length=1, max_length=40)
    value: dict  # may include "visibility": "full" | "vague" | "hidden"


class EventCreate(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    text: str | None = Field(default=None, max_length=1000)
    participant_ids: list[UUID] = Field(min_length=1, max_length=10)  # townmates to invite, besides you


class EventRespond(BaseModel):
    status: Literal["accepted", "declined"]
