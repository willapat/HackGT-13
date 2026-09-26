def log_loop_error(name: str, exc: Exception) -> None:
    print(f"[{name}] {exc!r}", flush=True)
