"""Building models the generator may use (asset paths under town/assets, without .glb), and the plan
Gemini fills in. Keep in step with town/assets and the tile words in backend/town_map.py."""

from typing import Literal

from pydantic import BaseModel, Field

SP, KC, KS = "simplepoly-city/", "city-kit-commercial/", "city-kit-suburban/"

TALL = (  # towers, 1.5-2.5 tiles high: downtown cores of big cities
    [KC + f"building-skyscraper-{c}" for c in "abcde"] + [KC + "building-m"]
    + [SP + f"building-sky-big-color0{n}" for n in (1, 2, 3)] + [SP + f"building-sky-small-color0{n}" for n in (1, 2, 3)]
)
MID = (  # apartments and larger shops, about 1-1.4 tiles high
    [SP + f"building-residential-color0{n}" for n in (1, 2, 3)] + [KC + f"building-{c}" for c in "abdfghil"]
    + [SP + f"building-{n}" for n in ("restaurant", "clothing", "fast-food", "drug-store", "pizza", "music-store")]
)
SMALL = (  # one-storey shops and cafés, about 1 tile high: small-town main streets
    [SP + f"building-{n}" for n in ("bakery", "bar", "chicken-shop", "fruits-shop", "gift-shop", "shoes-shop", "gas-station",
                                     "coffee-shop", "books-shop", "auto-service", "super-market", "factory")]
    + [KC + f"building-{c}" for c in "cejkn"]
)
HOUSES = [KS + f"building-type-{c}" for c in "abcdefghijklmnopqrstu"] + [
    SP + f"building-house-0{n}-color0{k}" for n in (1, 2, 3, 4) for k in (1, 2, 3)
]
STADIUM = SP + "building-stadium"
BUILDINGS = set(TALL) | set(MID) | set(SMALL)
DECOR = ("garden", "picnic", "plaza", "patio", "tree")


class PlacePlan(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,23}$")  # what AI characters call it, e.g. "cafe"
    name: str = Field(min_length=1, max_length=40)       # shown in town, e.g. "Bean There Café"
    model: str                                           # one of BUILDINGS


class TownPlan(BaseModel):
    """What Gemini designs. layout.build() turns it into tiles + map and enforces the town rules."""

    name: str = Field(default="Tiny Town", min_length=1, max_length=60)
    theme: str = Field(default="", max_length=200)
    size: int = 17                        # set by the engine from the member count (towngen.size_for)
    block_width: int = Field(default=3, ge=2, le=4)
    custom_style: bool = False            # user asked for a building style/height: keep the palettes when the town grows
    core_models: list[str] = Field(default_factory=list)    # buildings ringing the central park
    middle_models: list[str] = Field(default_factory=list)  # buildings in the blocks between core and suburbs
    places: list[PlacePlan] = Field(default_factory=list, max_length=10)
    park_name: str = Field(default="Central Park", max_length=40)
    home_slots: int = 6                   # set by the engine: 2x2 home plots, one per member the size tier holds
    background_density: float = 0.25     # share of free suburb street tiles given a background house, <= 0.35
    background_color: str = Field(default="#b8b2a7", pattern=r"^#[0-9a-fA-F]{6}$")
    outer_park: bool = True
    outer_park_name: str = Field(default="Pocket Park", max_length=40)
    landmark: Literal["none", "farm", "stadium"] = "none"
    decor: list[Literal["garden", "picnic", "plaza", "patio", "tree"]] = Field(default_factory=lambda: list(DECOR))
