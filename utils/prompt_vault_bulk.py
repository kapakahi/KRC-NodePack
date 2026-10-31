"""Saved-prompt Move/Delete: ID snapshots, collision preflight and one transaction."""
import time

from .bulk_selection import validate_card_ids
from .db import connection as db
from .bulk_sync import announce_prompt_bulk


def prompt_bulk_operation(store, payload, *, preview=False):
    if not isinstance(payload, dict) or payload.get("operation") not in ("move", "delete"):
        raise ValueError("Unsupported prompt operation.")
    ids = validate_card_ids(payload.get("ids"))
    operation = payload["operation"]
    if not preview and operation == "delete" and payload.get("confirmed") is not True:
        raise ValueError("Confirm deletion before continuing.")
    with db.write():
        prompts = store.load_prompts()
        records = {record["id"]: (category, name, record)
                   for category, bucket in prompts.items() if isinstance(bucket, dict)
                   for name, record in bucket.items()
                   if name != "__meta__" and isinstance(record, dict) and record.get("id")}
        if any(item_id not in records for item_id in ids):
            raise ValueError("A selected prompt no longer exists. Refresh and select again.")
        if preview:
            return {"success": True, "count": len(ids),
                    "destinations": [{"value": category, "label": category} for category in prompts],
                    "message": ("Deletes the saved prompts and their thumbnails. Workflow and preset references are not rewritten; deleted references may be missing when loaded. Unsaved edits to deleted prompts will be discarded."
                                if operation == "delete" else "Moves the saved records, keeping their IDs and names. Name collisions reject the entire batch; nothing is overwritten. Unsaved content is not saved by this action.")}
        changed, skipped = [], 0
        if operation == "move":
            destination = payload.get("destination")
            if not isinstance(destination, str) or destination not in prompts:
                raise ValueError("That destination category no longer exists.")
            # Include selected records already in the destination and collisions among
            # selected source categories. Validate everything before modifying a record.
            names = {name.lower(): record.get("id") for name, record in prompts[destination].items()
                     if name != "__meta__" and isinstance(record, dict)}
            for item_id in ids:
                _category, name, _record = records[item_id]
                if name.lower() in names and names[name.lower()] != item_id:
                    raise ValueError(f"A prompt named '{name}' would collide in '{destination}'. No prompts were moved.")
                names[name.lower()] = item_id
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            for item_id in ids:
                category, name, record = records[item_id]
                if category == destination:
                    skipped += 1
                    continue
                del prompts[category][name]
                record["dateAdded"] = record.get("dateAdded") or now
                record["dateModified"] = now
                prompts[destination][name] = record
                changed.append({"id": item_id, "category": destination, "name": name,
                                "dateAdded": record["dateAdded"], "dateModified": now})
        else:
            for item_id in ids:
                category, name, _record = records[item_id]
                del prompts[category][name]
                changed.append({"id": item_id})
        if changed:
            store.save_prompts(prompts)
    warnings = []
    if operation == "delete":
        try:
            with db.write():
                store.gc_orphan_thumbnails(store.load_prompts())
        except OSError as exc:
            warnings.append(f"Prompts were deleted, but some orphan thumbnails could not be cleaned up: {exc}")
    if changed:
        announce_prompt_bulk(payload.get("originPage"))
    return {"success": True, "ids": ids, "updated": len(changed), "skipped": skipped,
            "records": changed if operation == "move" else [],
            "deleted": ids if operation == "delete" else [], "warnings": warnings,
            "prompts": store.prompts_for_response(prompts)}
