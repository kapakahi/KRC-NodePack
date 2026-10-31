"""Model Library's LoRA read-through: LoRAs show in the Model Library through LoRA Loadout's
index and serializer (schema S8; ML never writes LoRA records itself). The lookup, the
Info-panel detail payload, and whether an id is a read-through LoRA."""

from ..lora_loadout.library_index import LoraLibraryIndex
from .library_index import ModelLibraryIndex


def _lora_index_get(library_id):
    """Resolve a LoRA record by id through LoRA Loadout, or None. Kept lazy so a missing/
    broken LL never blocks Model Library from loading."""
    if not library_id:
        return None
    try:
        index = LoraLibraryIndex()
        index.refresh()
        record = index.get(library_id)
        return (record, index) if record else None
    except Exception:  # noqa: BLE001
        return None


def _lora_detail_payload(library_id):
    """Serialize a LoRA to LoRA Loadout's own /detail shape for read-through display in
    the Model Library InfoPanel, or None if the id is not a LoRA. Reuses LL's serializer
    so the cloned LoRA panel receives exactly what it expects (schema S8: read-only)."""
    resolved = _lora_index_get(library_id)
    if not resolved:
        return None
    record, index = resolved
    try:
        from ..lora_loadout.presets import FolderColorStore as _LoraFolderColorStore
        from ..lora_loadout.serialize import _serialize_lora, seed_unstabilized_lora
    except Exception:  # noqa: BLE001
        return None
    # Freeze Date Added on first view from EITHER node. ML never writes LoRA records itself
    # (schema §8 read-through is read-only) — it delegates the seed write to LoRA Loadout's
    # own writer, exactly as the Civitai read-through delegates to LL's mapper.
    record = seed_unstabilized_lora(record)
    sidecar = record.get("sidecar_data") or {}
    folders = _LoraFolderColorStore().load().get("folders", {})
    return _serialize_lora(
        record,
        sidecar,
        folders,
        include_heavy_text=True,
        include_detail_fields=True,
    )


async def _is_lora_read_through(library_id):
    """True when an id is a LoRA shown through Model Library, not a generic model: its
    thumbnail writes belong to LoRA Loadout (its own dirs, sidecar and record)."""
    if not library_id or (await ModelLibraryIndex.loaded()).get(library_id):
        return False
    return bool((await LoraLibraryIndex.loaded()).get(library_id))
