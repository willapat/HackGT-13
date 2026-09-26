def apply_gift(db, town_id: str, giver_id: str, receiver_id: str) -> bool:
    rows = (
        db.table("inventory")
        .select("qty")
        .eq("user_id", giver_id)
        .eq("item_type", "gift")
        .limit(1)
        .execute()
        .data
        or []
    )
    qty = rows[0]["qty"] if rows else 0
    if qty <= 0:
        return False
    db.table("inventory").update({"qty": qty - 1}).eq("user_id", giver_id).eq("item_type", "gift").execute()
    _ = (town_id, receiver_id)
    return True
