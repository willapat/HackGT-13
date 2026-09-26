from fastapi import APIRouter, HTTPException

from backend.config import settings
from backend.db import get_client

router = APIRouter(prefix="/demo", tags=["demo"])

SCENARIOS = {"goodNews", "climbing", "roughWeek"}
# Roles match the character ids in frontend/main.js FRIENDS.
ROLES = ["maya", "jordan", "sam", "priya", "leo"]


def _as_cast_members(rows: list[dict]) -> list[dict]:
    return [
        {"user_id": r["user_id"], "display_name": ((r.get("profiles") or {}).get("display_name") or "").strip()}
        for r in rows
    ]


def _town_members(db, town_id: str) -> list[dict]:
    rows = (
        db.table("town_members")
        .select("user_id, joined_at, profiles(display_name)")
        .eq("town_id", town_id)
        .order("joined_at")
        .execute()
        .data
        or []
    )
    return _as_cast_members(rows)


def cast_roles(members: list[dict]) -> dict[str, str]:
    """Role -> user_id. A member whose name matches a role gets it; the rest fill open roles in join order.
    With fewer members than roles, members are reused so every scenario still has someone."""
    if not members:
        raise HTTPException(status_code=400, detail="demo town has no members")
    cast: dict[str, str] = {}
    unassigned = []
    for m in members:
        role = m["display_name"].lower()
        if role in ROLES and role not in cast:
            cast[role] = m["user_id"]
        else:
            unassigned.append(m["user_id"])
    open_roles = [r for r in ROLES if r not in cast]
    for role, uid in zip(open_roles, unassigned):
        cast[role] = uid
    everyone = [m["user_id"] for m in members]
    for i, role in enumerate(r for r in ROLES if r not in cast):
        cast[role] = everyone[i % len(everyone)]
    return cast


def primary_roles(cast: dict[str, str]) -> dict[str, str]:
    """user_id -> the first role they were cast in (the character that represents them on screen)."""
    out: dict[str, str] = {}
    for role in ROLES:
        out.setdefault(cast[role], role)
    return out


def scenario_signals(scenario: str, cast: dict[str, str]) -> list[dict]:
    def uid(role: str) -> str:
        return cast[role]

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
        climbers = list(dict.fromkeys([uid("sam"), uid("priya")]))
        return [
            {
                "user_id": u,
                "source": "manual",
                "type": "interest_mention",
                "value": {"interest": "climbing"},
            }
            for u in climbers
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


@router.get("/config")
def demo_config():
    return {
        "supabase_url": settings.SUPABASE_URL,
        "supabase_publishable_key": settings.SUPABASE_PUBLISHABLE_KEY,
        "demo_town_id": settings.DEMO_TOWN_ID,
        "backend_ok": True,
    }


@router.get("/trigger/{scenario}")
@router.post("/trigger/{scenario}")
def trigger_demo(scenario: str):
    """Inserts real signals for the demo town's members. Unauthenticated on purpose: only works with DEMO_TOWN_ID set."""
    if scenario not in SCENARIOS:
        raise HTTPException(status_code=404, detail="unknown scenario")
    if not settings.DEMO_TOWN_ID:
        raise HTTPException(status_code=500, detail="DEMO_TOWN_ID is not set")
    db = get_client()
    cast = cast_roles(_town_members(db, settings.DEMO_TOWN_ID))
    payloads = scenario_signals(scenario, cast)
    inserted = []
    for p in payloads:
        if scenario == "climbing":
            row = db.table("profiles").select("interests").eq("id", p["user_id"]).limit(1).execute().data or []
            interests = list((row[0].get("interests") if row else None) or [])
            if "climbing" not in interests:
                interests.append("climbing")
                db.table("profiles").update({"interests": interests}).eq("id", p["user_id"]).execute()
        rec = db.table("signals").insert(p).execute().data or []
        if rec:
            inserted.append(rec[0]["id"])
    return {
        "ok": True,
        "scenario": scenario,
        "signal_ids": inserted,
        "town_id": settings.DEMO_TOWN_ID,
        "characters": primary_roles(cast),
    }


@router.get("/snapshot")
def demo_snapshot():
    """Unauthenticated town view for the hackathon demo UI. Secret-key read; DEMO_TOWN_ID only."""
    if not settings.DEMO_TOWN_ID:
        raise HTTPException(status_code=500, detail="DEMO_TOWN_ID is not set")
    db, tid = get_client(), settings.DEMO_TOWN_ID
    members = (
        db.table("town_members")
        .select("user_id, mood, activity, state, joined_at, profiles(display_name)")
        .eq("town_id", tid)
        .order("joined_at")
        .execute()
        .data
        or []
    )
    agents = db.table("agents").select("user_id, action, target, updated_at").eq("town_id", tid).execute().data or []
    actions = (
        db.table("agent_actions")
        .select("id, user_id, action, details, created_at")
        .eq("town_id", tid)
        .order("created_at", desc=True)
        .limit(30)
        .execute()
        .data
        or []
    )
    events = (
        db.table("events")
        .select("id, type, title, text, status, created_at")
        .eq("town_id", tid)
        .order("created_at", desc=True)
        .limit(20)
        .execute()
        .data
        or []
    )
    return {
        "town_id": tid,
        "members": members,
        "characters": primary_roles(cast_roles(_as_cast_members(members))) if members else {},
        "agents": agents,
        "agent_actions": actions,
        "events": events,
    }
