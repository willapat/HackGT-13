"""Town Brain output. Stored (after visibility filtering) in `brain_runs.output`."""

from typing import Literal

from pydantic import BaseModel, Field

from backend.models.enums import Mood, Visibility


class Fact(BaseModel):
    user_id: str
    category: Literal["mood", "busy", "interest", "news", "plan"]
    fact: str
    source_signal_ids: list[str] = Field(default_factory=list)
    visibility: Visibility = Visibility.full


class MemberState(BaseModel):
    user_id: str
    mood: Mood
    activity: str | None = None
    props: dict = Field(default_factory=dict)  # extra render props, e.g. {"party_lights": true}


class NewsItem(BaseModel):
    title: str
    text: str | None = None


class QuestCandidate(BaseModel):
    title: str
    text: str
    participant_user_ids: list[str]


class BrainOutput(BaseModel):
    facts: list[Fact] = Field(default_factory=list)
    member_states: list[MemberState] = Field(default_factory=list)
    news: list[NewsItem] = Field(default_factory=list)
    quest_candidates: list[QuestCandidate] = Field(default_factory=list)
