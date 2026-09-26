"""Request bodies for the REST API. Responses are the Supabase rows as-is."""

from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field, field_validator, model_validator

# Matches the profiles.username check constraint; input is trimmed and lowercased first.
Username = Annotated[
    str, BeforeValidator(lambda v: v.strip().lower() if isinstance(v, str) else v), Field(pattern=r"^[a-z0-9_]{3,20}$")
]


class ProfileUpdate(BaseModel):
    username: Username | None = None
    display_name: str | None = Field(default=None, min_length=1, max_length=50)
    avatar: dict | None = None  # asset manifest keys
    interests: list[str] | None = Field(default=None, max_length=30)
    bio: str | None = Field(default=None, max_length=160)
    # IANA name from the browser (Intl), e.g. "America/Los_Angeles": the person's own "today" and plan hours.
    # Times themselves are always stored in UTC.
    timezone: str | None = Field(default=None, max_length=64)

    @field_validator("timezone")
    @classmethod
    def _real_zone(cls, v: str | None) -> str | None:
        if v is None:
            return v
        try:
            ZoneInfo(v)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("unknown time zone")
        return v


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
    name: str | None = Field(default=None, max_length=40)  # your own name for your house; default "<you>'s house"
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


class TownRevision(BaseModel):
    """A previewed town (the tiles and map POST /towns/generate returned) and what the user wants changed."""

    tiles: list[list[str]] = Field(min_length=1, max_length=31)
    map: dict
    feedback: str = Field(min_length=1, max_length=600)


class TownGenerate(BaseModel):
    """Describe a town and the model draws it (backend/towngen): any setting, from a city to a cabin retreat."""

    prompt: str = Field(min_length=1, max_length=1000)  # e.g. "a cozy seaside village with a climbing gym"
    name: str | None = Field(default=None, min_length=1, max_length=60)  # None = the planner names it
    me: MemberIdentity | None = None  # required to create; a preview doesn't need it (you pick it after approving)
    invite_user_ids: list[UUID] = Field(default_factory=list, max_length=23)  # friends to invite as soon as it exists
    places: list[str] = Field(default_factory=list, max_length=19)  # ids from GET /towns/place-options; [] = planner picks
    custom_places: list[Annotated[str, BeforeValidator(lambda v: v.strip() if isinstance(v, str) else v), Field(min_length=1, max_length=40)]] = Field(
        default_factory=list, max_length=8)  # anything else, by name ("Hospital"): placed on a random building
    landmarks: list[Literal["farm", "stadium"]] = Field(default_factory=list)
    # How it looks, if picked in the form (GET /towns/place-options); None = the planner decides from the prompt
    landscape: Literal["green", "autumn", "snowy", "desert"] | None = None
    style: Literal["city", "town", "suburbs", "village"] | None = None
    greenery: Literal["less", "normal", "lots"] | None = None

    @model_validator(mode="after")
    def _known_places(self):
        from backend.towngen.catalog import MAX_PLACES, PLACE_TYPES
        unknown = [p for p in self.places if p not in PLACE_TYPES]
        if unknown:
            raise ValueError(f"unknown place types: {unknown}")
        self.places = list(dict.fromkeys(self.places))
        self.custom_places = list(dict.fromkeys(self.custom_places))
        if len(self.places) + len(self.custom_places) > MAX_PLACES:
            raise ValueError(f"pick at most {MAX_PLACES} places")
        return self
    preview: bool = False  # true = return the design without creating the town
    revise: TownRevision | None = None  # redraw a previewed town with the user's changes (use with preview)
    design: dict | None = None  # the `plan` of a preview the user approved: built exactly as shown, no model call


class HouseName(BaseModel):
    name: str | None = Field(default=None, max_length=40)  # null or "" = back to "<you>'s house"


class BubbleIn(BaseModel):
    text: str = Field(min_length=1, max_length=200)

    @model_validator(mode="after")
    def one_line(self):
        from backend.house import BUBBLE_MAX, clean_text
        self.text = clean_text(self.text)
        if not self.text:
            raise ValueError("say something")
        if len(self.text) > BUBBLE_MAX:
            raise ValueError(f"keep it to {BUBBLE_MAX} characters")
        return self


class MoodIn(BaseModel):
    mood: str

    @model_validator(mode="after")
    def known(self):
        from backend.house import MOODS
        if self.mood not in MOODS:
            raise ValueError(f"mood must be one of {', '.join(MOODS)}")
        return self


class MailIn(BaseModel):
    to_user_id: UUID
    text: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def not_blank(self):
        self.text = self.text.strip()
        if not self.text:
            raise ValueError("write something")
        return self


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
    # how long the walk takes; omitted keeps the place estimate. Float so the page can send seconds (s / 60).
    travel_minutes: float | None = Field(default=None, gt=0, le=180)


class SignalIn(BaseModel):
    source: str = Field(min_length=1, max_length=40)  # 'manual', 'calendar', 'music', ...
    type: str = Field(min_length=1, max_length=40)
    value: dict  # may include "visibility": "full" | "vague" | "hidden"


class StatusIn(BaseModel):
    """Set or clear your free/busy status. `until` is required when setting one."""

    status: Literal["free", "busy"] | None = None
    until: datetime | None = None


class ClockIn(BaseModel):
    """Drive the shared town clock from the 3D time slider."""

    hour: float | None = Field(default=None, ge=0, le=24)
    live: bool = False
    fast: bool = False
    play: bool = False  # one game minute per real second


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
