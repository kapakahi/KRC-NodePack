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
