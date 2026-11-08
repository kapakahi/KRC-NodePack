"""Atomic attribute patches using the existing model/LoRA metadata writers."""
from pathlib import Path

from ..bulk_attributes import validate_bulk_attributes
from ..db import connection as db
from ..library.pins import pin_limit_problem
from ..lora_loadout.library_index import LoraLibraryIndex
from ..lora_loadout.metadata import read_krc_metadata
from ..lora_loadout.write_handlers import save_lora_metadata_record
from .library_index import ModelLibraryIndex
from .metadata import read_model_metadata, normalize_model_metadata, write_model_metadata
from ..bulk_sync import announce_model_attributes


async def update_model_attributes(payload):
    ids, field, value = validate_bulk_attributes(payload)
    loras = await LoraLibraryIndex.loaded()
    models = await ModelLibraryIndex.loaded()
    if field == "pinned" and value:
        problem = pin_limit_problem(ids, (loras, models))
        if problem:
            raise ValueError(problem)
    targets = []
    for item_id in ids:
        lora = loras.get(item_id)
        record = lora or models.get(item_id)
        if not record:
            raise ValueError("A selected model no longer exists. Refresh and select again.")
        targets.append((item_id, bool(lora), record))
    changed = []
    with db.write():
        for item_id, is_lora, record in targets:
            stored = read_krc_metadata(item_id) if is_lora else read_model_metadata(item_id, record.get("modelType"))
            metadata = dict(stored or record.get("sidecar_data") or {})
            if metadata.get(field, "" if field in ("cardColor", "customBadge") else False) == value:
                continue
            if is_lora:
                # Only mutate the live scan cache after the whole transaction commits.
                copy = {**record, "sidecar_data": metadata}
                body, status = save_lora_metadata_record(copy, {field: value})
                if status != 200:
                    raise ValueError(body.get("error", "Could not save LoRA attributes."))
                changed.append((item_id, True, copy))
            else:
                metadata[field] = value
                normalized = normalize_model_metadata(Path(record["path"]), item_id, metadata)
                write_model_metadata(record, normalized)
                changed.append((item_id, False, record))
    for item_id, is_lora, saved in changed:
        if is_lora:
            loras.get(item_id)["sidecar_data"] = saved["sidecar_data"]
        else:
            models.refresh_record(item_id)
    if changed:
        announce_model_attributes([item_id for item_id, _is_lora, _saved in changed], field, value, payload.get("originPage"))
    return {"ok": True, "ids": ids, "updated": len(changed), "skipped": len(ids) - len(changed)}


# ---- one card's marks at once (the external API's card marks, ext_api_prompts.py) -------

MARK_FIELDS = ("favorite", "pinned", "nsfw", "cardColor", "customBadge")


def marks_of(data):
    """The five card marks of a record / row / sidecar, normalized."""
    data = data if isinstance(data, dict) else {}
    return {"favorite": bool(data.get("favorite")), "pinned": bool(data.get("pinned")), "nsfw": bool(data.get("nsfw")),
            "cardColor": str(data.get("cardColor") or ""), "customBadge": str(data.get("customBadge") or "")}


def marks_version(data):
    """A short hash of a model's / LoRA's five card marks: what a marks write must send."""
    import hashlib
    import json
    return hashlib.sha1(json.dumps(marks_of(data), sort_keys=True).encode("utf-8")).hexdigest()[:16]


class MarksConflict(ValueError):
    """The card's marks changed since the client read them; ``current`` is them now."""

    def __init__(self, current):
        super().__init__("That card changed since you read it. Read it again, then retry.")
        self.current = current


async def update_model_marks(item_id, marks, if_version=None, origin_page=""):
    """Set any of the five card marks on one model or LoRA in one transaction, through the
    same writers as update_model_attributes (each field validated by its rules; the pin cap).
    ``if_version`` (marks_version) is checked inside the transaction: MarksConflict when
    stale. -> {"id", "marks", "marksVersion", "updated": [fields that changed]}."""
    # The shared validator's rules, and its normalized values (e.g. the badge's).
    marks = {field: validate_bulk_attributes({"ids": [item_id], "field": field, "value": value})[2]
             for field, value in marks.items()}
    loras = await LoraLibraryIndex.loaded()
    models = await ModelLibraryIndex.loaded()
    lora = loras.get(item_id)
    record = lora or models.get(item_id)
    if not record:
        raise LookupError("No model has that id.")
    if marks.get("pinned") is True:
        problem = pin_limit_problem([item_id], (loras, models))
        if problem and not marks_of(record.get("sidecar_data")).get("pinned"):
            raise ValueError(problem)
    with db.write():
        stored = read_krc_metadata(item_id) if lora else read_model_metadata(item_id, record.get("modelType"))
        metadata = dict(stored or record.get("sidecar_data") or {})
        if if_version is not None and marks_version(metadata) != if_version:
            raise MarksConflict(marks_of(metadata))
        changed = [field for field, value in marks.items() if marks_of(metadata)[field] != value]
        if changed:
            if lora:
                copy = {**record, "sidecar_data": metadata}
                body, status = save_lora_metadata_record(copy, {field: marks[field] for field in changed})
                if status != 200:
                    raise ValueError(body.get("error", "Could not save the LoRA's marks."))
                metadata = copy["sidecar_data"]
            else:
                for field in changed:
                    metadata[field] = marks[field]
                metadata = normalize_model_metadata(Path(record["path"]), item_id, metadata)
                write_model_metadata(record, metadata)
    if changed:
        if lora:
            loras.get(item_id)["sidecar_data"] = metadata
        else:
            models.refresh_record(item_id)
        for field in changed:
            announce_model_attributes([item_id], field, marks[field], origin_page)
    current = marks_of(metadata)
    return {"id": item_id, "marks": current, "marksVersion": marks_version(current), "updated": changed}
