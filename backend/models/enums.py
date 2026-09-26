"""Python mirrors of every Postgres enum / constrained text the backend writes.

`AgentAction` matches the live `agent_action` enum byte-for-byte. The architecture
plan's `walk_to_building` name is accepted as an alias in validation, then written
as `walk_to`. Other plan enums are text columns in the condensed schema; values
here are the allowed set for validation.
"""

from enum import Enum


class InterestSource(str, Enum):
    stated = "stated"
    inferred = "inferred"


class VisibilityLevel(str, Enum):
    hidden = "hidden"
    vague = "vague"
    full = "full"


class WeatherKind(str, Enum):
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
    suggested = "suggested"
    active = "active"
    scheduled = "scheduled"
    completed = "completed"
    expired = "expired"
    cancelled = "cancelled"


class EventCreator(str, Enum):
    brain = "brain"
    agent = "agent"
    user = "user"


class ParticipantStatus(str, Enum):
    suggested = "suggested"
    invited = "invited"
    accepted = "accepted"
    declined = "declined"


class TaskStatus(str, Enum):
    pending = "pending"
    running = "running"
    needs_approval = "needs_approval"
    done = "done"
    failed = "failed"


class InteractionType(str, Enum):
    knock = "knock"
    gift = "gift"
    visit = "visit"
    chat = "chat"
    hangout = "hangout"


class InteractionVia(str, Enum):
    in_town = "in_town"
    real_life = "real_life"


FACT_CATEGORIES = frozenset({"mood", "busy", "interest", "news", "plan"})
