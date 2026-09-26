from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.db import get_client

router = APIRouter()

SCENARIOS = {"goodNews", "climbing", "roughWeek"}


def _members_by_name(db, town_id: str) -> dict[str, str]:
    rows = (
        db.table("town_members")
        .select("user_id, profiles(display_name)")
        .eq("town_id", town_id)
        .execute()
        .data
        or []
    )
    out = {}
    for row in rows:
        name = ((row.get("profiles") or {}).get("display_name") or "").strip().lower()
        if name:
            out[name] = row["user_id"]
    return out


def ensure_consent(db, user_id: str, source: str = "manual") -> None:
    existing = (
        db.table("consents").select("user_id").eq("user_id", user_id).eq("source", source).limit(1).execute().data or []
    )
    if not existing:
        db.table("consents").insert({"user_id": user_id, "source": source}).execute()


def scenario_signals(scenario: str, names: dict[str, str]) -> list[dict]:
    def uid(n: str) -> str:
        key = n.lower()
        if key not in names:
            raise HTTPException(status_code=400, detail=f"demo town missing member named {n}")
        return names[key]

    if scenario == "goodNews":
        return [
            {
                "user_id": uid("maya"),
                "source": "manual",
                "type": "news",
                "value": {"text": "got the internship"},
            }
        ]
    if scenario == "climbing":
        return [
            {
                "user_id": uid("sam"),
                "source": "manual",
                "type": "interest_mention",
                "value": {"interest": "climbing"},
            },
            {
                "user_id": uid("priya"),
                "source": "manual",
                "type": "interest_mention",
                "value": {"interest": "climbing"},
            },
        ]
    if scenario == "roughWeek":
        return [
            {
                "user_id": uid("jordan"),
                "source": "manual",
                "type": "mood",
                "value": {"mood": "rough_week"},
            }
        ]
    raise HTTPException(status_code=404, detail="unknown scenario")


@router.get("/demo/config")
def demo_config():
    return {
        "supabase_url": settings.SUPABASE_URL,
        "supabase_publishable_key": settings.SUPABASE_PUBLISHABLE_KEY,
        "demo_town_id": settings.DEMO_TOWN_ID,
        "backend_ok": True,
    }


@router.post("/demo/trigger/{scenario}")
def trigger_demo(scenario: str):
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=404, detail="unknown scenario")
    if not settings.DEMO_TOWN_ID:
        raise HTTPException(status_code=500, detail="DEMO_TOWN_ID is not set")
    db = get_client()
    names = _members_by_name(db, settings.DEMO_TOWN_ID)
    payloads = scenario_signals(scenario, names)
    inserted = []
    for p in payloads:
        ensure_consent(db, p["user_id"], p["source"])
        if scenario == "climbing":
            row = db.table("profiles").select("interests").eq("id", p["user_id"]).limit(1).execute().data or []
            interests = list((row[0].get("interests") if row else None) or [])
            if "climbing" not in interests:
                interests.append("climbing")
                db.table("profiles").update({"interests": interests}).eq("id", p["user_id"]).execute()
        rec = db.table("signals").insert(p).execute().data or []
        if rec:
            inserted.append(rec[0]["id"])
    return {"ok": True, "scenario": scenario, "signal_ids": inserted, "town_id": settings.DEMO_TOWN_ID}
