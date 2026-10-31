"""Single-flight LoRA stabilize: promote a path-derived (local-) id to a content sha off
the event loop, serialized on one lock. Shared by the /stabilize route, Civitai fetch,
metadata saves and Model Library's LoRA read-through."""

import asyncio

from ..library.stabilize_registry import stabilize_single_flight
from .identity import IdentityStore, is_local_library_id
from .identity_records import stabilize_record_identity
from .library_index import LoraLibraryIndex


_STABILIZE_LOCK = None


async def _run_stabilize_locked(record):
    """Hash + promote off the event loop, serialized so concurrent calls can't
    race on the shared identity store."""
    global _STABILIZE_LOCK
    if _STABILIZE_LOCK is None:
        _STABILIZE_LOCK = asyncio.Lock()
    async with _STABILIZE_LOCK:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, stabilize_record_identity, record)


async def _stabilize_off_loop(record):
    """Promote a local id to a content-sha id without blocking the event loop.

    stabilize_record_identity() reads the whole LoRA file to hash it (minutes for
    a large model). Route it through the shared single-flight registry keyed by the
    canonical library id, so a background warm, a sibling node, and a point-of-need
    fetch of the SAME file attach to one hash instead of each launching their own.
    """
    key = f"lora:{IdentityStore().canonical_id(record.get('library_id') or '')}"
    return await stabilize_single_flight(key, lambda: _run_stabilize_locked(record))


async def stabilize_lora_by_id(library_id):
    """Promote a LoRA's path-derived (local-) id to a content sha, updating the index.
    Idempotent: already-stable ids are a no-op.

    Shared by the LoRA Loadout /stabilize route AND Model Library's LoRA read-through:
    a LoRA is a LoRA regardless of which node triggers it, so Model Library delegates
    the hash/promote here (mirroring _serialize_lora / the Civitai read-through) rather
    than forking the logic. Returns (body, status)."""
    index = await LoraLibraryIndex.loaded()
    record = index.get(library_id)
    if not record:
        return {"error": "Unknown LoRA id"}, 404
    if not is_local_library_id(record.get("library_id")):
        return {"ok": True, "identity": None}, 200
    record, promotion = await _stabilize_off_loop(record)
    if promotion:
        index.records.pop(promotion["oldId"], None)
        index.records[promotion["newId"]] = record
    return {"ok": True, "identity": promotion}, 200
