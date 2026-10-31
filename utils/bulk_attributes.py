"""Shared, bounded attribute-only batch contract for card providers."""
from .custom_badge import normalize_custom_badge
from .library.card_colors import CARD_COLOR_IDS
from .krc_paths import read_max_pinned
from .bulk_selection import validate_card_ids
from .bulk_sync import announce_prompt_bulk


def validate_bulk_attributes(payload, *, allow_pin=True):
    if not isinstance(payload, dict):
        raise ValueError("Expected an attribute request.")
    ids = validate_card_ids(payload.get("ids"))
    field, value = payload.get("field"), payload.get("value")
    if field in ("favorite", "nsfw", "pinned"):
        if field == "pinned" and not allow_pin:
            raise ValueError("Pins are not supported for these cards.")
        if not isinstance(value, bool):
            raise ValueError("Use an explicit true or false value.")
        if field == "pinned" and value and len(ids) > 5:
            raise ValueError("Pinning is limited to 5 selected cards. Unpinning has no selection limit.")
    elif field == "cardColor":
        if not isinstance(value, str) or value not in CARD_COLOR_IDS | {""}:
            raise ValueError("Unknown card color.")
    elif field == "customBadge":
        if not isinstance(value, str):
            raise ValueError("Invalid custom badge.")
        value = normalize_custom_badge(value)
        if value is None:
            raise ValueError("Invalid custom badge (letters, numbers, spaces; 10 max; no reserved labels).")
    else:
        raise ValueError("Unsupported bulk attribute.")
    return ids, field, value


def check_bulk_pin_capacity(records, selected, value):
    """Preflight the complete batch; never silently pin a subset."""
    if value:
        wanted = set(selected)
        count = sum(bool(record.get("pinned")) or record.get("id") in wanted for record in records)
        limit = read_max_pinned()
        if count > limit:
            raise ValueError(f"Only {limit} cards can be pinned. Unpin some cards first.")


def update_prompt_attributes(store, payload):
    from .db import connection as db

    ids, field, value = validate_bulk_attributes(payload)
    with db.write():
        prompts = store.load_prompts()
        records = {record["id"]: record for bucket in prompts.values() if isinstance(bucket, dict)
                   for name, record in bucket.items()
                   if name != "__meta__" and isinstance(record, dict) and record.get("id")}
        if any(item_id not in records for item_id in ids):
            raise ValueError("A selected prompt no longer exists. Refresh and select again.")
        if field == "pinned":
            check_bulk_pin_capacity(records.values(), ids, value)
        updated = sum(records[item_id].get(field, "" if field in ("cardColor", "customBadge") else False) != value for item_id in ids)
        for item_id in ids:
            records[item_id][field] = value
        # Attribute-only edits keep content, dates, thumbnails and unknown fields.
        store.save_prompts(prompts)
    if updated:
        announce_prompt_bulk(payload.get("originPage"))
    return {"success": True, "ids": ids, "updated": updated, "skipped": len(ids) - updated,
            "prompts": store.prompts_for_response(prompts)}
