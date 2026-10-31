"""
KRC LoRA Loadout — Civitai batch fetch: the server-side job (gameplan §5).

ONE job per server, owned by the event loop (an asyncio task), so it outlives any
browser: close the Portal, switch workflows, reload, or open a second browser — the
page re-attaches through GET …/civitai/batch/status and the websocket events.

The loop walks the planned targets one at a time through the shared LoRA fetch core
(fetch_lora_from_civitai — the same code as the single-LoRA Fetch), in fill mode by
default. Pacing/backoff mirror the KRC Editor's batch: 500ms only after a real network
fetch, a 5s back-off + one retry on HTTP 429, and a hard stop if internet access is
turned off mid-run. The index scan cache is updated in place per item and invalidated
once at the end (a per-item invalidation would re-walk every LoRA root each time).

Events: "krc-civitai-batch" over PromptServer.send_sync, throttled; each carries the
job summary plus DELTAS since the last event (new log lines, id promotions, changed
record ids) so a client can apply them without re-reading the whole job.

Last run: the finished job's summary is written to lora_loadout/civitai_batch_last.json
so the page still shows it after a server restart (the live job itself does not
survive a restart).
"""
import asyncio
import time
from collections import deque
from pathlib import Path

from ..db import library as library_db
from ..krc_paths import get_krc_node_dir
from .civitai_batch import classify, cached_not_found_ids, record_folder, record_size
from .identity import is_local_library_id

EVENT = "krc-civitai-batch"
LAST_RUN_FILENAME = "civitai_batch_last.json"
LAST_RUN_SCHEMA_VERSION = 1

FETCH_GAP_S = 0.5          # after a real (uncached) Civitai fetch only
RATE_BACKOFF_S = 5.0       # Civitai omits Retry-After
EMIT_INTERVAL_S = 0.25     # progress event throttle
LOG_LIMIT = 500            # ring buffer (the page caps its DOM the same)
ISSUE_LIMIT = 500          # errors / warnings kept per run

_KRC_DIR_NAME = "lora_loadout"
# The USER-dir fallback (get_krc_node_dir appends krc_nodes/<node> itself).
_FALLBACK = Path(__file__).resolve().parents[2] / ".krc_user" / "default"

_job = None       # the current/most recent BatchJob (in memory only)
_task = None      # its asyncio task


def _now_ms():
    return int(time.time() * 1000)


def _display_name(record):
    return str(record.get("display_name") or record.get("filename") or record.get("library_id") or "LoRA")


class BatchJob:
    def __init__(self, targets, *, scope_folder, subfolders, overwrite):
        self.id = f"civitai-batch-{_now_ms()}"
        self.targets = targets
        self.scope = {"folder": scope_folder, "subfolders": bool(subfolders)}
        self.overwrite = bool(overwrite)
        self.state = "running"          # running | cancelling | done | cancelled | stopped | failed
        self.total = len(targets)
        self.done = 0
        self.counts = {"fetched": 0, "notFound": 0, "thumbPending": 0, "skipped": 0, "failed": 0}
        self.current = None
        self.started_at = _now_ms()
        self.finished_at = 0
        self.note = ""
        self.log = deque(maxlen=LOG_LIMIT)
        self.errors = []
        self.warnings = []
        self.outcomes = []
        self.identities = []
        self._seq = 0
        # Deltas since the last emitted event.
        self._pending_log = []
        self._pending_identities = []
        self._pending_records = []
        self._last_emit = float("-inf")  # never: monotonic() can start near 0

    # ── state ───────────────────────────────────────────────────────────────
    @property
    def active(self):
        return self.state in ("running", "cancelling")

    def request_cancel(self):
        if self.state == "running":
            self.state = "cancelling"

    def add_log(self, kind, sym, name, text="", count_key=None):
        if count_key:
            self.counts[count_key] = self.counts.get(count_key, 0) + 1
            self.done += 1
        self._seq += 1
        entry = {"seq": self._seq, "i": self.done if count_key else 0, "kind": kind, "sym": sym, "name": name, "text": text}
        self.log.append(entry)
        self._pending_log.append(entry)
        return entry

    def add_issue(self, bucket, library_id, name, text):
        target = self.errors if bucket == "error" else self.warnings
        if len(target) < ISSUE_LIMIT:
            target.append({"id": library_id, "name": name, "text": text})

    # ── serialization ────────────────────────────────────────────────────────
    def summary(self):
        elapsed = (self.finished_at or _now_ms()) - self.started_at
        eta = 0
        if self.active and self.done:
            eta = int(elapsed / self.done * (self.total - self.done))
        return {
            "id": self.id,
            "state": self.state,
            "active": self.active,
            "scope": self.scope,
            "overwrite": self.overwrite,
            "total": self.total,
            "done": self.done,
            "counts": dict(self.counts),
            "current": self.current,
            "startedAt": self.started_at,
            "finishedAt": self.finished_at,
            "elapsedMs": elapsed,
            "etaMs": eta,
            "note": self.note,
            "cancel": self.state == "cancelling",
            "errorCount": len(self.errors),
            "warningCount": len(self.warnings),
        }

    def snapshot(self):
        """Full state for a page that (re)attaches: summary + the log ring + issues."""
        return {**self.summary(), "log": list(self.log), "errors": list(self.errors), "warnings": list(self.warnings),
                "outcomes": list(self.outcomes), "identities": list(self.identities)}

    def last_run_record(self):
        return {
            "schemaVersion": LAST_RUN_SCHEMA_VERSION,
            **{key: value for key, value in self.summary().items() if key not in ("current", "etaMs", "active", "cancel")},
            "errors": list(self.errors),
            "warnings": list(self.warnings),
        }

    def take_event(self, kind="progress"):
        event = {
            "type": kind,
            "job": self.summary(),
            "log": self._pending_log,
            "identities": self._pending_identities,
            "records": self._pending_records,
        }
        self._pending_log, self._pending_identities, self._pending_records = [], [], []
        return event


# ── events + persistence ──────────────────────────────────────────────────────

def _send(event):
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(EVENT, event)
    except Exception:  # noqa: BLE001 — no server (tests) or a send hiccup never stops the job
        pass


def _emit(job, *, force=False, kind="progress", send=_send):
    now = time.monotonic()
    if not force and now - job._last_emit < EMIT_INTERVAL_S:
        return
    job._last_emit = now
    send(job.take_event(kind))


LAST_RUN_KEY = "civitai_batch.last_run"  # krc.db settings key (KRC_SQLITE_GAMEPLAN.md stage 3)


def legacy_last_run_path():
    """The pre-database last-run file, read once by the stage-3 import."""
    return get_krc_node_dir(_KRC_DIR_NAME, fallback=_FALLBACK) / LAST_RUN_FILENAME


def write_last_run(job):
    _write_last_run_record(job.last_run_record())


def _write_last_run_record(record):
    try:
        library_db.document_put(LAST_RUN_KEY, record)
    except Exception:  # noqa: BLE001 - the summary is best-effort
        pass


def read_last_run():
    try:
        data = library_db.document_get(LAST_RUN_KEY)
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


# ── the loop ───────────────────────────────────────────────────────────────────

async def _default_fetch(library_id, *, mode):
    from .civitai_fetch import fetch_lora_from_civitai
    return await fetch_lora_from_civitai(library_id, force=False, mode=mode, invalidate_index=False)


def _default_refresh(library_id, fallback):
    """The record as it is NOW (the user may have edited/fetched it since planning)."""
    from .library_index import LoraLibraryIndex
    return LoraLibraryIndex().get(library_id) or fallback


def _default_finish():
    from .library_index import LoraLibraryIndex
    LoraLibraryIndex._cache = {}


async def run_job(job, *, fetch=_default_fetch, refresh=_default_refresh, not_found=cached_not_found_ids,
                  sleep=asyncio.sleep, send=_send, finish=_default_finish, persist=write_last_run,
                  size_of=record_size):
    """Walk job.targets. Every collaborator is injectable so the loop tests off the runtime."""
    mode = "overwrite" if job.overwrite else "fill"
    _emit(job, force=True, kind="state", send=send)
    try:
        for planned in job.targets:
            if job.state == "cancelling":
                break
            await sleep(0)  # yield even when items resolve from cache
            if job.state == "cancelling":
                break
            library_id = str(planned.get("library_id") or "")
            record = refresh(library_id, planned)
            name = _display_name(record)

            # Re-check: planning happened earlier; honor what the user did since.
            stable_id = library_id.lower()
            candidates = [stable_id] if stable_id and not is_local_library_id(stable_id) else []
            verdict, reason = classify(record, not_found_ids=not_found(candidates))
            if verdict == "skip":
                job.outcomes.append({"id": library_id, "finalId": library_id, "status": "skipped"})
                job.add_log("cached", "↷", name, f"skipped — {reason.replace('_', ' ')}", "skipped")
                _emit(job, send=send)
                continue

            if is_local_library_id(library_id):
                size = size_of(record)
                job.current = {"id": library_id, "name": name, "phase": "Hashing",
                               "detail": f"{size / 1e6:.0f} MB" if size else "", "folder": record_folder(record)}
            else:
                job.current = {"id": library_id, "name": name, "phase": "Fetching", "detail": "", "folder": record_folder(record)}
            _emit(job, force=True, send=send)

            body, _status = await fetch(library_id, mode=mode)
            if isinstance(body, dict) and body.get("status") == "error" and "429" in str(body.get("detail") or ""):
                job.current = {**(job.current or {}), "phase": "Rate limited", "detail": "retrying in 5s"}
                _emit(job, force=True, send=send)
                await sleep(RATE_BACKOFF_S)
                body, _status = await fetch(library_id, mode=mode)
            body = body if isinstance(body, dict) else {}

            identity = body.get("identity") or None
            final_id = library_id
            if identity and identity.get("newId"):
                final_id = identity["newId"]
                job._pending_identities.append(identity)
                job.identities.append(identity)

            status = body.get("status")
            if status == "disabled":
                job.note = "Internet access was turned off — stopped."
                job.state = "stopped"
                job.add_log("fail", "■", name, "internet access is off")
                break
            if status == "hit":
                thumb = body.get("thumbnail") or ""
                if body.get("merged"):
                    job._pending_records.append(final_id)
                if thumb == "video_pending":
                    job.add_log("warn", "◐", name, "fetched · video preview, thumbnail pending (no ffmpeg)", "thumbPending")
                    job.add_issue("warning", final_id, name, "video preview saved — thumbnail pending (no ffmpeg)")
                else:
                    text = "fetched" + (" (cached)" if body.get("cached") else "")
                    if thumb == "video_still":
                        text += " · still from Civitai (no ffmpeg)"
                    job.add_log("ok", "✓", name, text, "fetched")
                    if body.get("previewWithheld"):
                        job.add_issue("warning", final_id, name, "preview withheld on public fetch")
                    elif thumb in ("download_failed", "convert_failed"):
                        job.add_issue("warning", final_id, name, "metadata fetched, thumbnail failed")
            elif status == "not_found":
                job.add_log("warn", "∅", name, "no Civitai match", "notFound")
                job.add_issue("warning", final_id, name, "no Civitai match")
            elif status == "complete":
                job.add_log("cached", "↺", name, "already complete", "skipped")
            else:
                detail = body.get("detail") or body.get("error") or status or "failed"
                job.add_log("fail", "✗", name, f"failed: {detail}", "failed")
                job.add_issue("error", final_id, name, str(detail))

            outcome = {"hit": "succeeded", "not_found": "notFound", "complete": "skipped"}.get(status, "failed")
            job.outcomes.append({"id": library_id, "finalId": final_id, "status": outcome})
            job.current = None
            _emit(job, send=send)
            if status in ("hit", "not_found") and body.get("cached") is False:
                await sleep(FETCH_GAP_S)
    except Exception as err:  # noqa: BLE001 — a crash must still finish the job cleanly
        job.state = "failed"
        job.note = f"Stopped by an internal error: {err}"
    finally:
        if job.state == "cancelling":
            job.state = "cancelled"
            job.add_log("dim", "■", "Cancelled — stopped after the current item.")
        elif job.state == "running":
            job.state = "done"
            job.add_log("dim", "■", "Done.")
        job.current = None
        job.finished_at = _now_ms()
        finish()
        persist(job)
        _emit(job, force=True, kind="state", send=send)


# ── public API (routes) ───────────────────────────────────────────────────────────


def status_payload():
    return {"job": _job.snapshot() if _job else None, "lastRun": read_last_run()}


async def start_job(scope_folder=None, *, subfolders=False, overwrite=False, selected_ids=None):
    """(body, http_status). Plans off the event loop, then launches the task."""
    global _job, _task
    from ..krc_network import network_enabled
    from .civitai_batch import collect_targets

    if _job and _job.active:
        return {"ok": False, "error": "A Civitai batch fetch is already running.", "job": _job.summary()}, 409
    if not network_enabled():
        return {"ok": False, "status": "disabled", "error": "Internet access is off."}, 400

    loop = asyncio.get_event_loop()
    try:
        _records, plan = await loop.run_in_executor(
            None, lambda: collect_targets(scope_folder, subfolders=subfolders, **({"selected_ids": selected_ids} if selected_ids is not None else {}))
        )
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}, 400
    if _job and _job.active:  # another start won the race while we planned
        return {"ok": False, "error": "A Civitai batch fetch is already running.", "job": _job.summary()}, 409
    if not plan["targets"]:
        return {"ok": False, "status": "empty", "error": "No LoRAs to fetch in this scope."}, 400

    _job = BatchJob(plan["targets"], scope_folder=scope_folder, subfolders=subfolders, overwrite=overwrite)
    _task = asyncio.ensure_future(run_job(_job))
    return {"ok": True, "job": _job.snapshot()}, 200


def current_job():
    """The live object, for selected-ID job adapters to retain their own run handle."""
    return _job


def clear_issues(*, read=read_last_run, write=_write_last_run_record, send=_send):
    """Empty the finished run's Errors & Warnings lists (live job + persisted last run).
    Counts and the log stay. Loses nothing: errors are never cached (they retry next
    run) and a no-match lives on in the Civitai cache, which drives the
    civitai:none search and the batch skip."""
    if _job and _job.active:
        return {"ok": False, "error": "Wait for the running fetch to finish."}, 409
    if _job:
        _job.errors.clear()
        _job.warnings.clear()
    last = read()
    if isinstance(last, dict):
        last.update({"errors": [], "warnings": [], "errorCount": 0, "warningCount": 0})
        write(last)
    send({"type": "issues-cleared", "job": _job.summary() if _job else None})
    return {"ok": True}, 200


def cancel_job():
    if not _job or not _job.active:
        return {"ok": False, "error": "No Civitai batch fetch is running."}, 409
    _job.request_cancel()
    _emit(_job, force=True, kind="state")
    return {"ok": True, "job": _job.summary()}, 200
