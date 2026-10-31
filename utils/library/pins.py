"""Card pins for LoRAs and models (2026-10-29).

A pin is a record field (``pinned``) like ``favorite``: one value every node and the Portal
read, saved in the LoRA / model metadata. LoRAs and models share one cap (MAX_PINNED in
web/js/shared/pinning.js) because Model Library lists both. Folder pins are separate
(folder stores).
"""
from ..krc_paths import read_max_pinned


def pinned_ids(indexes=None):
    """Every pinned LoRA and model id. ``indexes`` = (LoRA index, model index), when the
    caller already holds them."""
    if indexes is None:
        # Imported here: LoRA Loadout's write path calls this, and model_library imports
        # lora_loadout, never the other way round at module level.
        from ..lora_loadout.library_index import LoraLibraryIndex
        from ..model_library.library_index import ModelLibraryIndex

        indexes = (LoraLibraryIndex(), ModelLibraryIndex())
    return {
        record.get("library_id")
        for index in indexes
        for record in index.all()
        if (record.get("sidecar_data") or {}).get("pinned")
    }


def pin_limit_problem(ids, indexes=None):
    """Why pinning ``ids`` (on top of what is pinned) is refused, else None."""
    limit = read_max_pinned()
    if len(pinned_ids(indexes) | set(ids)) > limit:
        return f"Only {limit} models and LoRAs can be pinned. Unpin one first."
    return None
