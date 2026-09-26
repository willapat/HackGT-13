"""Python mirrors of the Postgres enum and the text values the backend writes.

`AgentAction` matches the live `agent_action` enum byte-for-byte. The plan's
`walk_to_building` name is accepted as an alias in validation, then written as `walk_to`.
"""

from enum import Enum


class Visibility(str, Enum):
    """Set per signal in `signals.value.visibility`. Missing means full."""

    full = "full"
    vague = "vague"
    hidden = "hidden"


class Mood(str, Enum):
    """`town_members.mood`: the weather over someone's house."""

    sunny = "sunny"
    cloudy = "cloudy"
    rainy = "rainy"
    stormy = "stormy"
    rainbow = "rainbow"


class AgentAction(str, Enum):
    idle = "idle"
    walk_to = "walk_to"
    visit = "visit"
    knock = "knock"
    chat = "chat"
    leave_gift = "leave_gift"
    propose_event = "propose_event"
    go_home = "go_home"


# Plan name → live Postgres enum value
AGENT_ACTION_ALIASES = {"walk_to_building": AgentAction.walk_to.value}

POSTGRES_AGENT_ACTION_VALUES = tuple(a.value for a in AgentAction)


class EventType(str, Enum):
    quest = "quest"
    storyline = "storyline"
    town_event = "town_event"
    news = "news"


class EventStatus(str, Enum):
    suggested = "suggested"  # waiting on participants
    active = "active"  # news / storylines that are just shown
    scheduled = "scheduled"  # everyone accepted; plan drafted, waiting on a human to approve it
    confirmed = "confirmed"  # a participant approved the plan
    cancelled = "cancelled"  # someone declined


class ParticipantStatus(str, Enum):
    suggested = "suggested"
    accepted = "accepted"
    declined = "declined"


class InteractionVia(str, Enum):
    in_town = "in_town"
    real_life = "real_life"
