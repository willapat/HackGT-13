from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

from backend.db import get_client
from backend.models.enums import InterestSource

router = APIRouter()


class InterestIn(BaseModel):
    interest_slug: str


@router.post("/users/me/interests")
def add_interest(body: InterestIn, x_user_id: str | None = Header(default=None)):
    if not x_user_id:
        raise HTTPException(status_code=401, detail="X-User-Id required")
    db = get_client()
    rows = db.table("profiles").select("interests").eq("id", x_user_id).limit(1).execute().data or []
    if not rows:
        raise HTTPException(status_code=404, detail="profile not found")
    interests = list(rows[0].get("interests") or [])
    slug = body.interest_slug.strip().lower()
    if slug not in interests:
        interests.append(slug)
        db.table("profiles").update({"interests": interests}).eq("id", x_user_id).execute()
    return {"user_id": x_user_id, "interest_slug": slug, "source": InterestSource.stated.value, "interests": interests}
