"""One agent loop at a time. The lease lives in Postgres and expires if the holder stops renewing.

A session advisory lock does not survive here: each Supabase request borrows a pooled
connection and returns it, which releases the lock before the next loop tick.
"""

from backend.writer import writer_id

LEASE_NAME = "agent"
LEASE_TTL_SECONDS = 45


def claim_agent_lease() -> bool:
    from backend.db import get_client

    result = get_client().rpc(
        "claim_loop_lease",
        {"lease_name": LEASE_NAME, "holder": writer_id(), "ttl_seconds": LEASE_TTL_SECONDS},
    ).execute()
    data = result.data
    if isinstance(data, list):
        data = data[0] if data else False
    return bool(data)
