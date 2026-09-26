from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    SUPABASE_URL: str = ""
    SUPABASE_PUBLISHABLE_KEY: str = ""
    SUPABASE_SECRET_KEY: str = ""
    SUPABASE_DB_URL: str = ""
    ANTHROPIC_API_KEY: str = ""
    BRAIN_MODEL: str = "claude-sonnet-4-6"
    AGENT_MODEL: str = "claude-haiku-4-5-20251001"
    ACTION_AGENT_MODEL: str = "claude-sonnet-4-6"
    BRAIN_LOOP_INTERVAL_SECONDS: float = 10
    AGENT_LOOP_INTERVAL_SECONDS: float = 2
    DEMO_TOWN_ID: str = ""
    MIN_COMMITMENT_SECONDS: int = 30


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
