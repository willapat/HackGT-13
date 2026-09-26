from typing import Optional

from pydantic import BaseModel, Field


class NearbyCharacter(BaseModel):
    user_id: str
    display_name: str
    location_building_id: Optional[str] = None
    busy: bool


class RelevantFact(BaseModel):
    id: str
    category: str
    fact: str


class ActiveEventSummary(BaseModel):
    id: str
    title: str
    status: str


class AgentDecisionInput(BaseModel):
    character_id: str
    town_id: str
    current_location_building_id: Optional[str] = None
    current_action: str
    nearby_characters: list[NearbyCharacter]
    relevant_facts: list[RelevantFact]
    active_events: list[ActiveEventSummary]
    known_connections: list[str]
    available_actions: list[str]
    available_buildings: list[dict]
    inventory: dict[str, int]


class AgentDecisionOutput(BaseModel):
    action: str
    target_user_id: Optional[str] = None
    target_building_id: Optional[str] = None
    reason: str
    fact_ids: list[str] = Field(default_factory=list)
