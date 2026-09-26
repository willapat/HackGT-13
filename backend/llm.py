from functools import lru_cache

from backend.config import settings


@lru_cache
def _client():
    from google import genai

    return genai.Client(api_key=settings.GEMINI_API_KEY)


def complete(model: str, system: str, user: str, max_tokens: int) -> str:
    if not settings.GEMINI_API_KEY:
        raise RuntimeError("GEMINI_API_KEY is not set")
    from google.genai import types

    resp = _client().models.generate_content(
        model=model,
        contents=user,
        config=types.GenerateContentConfig(
            system_instruction=system,
            max_output_tokens=max_tokens,
            temperature=0.4,
        ),
    )
    return (resp.text or "").strip()
