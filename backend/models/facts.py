from typing import Literal, Optional

from pydantic import BaseModel, Field


class FactWrite(BaseModel):
    user_id: str
    town_id: Optional[str] = None
    category: Literal["mood", "busy", "interest", "news", "plan"]
    fact: str
    source_signal_ids: list[str] = Field(default_factory=list)
    confidence: float = Field(ge=0.0, le=1.0)
    visibility: str


class MemberStateWrite(BaseModel):
    town_id: str
    user_id: str
    weather: str
    activity: Optional[str] = None
    location_building_id: Optional[str] = None
    props: dict = Field(default_factory=dict)


class NewsWrite(BaseModel):
    town_id: str
    text: str
    event_id: Optional[str] = None


class QuestCandidate(BaseModel):
    town_id: str
    title: str
    text: str
    participant_user_ids: list[str]
    building_id: Optional[str] = None
    fact_ids: list[str] = Field(default_factory=list)


class BrainOutput(BaseModel):
    facts: list[FactWrite] = Field(default_factory=list)
    member_states: list[MemberStateWrite] = Field(default_factory=list)
    news: list[NewsWrite] = Field(default_factory=list)
    quest_candidates: list[QuestCandidate] = Field(default_factory=list)
