"""Bounded off-loop preparation/encoding of fresh library HTTP responses."""
import asyncio

from ..db import connection as db


def _read_response(prepare):
    # All stores consulted by a response share this worker's DB read snapshot.
    with db.read():
        return prepare()


async def prepare_library_response(prepare):
    loop = asyncio.get_running_loop()
    # Per-loop ownership avoids sharing an asyncio primitive across test/server loops.
    slots = getattr(loop, "_krc_library_response_slots", None)
    if slots is None:
        slots = loop._krc_library_response_slots = asyncio.Semaphore(2)
    await slots.acquire()
    try:
        work = loop.run_in_executor(None, _read_response, prepare)
    except BaseException:
        slots.release()
        raise

    def finished(task):
        slots.release()
        # A disconnected caller can leave the shielded worker running. Retrieve its
        # failure as well; an awaiting caller still receives the original exception.
        if not task.cancelled():
            task.exception()

    work.add_done_callback(finished)
    # Cancellation must not free a slot while its worker is still consuming it.
    return await asyncio.shield(work)
