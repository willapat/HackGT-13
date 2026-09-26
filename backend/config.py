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
    BRAIN_LOOP_INTERVAL_SECONDS: float = 10
    AGENT_LOOP_INTERVAL_SECONDS: float = 2
    DEMO_TOWN_ID: str = ""
    MIN_COMMITMENT_SECONDS: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
