"""Who you are in a town: the name and color you picked for it (town_members.name / .color).

You choose both when you create or join a town and can change them later, per town. Within a town
no two members share a name (ignoring case and spacing; also a unique index) or colors close enough
to confuse (their roof, car and name tag), which only the API can check.
"""

import colorsys
import math
import re

from fastapi import HTTPException

HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
# CIE76 distance in Lab space. Below this, two name tags / roofs are easy to mix up at town scale.
TOO_CLOSE = 22.0


def norm_name(name: str) -> str:
    return " ".join((name or "").split()).casefold()


def member_name(m: dict) -> str:
    """A member's name in their town, falling back to their profile name for rows from before per-town names."""
    return (m.get("name") or (m.get("profiles") or {}).get("display_name") or "").strip()


def _lab(hex_color: str) -> tuple[float, float, float]:
    r, g, b = (int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = lin(r), lin(g), lin(b)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116

    fx, fy, fz = f(x), f(y), f(z)
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)


def color_distance(a: str, b: str) -> float:
    return math.dist(_lab(a), _lab(b))


def _hex(h: float, s: float, v: float) -> str:
    return "#" + "".join(f"{round(c * 255):02x}" for c in colorsys.hsv_to_rgb(h % 1, s, v))


# Vivid colors to suggest: never greyish
CANDIDATES = [_hex(h / 360, s, v) for h in range(0, 360, 4) for s in (0.85, 0.6) for v in (0.95, 0.75)]


def suggest_color(taken: list[str]) -> str:
    """The candidate farthest from every color already taken."""
    taken = [t for t in taken if t and HEX.match(t)]
    if not taken:
        return CANDIDATES[0]
    return max(CANDIDATES, key=lambda c: min(color_distance(c, t) for t in taken))


def town_identities(db, town_id: str, exclude: str | None = None) -> list[dict]:
    """Everyone's name and color in a town: [{user_id, name, color}]."""
    rows = (
        db.table("town_members").select("user_id, name, color, profiles(display_name)")
        .eq("town_id", town_id).execute().data or []
    )
    return [{"user_id": r["user_id"], "name": member_name(r), "color": r.get("color")} for r in rows if r["user_id"] != exclude]


def check_identity(others: list[dict], name: str | None = None, color: str | None = None) -> None:
    """409 if `name` or `color` is already (nearly) someone else's in this town."""
    if name is not None:
        n = norm_name(name)
        if p := next((p for p in others if norm_name(p["name"]) == n), None):
            raise HTTPException(status_code=409, detail=f"someone in this town already goes by {p['name']}")
    if color is not None:
        if p := next((p for p in others if p["color"] and HEX.match(p["color"]) and color_distance(p["color"], color) < TOO_CLOSE), None):
            raise HTTPException(status_code=409, detail=f"that color is too close to {p['name']}'s")
