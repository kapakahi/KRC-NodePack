"""Single-flight registry for identity stabilization.

``compute_sha256`` reads the whole model file to hash it — seconds to minutes for
a 20GB+ model. Without coordination, two surfaces can each launch that read for
the SAME file: a background warm-on-edit and a point-of-need Civitai fetch, or
two nodes pointing at one model. This registry guarantees ONE in-flight
stabilization per key — the first caller starts it, every concurrent caller
awaits the same result, and the entry clears when it settles (success or error,
so a failed hash is retried rather than cached).

Keyed by a caller-supplied string (namespaced per lineage + canonical library
id) so the local-id and sha views of one file collapse to a single entry.
Process-local (one ComfyUI process) and async-only: all callers share the one
event loop, so the check-and-insert below needs no lock — there is no ``await``
between the read and the write.
"""

import asyncio

_INFLIGHT = {}


async def stabilize_single_flight(key, factory):
    """Run ``factory()`` at most once per ``key`` while it is in flight.

    ``factory`` is a zero-arg callable returning an awaitable; it is invoked only
    when this call is the one that starts the work (never for an attaching caller,
    so no orphan coroutine is created). Concurrent callers with the same key await
    the starter's result.
    """
    key = str(key or "").strip()
    if not key:
        return await factory()

    task = _INFLIGHT.get(key)
    if task is not None:
        return await task

    task = asyncio.ensure_future(factory())
    _INFLIGHT[key] = task
    try:
        return await task
    finally:
        # Clear only if still ours: the finally runs after the task settled, and a
        # later start for this key can only have happened after we popped, so this
        # never removes a newer in-flight entry.
        if _INFLIGHT.get(key) is task:
            _INFLIGHT.pop(key, None)
