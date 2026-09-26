"""Supabase client plus the few queries several modules share. No business logic."""

from datetime import datetime, timedelta, timezone
import threading

from supabase import Client, create_client

from backend.config import settings
from backend.writer import stamp

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def iso_in(seconds: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat()


def parse_ts(ts: str) -> datetime:
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


_local = threading.local()


def get_client() -> Client:
    """One Supabase client per thread. FastAPI runs sync routes on a thread pool, and a single shared
    client breaks when two requests use its connection at once (httpx ReadError: Errno 35)."""
    client = getattr(_local, "client", None)
    if client is None:
        if not settings.SUPABASE_URL or not settings.SUPABASE_SECRET_KEY:
            raise RuntimeError("SUPABASE_URL and SUPABASE_SECRET_KEY must be set")
        client = _local.client = create_client(settings.SUPABASE_URL, settings.SUPABASE_SECRET_KEY)
    return client


def last_brain_run_at(db, town_id: str) -> str | None:
    rows = (
        db.table("brain_runs").select("created_at").eq("town_id", town_id)
        .order("created_at", desc=True).limit(1).execute().data
    )
    return rows[0]["created_at"] if rows else None


def towns_with_unprocessed_signals(db) -> list[str]:
    """Cost control: only towns with a member signal newer than the town's last brain run get a Brain call."""
    # ponytail: one signals query per town; move to a SQL function if towns grow past a few dozen.
    by_town: dict[str, list[str]] = {}
    for m in db.table("town_members").select("town_id, user_id").execute().data or []:
        by_town.setdefault(m["town_id"], []).append(m["user_id"])
    due = []
    for town_id, user_ids in by_town.items():
        q = db.table("signals").select("id").in_("user_id", user_ids).limit(1)
        since = last_brain_run_at(db, town_id)
        if since:
            q = q.gt("created_at", since)
        if q.execute().data:
            due.append(town_id)
    return due


def claim_due_agents(db, limit: int = 10, lease_seconds: int = 30) -> list[dict]:
    """Claim agents whose next_decision_at has passed. The conditional update makes a row claimable once."""
    due = (
        db.table("agents").select("*").lte("next_decision_at", now_iso())
        .order("next_decision_at").limit(limit).execute().data or []
    )
    claimed = []
    for row in due:
        won = (
            db.table("agents")
            .update(stamp({"next_decision_at": iso_in(lease_seconds)}))
            .eq("town_id", row["town_id"])
            .eq("user_id", row["user_id"])
            .eq("next_decision_at", row["next_decision_at"])
            .execute()
        )
        if won.data or getattr(won, "count", None):
            claimed.append(row)
        else:
            # Some PostgREST setups return no representation; re-read the lease we tried to set.
            check = (
                db.table("agents")
                .select("next_decision_at")
                .eq("town_id", row["town_id"])
                .eq("user_id", row["user_id"])
                .limit(1)
                .execute()
                .data
                or []
            )
            if check and check[0]["next_decision_at"] != row["next_decision_at"]:
                claimed.append(row)
    return claimed


def recent_facts(db, town_id: str, runs: int = 10) -> list[dict]:
    """Facts from the town's latest successful brain runs, newest first. Id is '<run_id>:<index>'."""
    rows = (
        db.table("brain_runs").select("id, output").eq("town_id", town_id).not_.is_("output", "null")
        .order("created_at", desc=True).limit(runs).execute().data or []
    )
    return [
        {"id": f"{run['id']}:{i}", **fact}
        for run in rows
        for i, fact in enumerate((run["output"] or {}).get("facts") or [])
    ]
