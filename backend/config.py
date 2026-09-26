from functools import lru_cache
from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Repo-root .env, wherever the server is started from. Blank lines like `BRAIN_MODEL=` keep the default.
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parent.parent / ".env",
        env_file_encoding="utf-8",
        env_ignore_empty=True,
        extra="ignore",
    )

    SUPABASE_URL: str = ""
    SUPABASE_PUBLISHABLE_KEY: str = ""
    SUPABASE_SECRET_KEY: str = ""
    SUPABASE_DB_URL: str = ""
    # OpenRouter key (sk-or-v1-...), used as Bearer token. GEMINI_MODEL_KEY is the old name for it.
    OPENROUTER_API_KEY: str = Field(default="", validation_alias=AliasChoices("OPENROUTER_API_KEY", "GEMINI_MODEL_KEY"))
    BRAIN_MODEL: str = "google/gemini-2.5-flash"
    AGENT_MODEL: str = "google/gemini-2.5-flash-lite"
    ACTION_AGENT_MODEL: str = "google/gemini-2.5-flash"
    # xAI (Grok) key (xai-...). When set, every AI feature uses xAI instead of OpenRouter (see backend/llm.py).
    XAI_API_KEY: str = ""
    XAI_MODEL: str = "grok-4.6"  # town brain, town generation
    XAI_FAST_MODEL: str = "grok-4.20-0309-non-reasoning"  # post ideas, character agents and chats (AGENT_MODEL calls); ~2s
    # How long Grok thinks before answering: "low" keeps replies fast (a few seconds), "high" is slower. Blank = model default.
    XAI_REASONING_EFFORT: str = "low"
    # Optional: "xai" or "openrouter" to force one. Empty = xAI if its key is set, else OpenRouter.
    LLM_PROVIDER: str = ""
    BRAIN_LOOP_INTERVAL_SECONDS: float = 10
    AGENT_LOOP_INTERVAL_SECONDS: float = 2
    DEMO_TOWN_ID: str = ""
    MIN_COMMITMENT_SECONDS: int = 30
    # Optional ISO time the town treats as "now" at process start (then advances). Empty = real clock.
    TOWN_CLOCK: str = ""
    # Google Calendar sync: the same OAuth client as Supabase's Google provider (needed to refresh tokens).
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    CALENDAR_SYNC_INTERVAL_SECONDS: float = 300
    CALENDAR_SYNC_DAYS: int = 7
    # Model picks the building for events whose words don't name a place (false = word match only).
    CALENDAR_AI: bool = True
    CALENDAR_AI_MAX_CALLS: int = 40  # per person per sync


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
