"""Instagram / Facebook usernames on profiles: clean up what people type and build the links.

People paste all sorts of things ("@maya", "instagram.com/maya/", "https://www.facebook.com/profile.php?id=123"),
so everything is reduced to the username (or numeric Facebook id) before it's stored.
"""

import re
from urllib.parse import parse_qs, urlparse

INSTAGRAM_RE = re.compile(r"^[a-z0-9._]{1,30}$")
FACEBOOK_RE = re.compile(r"^[A-Za-z0-9.]{1,50}$")


def _handle(raw: str, domain: str) -> str:
    """The bit after the domain, or the whole thing without an @."""
    text = raw.strip()
    if domain in text.lower():
        url = urlparse(text if "://" in text else f"https://{text}")
        if url.path.strip("/").lower() == "profile.php":  # facebook.com/profile.php?id=123
            return (parse_qs(url.query).get("id") or [""])[0]
        return url.path.strip("/").split("/")[0]
    return text.lstrip("@").strip("/")


def clean_instagram(raw: str) -> str | None:
    """'' clears it. Raises ValueError for something that can't be an Instagram username."""
    handle = _handle(raw, "instagram.com").lower()
    if not handle:
        return None
    if not INSTAGRAM_RE.match(handle):
        raise ValueError("Instagram usernames are up to 30 letters, numbers, periods and underscores")
    return handle


def clean_facebook(raw: str) -> str | None:
    handle = _handle(raw, "facebook.com")
    if not handle:
        return None
    if not FACEBOOK_RE.match(handle):
        raise ValueError("Facebook usernames are letters, numbers and periods (or paste your profile link)")
    return handle


def social_links(profile: dict) -> dict:
    """{instagram: url, facebook: url} for the ones this person filled in."""
    out = {}
    if ig := profile.get("instagram"):
        out["instagram"] = f"https://www.instagram.com/{ig}/"
    if fb := profile.get("facebook"):
        out["facebook"] = f"https://www.facebook.com/profile.php?id={fb}" if fb.isdigit() else f"https://www.facebook.com/{fb}"
    return out
