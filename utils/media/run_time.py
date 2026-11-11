"""How long the run that made a Media Output item took (``runMs`` on the item, 2026-11-10).

ComfyUI keeps each finished prompt in its history with timestamped status messages:
``execution_start`` and, for a run that completed, ``execution_success`` (milliseconds).
The run's time is the difference: the whole prompt, from its first node to its last (time
waiting in the queue isn't counted).

Media Output saves while the prompt is still running, so the time isn't known yet. It hands
the prompt id and the saved item ids to ``watch``; one background thread checks ComfyUI's
history about once a second and, when the prompt is there, writes ``runMs`` on those items
(media_store.set_run_ms) and tells open pages. A run that failed, was interrupted, or
whose history has no timestamps (an older ComfyUI) gets no time. Watching stops after
WATCH_LIMIT_S; nothing is kept across a restart (an unfinished watch just gives up).
"""
import threading
import time

POLL_S = 1.0
WATCH_LIMIT_S = 6 * 60 * 60
MAX_WATCHED = 256
TAG = "[KRC Media]"

_lock = threading.Lock()
_pending = {}            # prompt id -> {"ids": [...], "since": time}
_thread = None


def current_prompt_id():
    """The prompt ComfyUI is running now ("" outside ComfyUI)."""
    try:
        from server import PromptServer
        return str(getattr(PromptServer.instance, "last_prompt_id", "") or "")
    except Exception:  # noqa: BLE001
        return ""


def _history(prompt_id):
    from server import PromptServer
    found = PromptServer.instance.prompt_queue.get_history(prompt_id=prompt_id)
    return (found or {}).get(prompt_id)


def run_ms(entry):
    """A history entry -> its run time in ms, None when it can't be told (not a success, no
    timestamps)."""
    status = (entry or {}).get("status") or {}
    stamps = {}
    for message in status.get("messages") or []:
        if isinstance(message, (list, tuple)) and len(message) == 2 and isinstance(message[1], dict):
            stamp = message[1].get("timestamp")
            if isinstance(stamp, (int, float)) and not isinstance(stamp, bool):
                stamps.setdefault(message[0], stamp)
    if status.get("status_str") != "success" or "execution_start" not in stamps or "execution_success" not in stamps:
        return None
    elapsed = int(stamps["execution_success"] - stamps["execution_start"])
    return elapsed if elapsed >= 0 else None


def watch(prompt_id, item_ids):
    """Fill ``runMs`` on ``item_ids`` once prompt ``prompt_id`` is in ComfyUI's history."""
    global _thread
    if not prompt_id or not item_ids:
        return
    with _lock:
        entry = _pending.setdefault(prompt_id, {"ids": [], "since": time.monotonic()})
        entry["ids"].extend(item_ids)
        while len(_pending) > MAX_WATCHED:
            _pending.pop(next(iter(_pending)))
        if _thread is None or not _thread.is_alive():
            _thread = threading.Thread(target=_run, name="krc-media-run-time", daemon=True)
            _thread.start()


def _finish(prompt_id, ids, elapsed):
    from . import media_store as store
    try:
        if store.set_run_ms(ids, elapsed):
            from .media_routes import _announce
            _announce("update")
    except Exception as err:  # noqa: BLE001 - a missed time never matters to the run
        print(f"{TAG} couldn't store a run time: {type(err).__name__}")


def check_once(now=None):
    """One pass over the watched prompts (the thread's loop; tests call it directly).
    -> how many are still waiting."""
    now = time.monotonic() if now is None else now
    with _lock:
        waiting = list(_pending.items())
    for prompt_id, entry in waiting:
        try:
            found = _history(prompt_id)
        except Exception:  # noqa: BLE001 - no queue (outside ComfyUI): stop watching
            found, entry["since"] = None, -WATCH_LIMIT_S
        if found is None and now - entry["since"] < WATCH_LIMIT_S:
            continue
        with _lock:
            _pending.pop(prompt_id, None)
        elapsed = run_ms(found) if found is not None else None
        if elapsed is not None:
            _finish(prompt_id, list(dict.fromkeys(entry["ids"])), elapsed)
    with _lock:
        return len(_pending)


def _run():
    global _thread
    while True:
        time.sleep(POLL_S)
        if not check_once():
            with _lock:
                if not _pending:
                    _thread = None
                    return
