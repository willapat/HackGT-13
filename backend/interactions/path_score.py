"""Friendship path_score.

Formula (clamped to [0, 1]):
  path_score = clamp(
      path_score
      + 0.05 if via == in_town
      + 0.15 if via == real_life
      - 0.01 * days_since(last_interaction_at),
      0, 1
  )
Decay is applied once per interaction against time since the previous last_interaction_at.
"""

from datetime import datetime, timezone

from backend.db import now_iso
from backend.models.enums import InteractionVia

IN_TOWN_DELTA = 0.05
REAL_LIFE_DELTA = 0.15
DAILY_DECAY = 0.01


def clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


def ordered_pair(a: str, b: str) -> tuple[str, str]:
    return (a, b) if a < b else (b, a)


def days_since(ts: str | None) -> float:
    if not ts:
        return 0.0
    then = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    return max(0.0, (datetime.now(timezone.utc) - then).total_seconds() / 86400)


def next_path_score(current: float, via: str, last_interaction_at: str | None) -> tuple[float, float]:
    bump = REAL_LIFE_DELTA if via == InteractionVia.real_life.value else IN_TOWN_DELTA
    decay = DAILY_DECAY * days_since(last_interaction_at)
    delta = bump - decay
    return clamp(current + delta), delta


def apply_path_score_delta(db, user_a: str, user_b: str, via: str, reason: str) -> float:
    a, b = ordered_pair(user_a, user_b)
    rows = db.table("friendships").select("*").eq("user_a", a).eq("user_b", b).limit(1).execute().data or []
    current = 0.5
    last = None
    if rows:
        current = float(rows[0].get("path_score") or 0.5)
        last = rows[0].get("last_interaction_at")
        new_score, delta = next_path_score(current, via, last)
        db.table("friendships").update(
            {"path_score": new_score, "last_interaction_at": now_iso()}
        ).eq("user_a", a).eq("user_b", b).execute()
    else:
        new_score, delta = next_path_score(current, via, last)
        db.table("friendships").insert(
            {"user_a": a, "user_b": b, "path_score": new_score, "last_interaction_at": now_iso()}
        ).execute()
    db.table("path_score_history").insert(
        {"user_a": a, "user_b": b, "delta": delta, "reason": reason}
    ).execute()
    return new_score


def record_interaction(db, town_id: str, user_a: str, user_b: str, itype: str, via: str) -> None:
    db.table("interactions").insert(
        {
            "town_id": town_id,
            "user_a": user_a,
            "user_b": user_b,
            "type": itype,
            "via": via,
        }
    ).execute()
    apply_path_score_delta(db, user_a, user_b, via, f"{via}:{itype}")
