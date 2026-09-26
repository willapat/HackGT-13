"""LLM calls go through OpenRouter's OpenAI-compatible API.

`OPENROUTER_API_KEY` is an OpenRouter key (`sk-or-v1-...`), not a Google AI Studio key.
Model ids are OpenRouter slugs (e.g. `google/gemini-2.5-flash`). Bare `gemini-*` names
are prefixed with `google/` so older .env values still work.
"""

import httpx

from backend.config import settings

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


def _openrouter_model(model: str) -> str:
    if "/" in model:
        return model
    if model.startswith("gemini"):
        return f"google/{model}"
    if model.startswith("claude"):
        return f"anthropic/{model}"
    return model


def complete(model: str, system: str, user: str, max_tokens: int) -> str:
    if not settings.OPENROUTER_API_KEY:
        raise RuntimeError("OPENROUTER_API_KEY is not set")
    payload = {
        "model": _openrouter_model(model),
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": 0.4,
    }
    headers = {
        "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://tinytown.local",
        "X-Title": "Tiny Town",
    }
    with httpx.Client(timeout=90.0) as client:
        resp = client.post(OPENROUTER_URL, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"unexpected OpenRouter response: {data!r}") from exc
