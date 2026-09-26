"""Every LLM call in the app goes through `complete()`, so switching providers here switches all AI features.

Providers (both OpenAI-compatible chat completions):
- xAI (Grok): used whenever `XAI_API_KEY` is set. Callers still pass their usual model setting
  (`BRAIN_MODEL`, `AGENT_MODEL`, ...); it's mapped to `XAI_MODEL`, or `XAI_FAST_MODEL` for the lighter
  `AGENT_MODEL` calls. A model id that's already a Grok id (`grok-...`) is used as is.
- OpenRouter: used when there's no xAI key (or `LLM_PROVIDER=openrouter`). `OPENROUTER_API_KEY` is an
  OpenRouter key (`sk-or-v1-...`); model ids are OpenRouter slugs (`google/gemini-2.5-flash`), and bare
  `gemini-*` names are prefixed with `google/` so older .env values still work.

New AI features: call `complete(settings.BRAIN_MODEL or AGENT_MODEL, ...)` and check `available()` first.
"""

import httpx

from backend.config import settings

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
XAI_URL = "https://api.x.ai/v1/chat/completions"


def provider() -> str | None:
    """"xai", "openrouter", or None when no key is set."""
    forced = settings.LLM_PROVIDER.strip().lower()
    if forced == "openrouter":
        return "openrouter" if settings.OPENROUTER_API_KEY else None
    if forced == "xai" or settings.XAI_API_KEY:
        return "xai" if settings.XAI_API_KEY else None
    return "openrouter" if settings.OPENROUTER_API_KEY else None


def available() -> bool:
    return provider() is not None


def _openrouter_model(model: str) -> str:
    if "/" in model:
        return model
    if model.startswith("gemini"):
        return f"google/{model}"
    if model.startswith("claude"):
        return f"anthropic/{model}"
    return model


def _xai_model(model: str) -> str:
    if model.startswith("grok"):
        return model
    if model == settings.AGENT_MODEL and model != settings.BRAIN_MODEL:
        return settings.XAI_FAST_MODEL
    return settings.XAI_MODEL


def describe(model: str) -> str:
    """"xai grok-4.6" etc.: which provider and model a call with this model setting would really use."""
    which = provider()
    if which == "xai":
        return f"xai {_xai_model(model)}"
    return f"openrouter {_openrouter_model(model)}" if which else "no LLM key"


def complete(model: str, system: str, user: str, max_tokens: int, temperature: float = 0.4) -> str:
    which = provider()
    if which is None:
        raise RuntimeError("no LLM key set: add XAI_API_KEY (or OPENROUTER_API_KEY) to .env")
    if which == "xai":
        url, key, model_id, extra = XAI_URL, settings.XAI_API_KEY, _xai_model(model), {}
    else:
        url, key, model_id = OPENROUTER_URL, settings.OPENROUTER_API_KEY, _openrouter_model(model)
        extra = {"HTTP-Referer": "https://luma.local", "X-Title": "Luma"}
    payload = {
        "model": model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "temperature": temperature,
    }
    if which == "xai" and settings.XAI_REASONING_EFFORT:
        payload["reasoning_effort"] = settings.XAI_REASONING_EFFORT
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json", **extra}
    with httpx.Client(timeout=90.0) as client:
        resp = client.post(url, json=payload, headers=headers)
        if resp.status_code == 400 and "reasoning" in resp.text and payload.pop("reasoning_effort", None):
            resp = client.post(url, json=payload, headers=headers)  # a non-reasoning model; ask again without it
        if resp.status_code >= 400:  # include the provider's reason ("Incorrect API key", "model not found", ...)
            raise RuntimeError(f"{which} {model_id} -> {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
    try:
        return (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError) as exc:
        raise RuntimeError(f"unexpected {which} response: {data!r}") from exc
