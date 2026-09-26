"""Who is calling. The frontend sends its Supabase session token as `Authorization: Bearer <access_token>`."""

from fastapi import Header, HTTPException

from backend.db import get_client


def current_user_id(authorization: str | None = Header(default=None)) -> str:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=401, detail="Authorization: Bearer <supabase access token> required")
    try:
        resp = get_client().auth.get_user(token)
    except Exception:
        resp = None
    if not resp or not resp.user:
        raise HTTPException(status_code=401, detail="invalid or expired token")
    return resp.user.id


def require_member(db, town_id: str, user_id: str) -> dict:
    """404 (not 403) so non-members can't probe which towns exist."""
    rows = db.table("town_members").select("*").eq("town_id", town_id).eq("user_id", user_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="town not found")
    return rows[0]
