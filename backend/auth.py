"""Who is calling. The frontend sends its Supabase session token as `Authorization: Bearer <access_token>`."""

import base64
import hashlib
import json
import threading
import time

from fastapi import Header, HTTPException

from backend.db import get_client

# Checking a token is a network round trip to Supabase Auth, and a page load makes several API calls at once.
# Once Supabase has confirmed a token, remember who it belongs to for a short while (never past the token's own
# expiry). The cost: a session signed out elsewhere keeps working here for at most VERIFIED_FOR seconds.
VERIFIED_FOR = 120
_verified: dict[str, tuple[str, float]] = {}  # sha256(token) -> (user id, remember until)
_verified_lock = threading.Lock()


def _token_expiry(token: str) -> float:
    """The token's `exp` claim. Read without verifying: only called after Supabase accepted the token."""
    try:
        payload = token.split(".")[1]
        return float(json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))["exp"])
    except Exception:
        return 0.0


def current_user_id(authorization: str | None = Header(default=None)) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Authorization: Bearer <supabase access token> required")
    key, now = hashlib.sha256(token.encode()).hexdigest(), time.time()
    with _verified_lock:
        hit = _verified.get(key)
    if hit and hit[1] > now:
        return hit[0]
    try:
        resp = get_client().auth.get_user(token)
    except Exception:
        resp = None
    if not resp or not resp.user:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    until = min(now + VERIFIED_FOR, _token_expiry(token))
    with _verified_lock:
        if len(_verified) > 5000:  # drop what has lapsed so the cache can't grow without bound
            for k in [k for k, (_, t) in _verified.items() if t <= now]:
                del _verified[k]
        _verified[key] = (resp.user.id, until)
    return resp.user.id


def require_member(db, town_id: str, user_id: str) -> dict:
    """404 (not 403) so non-members can't probe which towns exist."""
    rows = db.table("town_members").select("*").eq("town_id", town_id).eq("user_id", user_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="town not found")
    return rows[0]
