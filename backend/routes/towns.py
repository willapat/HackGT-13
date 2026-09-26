from datetime import datetime, timedelta
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query

from backend.auth import current_user_id, require_member
from backend.config import settings
from backend.db import get_client, iso_in, now_iso, writer
from backend.identity import check_identity, suggest_color, town_identities
from backend.models.api import EventCreate, HouseName, HouseUpdate, IdentityUpdate, JoinTown, MoveIn, TownCreate, TownGenerate, TownUpdate
from backend.models.enums import AgentAction, EventStatus, EventType, ParticipantStatus
from backend.routes.me import plan_town_handoff
from backend.calendar_drive import destination_for, estimate_travel_minutes, snap_member_to_clock
from backend.schedules import TOWN_TZ, clock_mode, events_for_users, local_now
from backend.writer import stamp
from backend.town_map import buildings, house_building_id, in_bounds
from backend.towngen import generate_town, grow, needs_to_grow
from backend.towngen.catalog import GREENERY, LANDMARKS, LANDSCAPES, MAX_PLACES, PLACE_TYPES, STYLES
from backend.routes.friends import are_friends

router = APIRouter(prefix="/towns", tags=["towns"])


def check_places(tiles: list, places: dict) -> None:
    for pid, p in places.items():
        if not all(in_bounds(tiles, *xy) for xy in (p.tile, p.door)):
            raise HTTPException(status_code=422, detail=f"place '{pid}' is outside the town map")

# After a person picks a destination, their AI character leaves them alone this long.
USER_MOVE_HOLD_SECONDS = 600


def load_town(db, town_id: str) -> dict:
    rows = db.table("towns").select("*").eq("id", town_id).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="town not found")
    return rows[0]


@router.post("", status_code=201)
def create_town(body: TownCreate, uid: str = Depends(current_user_id)):
    """You become its first member (and get a character) via DB triggers, going by `me.name` in `me.color`."""
    check_places(body.tiles, body.map.places)
    db = get_client()
    town = db.table("towns").insert(
        {"name": body.name.strip(), "tiles": body.tiles, "map": body.map.model_dump(), "created_by": uid}
    ).execute().data[0]
    db.table("town_members").update(body.me.model_dump()).eq("town_id", town["id"]).eq("user_id", uid).execute()
    claim_home_slot(db, town, uid)
    return town


@router.post("/generate", status_code=201)
def generate(body: TownGenerate, uid: str = Depends(current_user_id)):
    """Create a town from a description. Gemini designs it (name, buildings, places); backend/towngen lays it out so
    the town rules always hold. It starts sized for 1 member and grows as friends join (see admit). You get the
    first home plot, and every friend in `invite_user_ids` gets an invite. `preview: true` returns the design unsaved;
    `revise` redraws a preview with the user's notes; `design` (a preview's `plan`) builds that exact town."""
    db = get_client()
    invitees = list(dict.fromkeys(str(i) for i in body.invite_user_ids if str(i) != uid))
    strangers = [i for i in invitees if not are_friends(db, uid, i)]
    if strangers:  # checked before the (slow) generation so nothing is half-made
        raise HTTPException(status_code=422, detail="you can only invite your friends")
    if not body.preview and body.me is None:
        raise HTTPException(status_code=422, detail="pick your name and color in the town first")
    made = generate_town(body.prompt, members=1, name=body.name, places=body.places, custom=body.custom_places,
                         landmarks=body.landmarks, revision=body.revise.model_dump() if body.revise else None,
                         design=body.design, look={"landscape": body.landscape, "style": body.style, "greenery": body.greenery})
    if body.preview:
        return made
    town = db.table("towns").insert(
        {"name": made["name"], "tiles": made["tiles"], "map": made["map"], "created_by": uid}
    ).execute().data[0]
    db.table("town_members").update(body.me.model_dump()).eq("town_id", town["id"]).eq("user_id", uid).execute()
    claim_home_slot(db, town, uid)
    if invitees:
        db.table("town_invites").insert([{"town_id": town["id"], "from_user": uid, "to_user": i} for i in invitees]).execute()
    return {**load_town(db, town["id"]), "plan": made["plan"], "plan_source": made["plan_source"], "invited": len(invitees)}


@router.get("/place-options")
def place_options(uid: str = Depends(current_user_id)):
    """What the create-town form can offer: named place types, landmarks, and how many places a town can have.
    Anything not listed can be requested by name as a custom place."""
    return {
        "places": [{"id": pid, "label": label} for pid, (label, _) in PLACE_TYPES.items()],
        "landmarks": [{"id": lid, "label": label} for lid, label in LANDMARKS.items()],
        "landscapes": [{"id": k, "label": v} for k, v in LANDSCAPES.items()],
        "styles": [{"id": k, "label": v} for k, v in STYLES.items()],
        "greenery": [{"id": k, "label": v} for k, v in GREENERY.items()],
        "max_places": MAX_PLACES,
    }


def slot_cells(slot: dict) -> list[tuple[int, int]]:
    b = slot["block"]
    return [(x, y) for x in range(b[0], b[2] + 1) for y in range(b[1], b[3] + 1)]


def claim_home_slot(db, town: dict, uid: str, house_name: str | None = None) -> None:
    """Give uid the first free 2x2 home plot in towns.map.home_slots (generated towns). No-op for towns without
    plots, or when every plot is taken (they still get a character, just no house)."""
    slots = (town.get("map") or {}).get("home_slots") or []
    members = db.table("town_members").select("user_id, house_x, house_y").eq("town_id", town["id"]).execute().data or []
    if not slots or any(m["user_id"] == uid and m["house_x"] is not None for m in members):
        return
    taken = {(m["house_x"], m["house_y"]) for m in members}
    # ponytail: two people joining at the same instant could pick the same plot; a DB lock or unique index if that bites
    slot = next((s for s in slots if tuple(s["house"]) not in taken), None)
    if slot is None:
        return
    tiles = load_town(db, town["id"])["tiles"]
    for x, y in slot_cells(slot):
        tiles[y][x] = "yard"
    tiles[slot["driveway"][1]][slot["driveway"][0]] = "driveway"
    tiles[slot["house"][1]][slot["house"][0]] = "home"
    home = {k: slot[k] for k in ("model", "driveway", "door", "block")}
    if house_name:
        home["name"] = house_name
    db.table("towns").update({"tiles": tiles}).eq("id", town["id"]).execute()
    db.table("town_members").update({"house_x": slot["house"][0], "house_y": slot["house"][1], "home": home,
                                     "updated_at": now_iso()}).eq("town_id", town["id"]).eq("user_id", uid).execute()
    park_at_home(db, town["id"], uid, slot["house"], slot["door"], "home")


def park_at_home(db, town_id: str, uid: str, house: list, door: list, source: str) -> None:
    """Stand uid's character idle on their own front door. Follows the DB's placement rules (agents_follow_calendar):
    an idle row names its building and stands on that building's door, so town_members.home must be written first.
    The town with a town_clock row (DEMO_TOWN_ID) only accepts where the calendar says they are at that clock."""
    if town_id == settings.DEMO_TOWN_ID:
        snap_member_to_clock(db, town_id, uid, local_now())
        return
    db.table("agents").update({
        "action": AgentAction.idle.value, "x": door[0], "y": door[1],
        "target": {"building_id": house_building_id(uid), "x": house[0], "y": house[1], "door": door},
        "updated_at": now_iso(), "written_by": writer(source),
    }).eq("town_id", town_id).eq("user_id", uid).execute()


def free_home_slot(db, town: dict, house: tuple) -> None:
    """When someone leaves, their plot goes back to garden so the next member can have it."""
    slot = next((s for s in (town.get("map") or {}).get("home_slots") or [] if tuple(s["house"]) == house), None)
    if slot is None:
        return
    tiles = town["tiles"]
    for x, y in slot_cells(slot):
        tiles[y][x] = "garden"
    db.table("towns").update({"tiles": tiles}).eq("id", town["id"]).execute()


def admit(db, town_id: str, uid: str, me) -> None:
    """Add uid to a town under the name and color they picked, unless someone there already has them."""
    if db.table("town_members").select("user_id").eq("town_id", town_id).eq("user_id", uid).execute().data:
        raise HTTPException(status_code=409, detail="you're already in this town")
    check_identity(town_identities(db, town_id), me.name, me.color)
    db.table("town_members").insert({"town_id": town_id, "user_id": uid, **me.model_dump()}).execute()
    town = load_town(db, town_id)
    members = db.table("town_members").select("user_id").eq("town_id", town_id).execute().data or []
    if needs_to_grow(town, len(members)):
        regrow_town(db, town)  # also gives everyone, the joiner included, a plot
    else:
        claim_home_slot(db, town, uid)


def regrow_town(db, town: dict) -> None:
    """The town outgrew its size tier: rebuild it bigger from its saved plan, then re-house everyone in join
    order. Place ids stay the same, so plans and events that point at them keep working."""
    tid = town["id"]
    members = db.table("town_members").select("user_id, home").eq("town_id", tid).order("joined_at").execute().data or []
    tiles, town_map = grow(town, len(members))
    db.table("towns").update({"tiles": tiles, "map": town_map}).eq("id", tid).execute()
    db.table("town_members").update({"house_x": None, "house_y": None, "home": {}, "updated_at": now_iso()}).eq("town_id", tid).execute()
    # Characters are re-placed one by one below (each claim parks them on their new door); a bulk "reset" row with
    # no building would break the placement rules.
    grown = load_town(db, tid)
    for m in members:
        claim_home_slot(db, grown, m["user_id"], (m["home"] or {}).get("name"))  # house, home (keeping its name), door


def town_by_code(db, code: str) -> dict:
    rows = db.table("towns").select("*").eq("invite_code", code.strip()).limit(1).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="invalid invite code")
    return rows[0]


def identities_view(db, town: dict, uid: str) -> dict:
    """What you need to pick (or change) your name and color in a town: what's taken and a free color."""
    others = town_identities(db, town["id"], exclude=uid)
    mine = db.table("town_members").select("name, color").eq("town_id", town["id"]).eq("user_id", uid).execute().data
    return {
        "town": {"id": town["id"], "name": town["name"]},
        "taken": [{"name": p["name"], "color": p["color"]} for p in others],
        "mine": mine[0] if mine else None,
        "suggested_color": suggest_color([p["color"] for p in others]),
    }


@router.get("/lookup")
def lookup_town(invite_code: str = Query(min_length=1, max_length=20), uid: str = Depends(current_user_id)):
    """Before joining with a code: the town's name and the names/colors already taken there."""
    db = get_client()
    return identities_view(db, town_by_code(db, invite_code), uid)


@router.post("/join")
def join_town(body: JoinTown, uid: str = Depends(current_user_id)):
    db = get_client()
    town = town_by_code(db, body.invite_code)
    admit(db, town["id"], uid, body.me)
    return town


@router.get("/{town_id}/identities")
def town_identity_options(town_id: UUID, uid: str = Depends(current_user_id)):
    """Names and colors taken in a town, for members and for anyone with a pending invite to it."""
    db, tid = get_client(), str(town_id)
    invited = db.table("town_invites").select("id").eq("town_id", tid).eq("to_user", uid).eq("status", "pending").execute().data
    if not invited:
        require_member(db, tid, uid)
    return identities_view(db, load_town(db, tid), uid)


@router.patch("/{town_id}/members/me/home")
def name_my_house(town_id: UUID, body: HouseName, uid: str = Depends(current_user_id)):
    """Name your house in this town (shown on its label). null or "" goes back to "<your name>'s house"."""
    db, tid = get_client(), str(town_id)
    mine = require_member(db, tid, uid)
    if mine.get("house_x") is None:
        raise HTTPException(status_code=409, detail="you don't have a house in this town yet")
    home = dict(mine.get("home") or {})
    name = (body.name or "").strip()
    if name:
        home["name"] = name
    else:
        home.pop("name", None)
    return (
        db.table("town_members").update({"home": home, "updated_at": now_iso()})
        .eq("town_id", tid).eq("user_id", uid).execute().data[0]
    )


@router.patch("/{town_id}/members/me/identity")
def update_my_identity(town_id: UUID, body: IdentityUpdate, uid: str = Depends(current_user_id)):
    """Change the name and/or color you go by in this town."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    changes = body.model_dump(exclude_none=True)
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    check_identity(town_identities(db, tid, exclude=uid), changes.get("name"), changes.get("color"))
    return (
        db.table("town_members").update({**changes, "updated_at": now_iso()})
        .eq("town_id", tid).eq("user_id", uid).execute().data[0]
    )


@router.get("/{town_id}")
def get_town(town_id: UUID, live: bool = Query(False, description="true: skip the town row (tiles + map); for polling"),
             uid: str = Depends(current_user_id)):
    """Everything needed to render the town: map, members (with profile and AI-set mood/activity/state), agents.
    The 3D town loads the map once (plain call) and then polls with ?live=1: people move, the map doesn't."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    members = (
        db.table("town_members").select("*, profiles(id, display_name, avatar, interests)")
        .eq("town_id", tid).order("joined_at").execute().data or []
    )
    agents = db.table("agents").select("*").eq("town_id", tid).execute().data or []
    now = local_now()
    names = {
        m["user_id"]: m.get("name") or (m.get("profiles") or {}).get("display_name") or "Friend"
        for m in members
    }
    schedules = events_for_users(
        db, list(names), now.replace(hour=0, minute=0, second=0, microsecond=0), now + timedelta(days=3),
    )
    for ev in schedules:
        ev["display_name"] = names.get(ev["user_id"]) or "Friend"
    # town_time re-anchors the client's town clock, which places people and walks (the slider is lighting only).
    view = {"members": members, "agents": agents, "schedules": schedules, "town_time": now.isoformat(), "mode": clock_mode()}
    return view if live else {"town": load_town(db, tid), **view}


@router.patch("/{town_id}")
def update_town(town_id: UUID, body: TownUpdate, uid: str = Depends(current_user_id)):
    """Rename the town or replace its tiles / map. Creator only."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    town = load_town(db, tid)
    if town["created_by"] != uid:
        raise HTTPException(status_code=403, detail="only the town's creator can edit it")
    changes = body.model_dump(exclude_none=True)
    check_places(changes.get("tiles", town["tiles"]), body.map.places if body.map else {})
    if not changes:
        raise HTTPException(status_code=422, detail="nothing to update")
    return db.table("towns").update(changes).eq("id", tid).execute().data[0]


@router.patch("/{town_id}/members/me")
def place_house(town_id: UUID, body: HouseUpdate, uid: str = Depends(current_user_id)):
    """Put your house on a tile. Your character moves there too."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    tiles = load_town(db, tid)["tiles"]
    spots = [(body.house_x, body.house_y)]
    if body.home:
        spots += [tuple(t) for t in (body.home.driveway, body.home.door) if t]
    if not all(in_bounds(tiles, x, y) for x, y in spots):
        raise HTTPException(status_code=422, detail="house, driveway or door is outside the town map")
    change = {"house_x": body.house_x, "house_y": body.house_y, "updated_at": now_iso()}
    if body.home:
        change["home"] = body.home.model_dump(exclude_none=True)
    row = (
        db.table("town_members").update(change)
        .eq("town_id", tid).eq("user_id", uid).execute().data[0]
    )
    door = (row.get("home") or {}).get("door")
    if door:  # without a door there's nowhere valid to stand them; they stay where they are
        park_at_home(db, tid, uid, [body.house_x, body.house_y], door, "house")
    return row


@router.post("/{town_id}/members/me/move")
def move_me(town_id: UUID, body: MoveIn, uid: str = Depends(current_user_id)):
    """Walk your character to a building. Everyone sees it via the agents row (realtime / snapshot):
    clients animate from (x, y) starting at updated_at, so late viewers can place you mid-walk."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    town = load_town(db, tid)
    tiles = town["tiles"]
    if not in_bounds(tiles, body.from_x, body.from_y):
        raise HTTPException(status_code=422, detail="from_x/from_y is outside the town map")
    members = db.table("town_members").select("user_id, house_x, house_y, home").eq("town_id", tid).execute().data or []
    dest = next((b for b in buildings(town.get("map"), members) if b["id"] == body.building_id), None)
    if dest is None:
        raise HTTPException(status_code=422, detail="no such building in this town")
    if dest["x"] is None:
        raise HTTPException(status_code=409, detail="that building has no position yet (no map, or house not placed)")
    home = body.building_id == house_building_id(uid)
    action = AgentAction.go_home.value if home else AgentAction.walk_to.value
    target = {
        "building_id": dest["id"], "x": dest["x"], "y": dest["y"], "door": dest["door"], "by": "user",
        "travel_minutes": body.travel_minutes or estimate_travel_minutes(dest["id"]),
        "depart_at": local_now().isoformat(),
    }
    row = (
        db.table("agents").update(stamp(
            {"x": body.from_x, "y": body.from_y, "action": action, "target": target,
             "next_decision_at": iso_in(USER_MOVE_HOLD_SECONDS), "updated_at": now_iso()}
        )).eq("town_id", tid).eq("user_id", uid).execute().data
    )
    db.table("agent_actions").insert(
        {"town_id": tid, "user_id": uid, "action": action, "written_by": writer("move"),
         "details": {"by": "user", "target_building_id": dest["id"], "from": [body.from_x, body.from_y]}}
    ).execute()
    return row[0]


@router.delete("/{town_id}", status_code=204)
def delete_town(town_id: UUID, uid: str = Depends(current_user_id)):
    """The creator deletes the whole town: houses, characters, calendars and invites go with it. Everyone else
    who lived there gets a notice in their Inbox saying who deleted it."""
    db, tid = get_client(), str(town_id)
    me = require_member(db, tid, uid)
    town = db.table("towns").select("name, created_by").eq("id", tid).limit(1).execute().data
    if not town or town[0]["created_by"] != uid:
        raise HTTPException(status_code=403, detail="only the town's creator can delete it")
    others = (db.table("town_members").select("user_id").eq("town_id", tid).neq("user_id", uid)
              .execute().data or [])
    by_name = me.get("name") or ((db.table("profiles").select("display_name").eq("id", uid).limit(1)
                                  .execute().data or [{}])[0].get("display_name")) or "The creator"
    if others:
        db.table("notifications").insert([
            {"user_id": o["user_id"], "kind": "town_deleted", "payload": {"town_name": town[0]["name"], "by_name": by_name}}
            for o in others
        ]).execute()
    db.table("towns").delete().eq("id", tid).execute()  # cascades to members, agents, events, invites


@router.delete("/{town_id}/members/me", status_code=204)
def leave_town(town_id: UUID, uid: str = Depends(current_user_id)):
    """Leave a town (your character goes with you). If you created it, it passes to the longest-standing
    member so someone can still invite people; if you were the last one there, the town is deleted."""
    db, tid = get_client(), str(town_id)
    me = require_member(db, tid, uid)
    town = db.table("towns").select("created_by").eq("id", tid).limit(1).execute().data
    if town and town[0]["created_by"] == uid:
        others = (db.table("town_members").select("town_id, user_id, joined_at").eq("town_id", tid)
                  .neq("user_id", uid).execute().data or [])
        transfers, deletes = plan_town_handoff([tid], others)
        if deletes:
            db.table("towns").delete().eq("id", tid).execute()  # cascades to members, agents, events
            return
        db.table("towns").update({"created_by": transfers[tid]}).eq("id", tid).execute()
    db.table("town_members").delete().eq("town_id", tid).eq("user_id", uid).execute()
    if me.get("house_x") is not None:
        free_home_slot(db, load_town(db, tid), (me["house_x"], me["house_y"]))


@router.get("/{town_id}/events")
def list_events(
    town_id: UUID,
    event_type: str | None = Query(None, alias="type", description="personal, quest, news, ..."),
    status: str | None = None,
    limit: int = Query(50, ge=1, le=200),
    uid: str = Depends(current_user_id),
):
    """Calendar items people shared, newest first, each with who is going."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    q = db.table("events").select("*, event_participants(user_id, status)").eq("town_id", tid)
    if event_type:
        q = q.eq("type", event_type)
    if status:
        q = q.eq("status", status)
    return q.order("created_at", desc=True).limit(limit).execute().data or []


@router.post("/{town_id}/events", status_code=201)
def propose_event(town_id: UUID, body: EventCreate, uid: str = Depends(current_user_id)):
    """Share something on your calendar (class, work, gym, dinner). You are going; others listed are going too."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    others = {str(p) for p in body.participant_ids} - {uid}
    members = {m["user_id"] for m in db.table("town_members").select("user_id").eq("town_id", tid).execute().data or []}
    if not others <= members:
        raise HTTPException(status_code=422, detail="every participant must be in this town")
    dest = destination_for(
        {"building_id": body.building_id, "text": body.text, "kind": body.kind}, uid
    )
    event = (
        db.table("events").insert(
            {
                "town_id": tid,
                "type": EventType.personal.value,
                "title": body.title.strip(),
                "text": body.text,
                "kind": body.kind,
                "start_at": body.start,
                "end_at": body.end,
                "building_id": dest,
                "travel_minutes": body.travel_minutes or estimate_travel_minutes(dest, body.text),
                "status": EventStatus.active.value,
            }
        ).execute().data[0]
    )
    participants = [{"event_id": event["id"], "user_id": u, "status": ParticipantStatus.accepted.value} for u in [uid, *others]]
    db.table("event_participants").insert(participants).execute()
    return {**event, "event_participants": [{"user_id": p["user_id"], "status": p["status"]} for p in participants]}


@router.get("/{town_id}/buildings/{building_id}/visits")
def building_visits(town_id: UUID, building_id: str, uid: str = Depends(current_user_id)):
    """Who headed to this building today (town time, from the activity log): each person's latest trip, newest first.
    The 3D town adds who's there now and who's on the way from what it's drawing."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    midnight = datetime.now(TOWN_TZ).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = (
        db.table("agent_actions").select("user_id, action, created_at").eq("town_id", tid)
        .filter("details->>target_building_id", "eq", building_id).gte("created_at", midnight.isoformat())
        .order("created_at", desc=True).limit(300).execute().data or []
    )
    latest = {}
    for r in rows:
        latest.setdefault(r["user_id"], r)
    return [{"user_id": u, "action": r["action"], "at": r["created_at"]} for u, r in latest.items()]


@router.get("/{town_id}/activity")
def town_activity(
    town_id: UUID,
    limit: int = Query(50, ge=1, le=200),
    after_id: int | None = Query(None, description="only actions newer than this id (for polling)"),
    uid: str = Depends(current_user_id),
):
    """Character decisions, newest first. Chat bubbles are in details.lines."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    q = db.table("agent_actions").select("*").eq("town_id", tid)
    if after_id is not None:
        q = q.gt("id", after_id)
    return q.order("id", desc=True).limit(limit).execute().data or []
