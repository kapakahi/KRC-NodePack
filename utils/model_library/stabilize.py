"""One generic-model stabilization path for individual calls and selected jobs."""
import asyncio

from ..library.stabilize_registry import stabilize_single_flight
from ..lora_loadout.library_index import LoraLibraryIndex
from ..lora_loadout.identity import IdentityStore as LoraIdentityStore
from ..lora_loadout.stabilize import stabilize_lora_by_id
from .identity import IdentityStore, is_local_library_id
from .identity_records import stabilize_record_identity
from .library_index import ModelLibraryIndex

_lock = None


async def stabilize_model_off_loop(record):
    async def run():
        global _lock
        if _lock is None:
            _lock = asyncio.Lock()
        async with _lock:
            return await asyncio.get_running_loop().run_in_executor(None, stabilize_record_identity, record)

    key = f"model:{IdentityStore().canonical_id(record.get('library_id') or '')}"
    return await stabilize_single_flight(key, run)


async def stabilize_model_by_id(library_id):
    index = await ModelLibraryIndex.loaded()
    record = index.get(library_id) or index.get(IdentityStore().canonical_id(library_id))
    if not record:
        loras = await LoraLibraryIndex.loaded()
        lora = loras.get(library_id) or loras.get(LoraIdentityStore().canonical_id(library_id))
        if lora:
            return await stabilize_lora_by_id(lora["library_id"])
        return {"error": "not-found", "libraryId": library_id}, 404
    if not is_local_library_id(record.get("library_id")):
        return {"ok": True, "identity": None, "item": record}, 200
    try:
        promoted, identity = await stabilize_model_off_loop(record)
    except OSError as exc:
        return {"error": str(exc) or "hash-failed", "libraryId": library_id}, 400
    if identity:
        index.records.pop(identity["oldId"], None)
        index.records[identity["newId"]] = promoted
        ModelLibraryIndex.note_record_changed()
        # Refresh one promoted row's derived thumbnail URLs/flags and current metadata.
        # Background work has no route-level rescan to rebuild those scan facts.
        promoted = index.refresh_record(identity["newId"]) or promoted
    return {"ok": True, "identity": identity, "item": promoted}, 200
