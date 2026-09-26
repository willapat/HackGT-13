"""Profile photos in Supabase Storage. The page crops and shrinks the image before sending it; the backend
checks it's really a JPEG/PNG/WebP under the size cap, stores it under `avatars/<user_id>/`, and puts the
public URL in `profiles.avatar.photo`. Only the backend writes the bucket (secret key), so no storage policies."""

from uuid import uuid4

BUCKET = "avatars"
MAX_BYTES = 2 * 1024 * 1024
TYPES = {"jpg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
PHOTO_KEYS = ("photo", "photo_path")  # server-owned fields inside profiles.avatar


def sniff(data: bytes) -> str | None:
    """File extension from the first bytes, or None if it isn't an image we accept."""
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    return None


def ensure_bucket(db) -> None:
    """Create the public avatars bucket the first time anyone uploads (also in migration 20260926000011)."""
    try:
        db.storage.get_bucket(BUCKET)
    except Exception:
        db.storage.create_bucket(BUCKET, options={"public": True, "file_size_limit": MAX_BYTES,
                                                  "allowed_mime_types": list(TYPES.values())})


def store(db, uid: str, data: bytes, ext: str) -> tuple[str, str]:
    """Upload and return (public_url, path). A fresh name each time so browsers never show a cached old photo."""
    path = f"{uid}/{uuid4().hex}.{ext}"
    db.storage.from_(BUCKET).upload(path, data, {"content-type": TYPES[ext], "upsert": "false"})
    return db.storage.from_(BUCKET).get_public_url(path).rstrip("?"), path


def remove(db, path: str | None) -> None:
    if path:
        try:
            db.storage.from_(BUCKET).remove([path])
        except Exception:
            pass  # a leftover file is harmless; the profile no longer points at it
