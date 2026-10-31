"""Bundle imports run off ComfyUI's event loop (import security, stage C).

Unpacking and writing a big bundle used to run on the server's loop, so the whole of
ComfyUI (the UI, queued runs, every other request) froze until it finished. run_import
runs the import function in a worker thread instead. Imports still run one at a time, as
they did, so two imports never interleave their writes. krc.db is safe from any thread
(a connection per thread, writes serialized in utils/db/connection.py).
"""
import asyncio

_lock = None


async def run_import(function, *args, **kwargs):
    """-> function(*args, **kwargs), run in a worker thread; its exceptions propagate."""
    global _lock
    if _lock is None:
        _lock = asyncio.Lock()
    async with _lock:
        return await asyncio.to_thread(function, *args, **kwargs)
