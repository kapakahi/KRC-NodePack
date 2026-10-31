"""Process-local FIFO for accepted background Stabilize requests.

Runs on ComfyUI's event loop, independently of browser selection/lifetime. Actual
hashing, alias resolution and same-file deduplication stay in the existing service.
"""
import asyncio
from collections import deque

from ..server_sync import SYNC_EVENTS, publish_sync

_pending = deque()
_known = set()  # queued AND active IDs
_worker = None


async def _stabilize(item_id):
    from .stabilize import stabilize_model_by_id
    return await stabilize_model_by_id(item_id)


def enqueue_stabilize(item_id):
    """Accept a local ID once until it finishes. No model filesystem mutation."""
    global _worker
    item_id = str(item_id or "").strip()
    if not item_id.startswith("local-"):
        return {"ok": True, "queued": False, "libraryId": item_id}
    if item_id not in _known:
        _known.add(item_id)
        _pending.append(item_id)
    if _worker is None or _worker.done():
        _worker = asyncio.create_task(_drain())
    return {"ok": True, "queued": True, "libraryId": item_id}


async def _drain():
    global _worker
    try:
        while _pending:
            await asyncio.sleep(0)
            item_id = _pending.popleft()
            try:
                body, status = await _stabilize(item_id)
                if status != 200 or not body.get("ok"):
                    raise ValueError(body.get("error") or f"HTTP {status}")
                identity = body.get("identity")
                if identity:
                    publish_sync(SYNC_EVENTS["IDENTITY_CHANGED"], {"identity": identity})
            except Exception as exc:  # one missing/unreadable file cannot stall the queue
                print(f"[KRC Stabilize] {item_id}: {exc}")
            finally:
                _known.discard(item_id)
    finally:
        _worker = None
