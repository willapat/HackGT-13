from pydantic import BaseModel, Field


class NearbyCharacter(BaseModel):
    user_id: str
    display_name: str
    location_building_id: str | None = None
    mood: str | None = None
    activity: str | None = None


class RelevantFact(BaseModel):
    id: str
    user_id: str
    category: str
    fact: str


class ActiveEventSummary(BaseModel):
    id: str
    title: str
    status: str


class AgentDecisionInput(BaseModel):
    character_id: str
    display_name: str
    town_id: str
    current_location_building_id: str | None = None
    current_action: str
    nearby_characters: list[NearbyCharacter]
    relevant_facts: list[RelevantFact]
    active_events: list[ActiveEventSummary]
    available_actions: list[str]
    available_buildings: list[dict]


class AgentDecisionOutput(BaseModel):
    action: str
    target_user_id: str | None = None
    target_building_id: str | None = None
    reason: str
    fact_ids: list[str] = Field(default_factory=list)
