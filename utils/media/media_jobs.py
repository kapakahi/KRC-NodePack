"""Video conversions as background jobs (GAMEPLAN.md section 3): one worker converts one
upload at a time, reports progress, can be cancelled, and adds the Media item when it's
done. Jobs live in memory (an interrupted one leaves only its upload in incoming/, which
the startup cleanup removes).
"""

import threading
import time

from . import media_store as store
from .input_storage import prepare_upload
from .process_video import Cancelled, VideoProcessError, process

KEEP_FINISHED = 50      # finished jobs remembered (for the page that's still polling)

_jobs = {}              # id -> job dict
_queue = []             # ids waiting
_lock = threading.Lock()
_wake = threading.Event()
_worker = None
_on_added = None        # callback(item id, settings) after an item is added (the routes assign + announce)


def set_on_added(callback):
    global _on_added
    _on_added = callback


def _public(job):
    """A job as pages and the external API see it; ``itemId`` is the Media id the item gets
    when the conversion is done (fixed when the job is made)."""
    return {**{key: job.get(key) for key in ("id", "status", "progress", "error", "name", "item")},
            "itemId": (job.get("record") or {}).get("id", "")}


def submit(source, record, settings):
    """Queue a conversion of ``source`` (an upload in incoming/) into ``record`` (id, name,
    kind, ext). -> the job's public dict."""
    record = prepare_upload(record)
    job = {
        "id": store.new_id(), "status": "queued", "progress": 0.0, "error": "", "name": record.get("name", ""),
        "item": None, "source": source, "record": dict(record), "settings": dict(settings or {}),
        "cancel": False, "created": time.time(),
    }
    with _lock:
        _jobs[job["id"]] = job
        _queue.append(job["id"])
        _prune()
    _ensure_worker()
    _wake.set()
    return _public(job)


def get(job_id):
    with _lock:
        job = _jobs.get(str(job_id or ""))
        return _public(job) if job else None


def cancel(job_id):
    with _lock:
        job = _jobs.get(str(job_id or ""))
        if not job or job["status"] not in ("queued", "converting"):
            return False
        job["cancel"] = True
        if job["status"] == "queued":
            job["status"] = "cancelled"
            if job["id"] in _queue:
                _queue.remove(job["id"])
            _cleanup_source(job)
        return True


def _prune():
    finished = [job for job in _jobs.values() if job["status"] in ("done", "error", "cancelled")]
    for job in sorted(finished, key=lambda item: item["created"])[:-KEEP_FINISHED or None]:
        _jobs.pop(job["id"], None)


def _cleanup_source(job):
    try:
        job["source"].unlink(missing_ok=True)
    except OSError:
        pass


def _ensure_worker():
    global _worker
    if _worker is None or not _worker.is_alive():
        _worker = threading.Thread(target=_run_worker, name="krc-media-jobs", daemon=True)
        _worker.start()


def _run_worker():
    while True:
        _wake.wait(timeout=30)
        _wake.clear()
        while True:
            with _lock:
                job_id = _queue.pop(0) if _queue else None
                job = _jobs.get(job_id) if job_id else None
                if job:
                    job["status"] = "converting"
            if not job:
                break
            _convert(job)


def _convert(job):
    record, settings = job["record"], job["settings"]
    dest, thumb = None, store.thumb_path(record["id"])

    def progress(value):
        job["progress"] = round(float(value), 3)

    try:
        dest = store.media_path(record)
        info = process(job["source"], dest, thumb,
                       trim_in=settings.get("trimIn") or 0, trim_out=settings.get("trimOut") or 0,
                       fps=settings.get("fps") or 0, max_megapixels=_number(settings.get("maxMegapixels")),
                       max_length=_number(settings.get("maxLength")),
                       audio=settings.get("audio", True),
                       on_progress=progress, is_cancelled=lambda: job["cancel"])
        record.update(info)
        added = store.add(record)
        job["item"] = store.public_item(added)
        job["status"] = "done"
        job["progress"] = 1.0
        print(f"[KRC Media] converted {record['name']} ({info['width']}x{info['height']}, "
              f"{info['duration']}s, {info['fps']} fps{', audio' if info['audio'] else ''})")
        if _on_added:
            _on_added(record["id"], settings)
    except Cancelled:
        job["status"] = "cancelled"
        _remove_outputs(dest, thumb)
    except VideoProcessError as err:
        job["status"], job["error"] = "error", str(err)
        _remove_outputs(dest, thumb)
    except Exception as err:  # noqa: BLE001
        job["status"], job["error"] = "error", f"The conversion failed ({err})."
        print(f"[KRC Media] conversion failed: {err}")
        _remove_outputs(dest, thumb)
    finally:
        _cleanup_source(job)


def _number(value):
    """A setting as a float (0 for anything that isn't a number; the processor checks it's
    one of its choices)."""
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _remove_outputs(*paths):
    for path in paths:
        if path is None:
            continue
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
