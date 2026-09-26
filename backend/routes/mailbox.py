"""Mailboxes: every member with a house has one in the 3D town. Clicking a townmate's mailbox leaves them a note;
your own shows what people left you. Notes are written by people, never generated, and never read by the town brain.
The recipient also gets an Inbox notice (kind `mail`) so they see it outside the town."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from backend.auth import current_user_id, require_member
from backend.db import get_client, now_iso
from backend.models.api import MailIn

router = APIRouter(prefix="/towns", tags=["mailbox"])


def member_names(db, tid: str) -> dict[str, dict]:
    rows = (db.table("town_members").select("user_id, name, color, house_x, profiles(display_name, avatar)")
            .eq("town_id", tid).execute().data or [])
    return {
        r["user_id"]: {
            "name": r.get("name") or (r.get("profiles") or {}).get("display_name") or "Someone",
            "color": r.get("color") or ((r.get("profiles") or {}).get("avatar") or {}).get("color"),
            "has_house": r.get("house_x") is not None,
        }
        for r in rows
    }


def mail_item(row: dict, people: dict) -> dict:
    who = people.get(row["from_user"]) or {"name": "A former neighbor", "color": None}
    return {
        "id": row["id"], "text": row["text"], "created_at": row["created_at"], "read": row.get("read_at") is not None,
        "from": {"id": row["from_user"], "name": who["name"], "color": who["color"],
                 "in_town": row["from_user"] in people},
    }


@router.get("/{town_id}/mailbox")
def my_mailbox(town_id: UUID, uid: str = Depends(current_user_id)):
    """Notes left in your mailbox in this town, newest first, and how many you haven't opened."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    rows = (db.table("mailbox_messages").select("*").eq("town_id", tid).eq("to_user", uid)
            .order("created_at", desc=True).limit(100).execute().data or [])
    people = member_names(db, tid)
    return {"messages": [mail_item(r, people) for r in rows], "unread": sum(1 for r in rows if not r.get("read_at"))}


@router.post("/{town_id}/mailbox", status_code=201)
def send_mail(town_id: UUID, body: MailIn, uid: str = Depends(current_user_id)):
    """Leave a note in a townmate's mailbox."""
    db, tid, to = get_client(), str(town_id), str(body.to_user_id)
    require_member(db, tid, uid)
    if to == uid:
        raise HTTPException(status_code=422, detail="that's your own mailbox")
    people = member_names(db, tid)
    if not people.get(to, {}).get("has_house"):
        raise HTTPException(status_code=404, detail="no mailbox for that person in this town")
    rows = db.table("mailbox_messages").insert({"town_id": tid, "to_user": to, "from_user": uid, "text": body.text}).execute().data
    if not rows:
        raise HTTPException(status_code=500, detail="insert failed")
    town = db.table("towns").select("name").eq("id", tid).limit(1).execute().data or [{}]
    db.table("notifications").insert({"user_id": to, "kind": "mail", "payload": {
        "by_name": people[uid]["name"], "by_user_id": uid, "town_id": tid, "town_name": town[0].get("name") or "a town",
        "text": body.text[:140]}}).execute()
    return mail_item(rows[0], people)


@router.post("/{town_id}/mailbox/read", status_code=204)
def read_mail(town_id: UUID, uid: str = Depends(current_user_id)):
    """You opened your mailbox: everything in it is read."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    (db.table("mailbox_messages").update({"read_at": now_iso()}).eq("town_id", tid).eq("to_user", uid)
     .is_("read_at", "null").execute())


@router.delete("/{town_id}/mailbox/{message_id}", status_code=204)
def delete_mail(town_id: UUID, message_id: int, uid: str = Depends(current_user_id)):
    """Throw away a note from your own mailbox."""
    db, tid = get_client(), str(town_id)
    require_member(db, tid, uid)
    db.table("mailbox_messages").delete().eq("id", message_id).eq("town_id", tid).eq("to_user", uid).execute()
