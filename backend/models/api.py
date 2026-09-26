"""Request bodies for the REST API. Responses are the Supabase rows as-is."""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, model_validator

# Matches the profiles.username check constraint; input is trimmed and lowercased first.
Username = Annotated[
    str, BeforeValidator(lambda v: v.strip().lower() if isinstance(v, str) else v), Field(pattern=r"^[a-z0-9_]{3,20}$")
]


class ProfileUpdate(BaseModel):
    username: Username | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=50)
    avatar: dict | None = None  # asset manifest keys
    interests: list[str] | None = Field(default=None, max_length=30)


Tile = Annotated[list[int], Field(min_length=2, max_length=2)]  # [x, y]
MAX_GRID = 64


def _rectangular(tiles: list[list[str]]) -> list[list[str]]:
    if tiles and len({len(row) for row in tiles}) != 1:
        raise ValueError("every tiles row must have the same length")
    if len(tiles) > MAX_GRID or (tiles and len(tiles[0]) > MAX_GRID):
        raise ValueError(f"town map can be at most {MAX_GRID}x{MAX_GRID}")
    return tiles


# tiles[y][x]: any width x height (all rows the same width), see backend/town_map.py
Tiles = Annotated[list[list[Annotated[str, Field(min_length=1, max_length=80)]]], AfterValidator(_rectangular)]


class Place(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    tile: Tile
    door: Tile  # where characters stand when they visit


class TownMap(BaseModel):
    """towns.map. Named places plus scenery settings (e.g. "landmarks"), which pass through as-is."""

    model_config = ConfigDict(extra="allow")
    places: dict[str, Place] = Field(default_factory=dict)


class Home(BaseModel):
    """town_members.home. The house tile itself is house_x/house_y."""

    model: str | None = Field(default=None, max_length=80)
    driveway: Tile | None = None
    door: Tile | None = None
    block: Annotated[list[int], Field(min_length=4, max_length=4)] | None = None  # x0, y0, x1, y1 inclusive


# Your name and color in one town (town_members.name / .color), picked when you create or join it
TownName = Annotated[str, BeforeValidator(lambda v: " ".join(v.split()) if isinstance(v, str) else v), Field(min_length=1, max_length=30)]
HexColor = Annotated[str, BeforeValidator(lambda v: v.strip().lower() if isinstance(v, str) else v), Field(pattern=r"^#[0-9a-f]{6}$")]


class MemberIdentity(BaseModel):
    name: TownName
    color: HexColor


class IdentityUpdate(BaseModel):
    name: TownName | None = None
    color: HexColor | None = None


class TownCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    tiles: Tiles = Field(default_factory=list)
    map: TownMap = Field(default_factory=TownMap)
    me: MemberIdentity


class TownUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    tiles: Tiles | None = None
    map: TownMap | None = None


class TownGenerate(BaseModel):
    """Describe a town and Gemini designs it (backend/towngen). The town rules always apply."""

    prompt: str = Field(min_length=1, max_length=1000)  # e.g. "a cozy seaside village with a climbing gym"
    name: str | None = Field(default=None, min_length=1, max_length=60)  # None = the planner names it
    me: MemberIdentity
    invite_user_ids: list[UUID] = Field(default_factory=list, max_length=23)  # friends to invite as soon as it exists
    preview: bool = False  # true = return the design without creating the town


class JoinTown(BaseModel):
    invite_code: str = Field(min_length=1, max_length=20)
    me: MemberIdentity


class HouseUpdate(BaseModel):
    house_x: int = Field(ge=0)
    house_y: int = Field(ge=0)
    home: Home | None = None


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
    building_id: str | None = Field(default=None, max_length=80)  # filled from text/kind if omitted
    travel_minutes: int | None = Field(default=None, ge=1, le=120)
    participant_ids: list[UUID] = Field(default_factory=list, max_length=10)  # other people going, besides you


class Respond(BaseModel):
    """Answer to an event, friend request, or town invite."""

    status: Literal["accepted", "declined"]


class InviteRespond(Respond):
    """Accepting a town invite also picks your name and color there."""

    me: MemberIdentity | None = None

    @model_validator(mode="after")
    def identity_when_accepting(self):
        if self.status == "accepted" and self.me is None:
            raise ValueError("pick your name and color for this town (me: {name, color}) to accept")
        return self


class FriendRequestIn(BaseModel):
    username: Username


class TownInviteIn(BaseModel):
    user_id: UUID  # must already be your friend
