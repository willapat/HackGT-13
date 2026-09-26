"""Identifies which process wrote an agents row.

Every update sets a new token. Postgres rejects an update that leaves written_by unchanged,
which is what an older process does when it does not know about the column.
"""

import os
import socket
import time
import uuid

_BOOT = uuid.uuid4().hex[:8]


def writer_id() -> str:
    return f"{socket.gethostname()}:{os.getpid()}:{_BOOT}"


def fresh_writer() -> str:
    return f"{writer_id()}:{time.time_ns()}"


def stamp(change: dict) -> dict:
    change["written_by"] = fresh_writer()
    return change
