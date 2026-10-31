"""
Deferred, bounded thumbnail materialization for video-source LoRAs.

The rule the whole feature is built around: importing a large library must NEVER
trigger a transcode spike. So:
  - Import only registers a pointer (thumbnailSourcePath + thumbnailNeedsPoster);
    it never transcodes (see civitai_fetch.py, the Civitai video preview).
  - Generation happens here, LAZILY — the serve layer (routes get_missing_thumbnail)
    calls enqueue() only for cards the browser is actually rendering, so work is
    naturally viewport-bounded.
  - A ThreadPoolExecutor with MAX_WORKERS keeps at most that many ffmpeg processes
    alive at once; extra requests queue. An inflight set dedupes, and MAX_PENDING
    caps the backlog so a fast scroll can't spawn unbounded work (dropped requests
    simply retry on the next scroll/refresh).

enqueue() is fire-and-forget: it schedules the work and returns immediately, so the
HTTP handler responds without waiting for a 5–30s transcode.
"""
import asyncio
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from .. import krc_video as kv
from .metadata import write_krc_metadata
from .thumbnails import (
    ANIMATED_THUMBNAIL_EXTENSION,
    THUMBNAIL_EXTENSION,
    find_thumbnail_variant,
    get_krc_thumbnail_path,
)

MAX_WORKERS = 2
MAX_PENDING = 64

_executor = ThreadPoolExecutor(max_workers=MAX_WORKERS, thread_name_prefix="krc-video")
_inflight = set()  # keys: (owner_id, "poster" | "animated")


def _now_ms():
    return int(time.time() * 1000)


def _has_variant(owner_id, variant):
    return find_thumbnail_variant(owner_id, variant) is not None


def _source_video_path(sidecar):
    """The local video sidecar to transcode, or None (removed / not a local video)."""
    if not isinstance(sidecar, dict) or sidecar.get("thumbnailRemoved"):
        return None
    if sidecar.get("thumbnailSourceType") != "video":
        return None
    source_path = sidecar.get("thumbnailSourcePath") or ""
    if source_path and Path(source_path).exists():
        return source_path
    return None


def _do_transcode(source_path, owner_id, kind, frame, crf):
    """Blocking — runs in the executor thread. Writes into the owner's thumbnail
    path so the serve layer finds it under the same id."""
    if kind == "poster":
        out = get_krc_thumbnail_path(owner_id, THUMBNAIL_EXTENSION)
        return kv.video_to_webp(source_path, out, frame=frame)
    if kind == "animated":
        out = get_krc_thumbnail_path(owner_id, ANIMATED_THUMBNAIL_EXTENSION)
        return kv.video_to_webm(source_path, out, crf=crf)
    return False


async def _run(owner_record, source_path, kind, frame, crf, key):
    try:
        owner_id = owner_record["library_id"]
        loop = asyncio.get_event_loop()
        ok = await loop.run_in_executor(
            _executor, _do_transcode, source_path, owner_id, kind, frame, crf
        )
        if ok and kind == "poster":
            # Persist the state-machine flags. The Has-flags stay derived from file
            # presence (routes _serialize_lora), so nothing else needs writing.
            sidecar = dict(owner_record.get("sidecar_data") or {})
            sidecar["thumbnailNeedsPoster"] = False
            sidecar["thumbnailPosterExtracted"] = True
            sidecar["thumbnailPosterExtractedAt"] = _now_ms()
            write_krc_metadata(owner_record, sidecar)
            # Keep the in-memory record fresh so a re-request doesn't re-enqueue.
            if isinstance(owner_record.get("sidecar_data"), dict):
                owner_record["sidecar_data"].update({
                    "thumbnailNeedsPoster": False,
                    "thumbnailPosterExtracted": True,
                })
    finally:
        _inflight.discard(key)


def _schedule(owner_record, source_path, kind, frame, crf):
    """Add one bounded, deduped materialization task. Returns True if scheduled."""
    key = (owner_record["library_id"], kind)
    if key in _inflight or len(_inflight) >= MAX_PENDING:
        return False
    _inflight.add(key)
    asyncio.create_task(_run(owner_record, source_path, kind, frame, crf, key))
    return True


def enqueue(owner_record, settings):
    """Schedule any MISSING thumbnail artifacts for a video-source LoRA per the
    import mode, without blocking. Returns the number of tasks scheduled. Safe to
    call repeatedly — dedupes and skips artifacts that already exist. (This is the
    lazy/automatic path; for a forced explicit re-pull use regenerate().)"""
    if not owner_record:
        return 0
    sidecar = owner_record.get("sidecar_data") or {}
    source_path = _source_video_path(sidecar)
    if not source_path:
        return 0

    owner_id = owner_record["library_id"]
    mode = settings.get("videoImportMode", "animated")
    frame = settings.get("posterFrame", "first")
    crf = settings.get("webmCrf")

    wanted = []
    if kv.POSTER_SUPPORT and not _has_variant(owner_id, "poster"):
        wanted.append(("poster", frame, None))
    if mode == "animated" and kv.WEBM_SUPPORT and not _has_variant(owner_id, "animated"):
        wanted.append(("animated", frame, crf))

    scheduled = 0
    for kind, kframe, kcrf in wanted:
        if _schedule(owner_record, source_path, kind, kframe, kcrf):
            scheduled += 1
    return scheduled


# --- Explicit re-pull (forced, single item, with representation transitions) ---
def _regen_poster(source_path, owner_id, frame):
    """Blocking. Write a static webp poster; a still replaces any animated loop, so
    DROP the webm (nothing keeps playing a stale loop over the new poster)."""
    out = get_krc_thumbnail_path(owner_id, THUMBNAIL_EXTENSION)
    if not kv.video_to_webp(source_path, out, frame=frame):
        return False
    webm = get_krc_thumbnail_path(owner_id, ANIMATED_THUMBNAIL_EXTENSION)
    try:
        if webm.exists():
            webm.unlink()
    except OSError:
        pass
    return True


def _regen_animated(source_path, owner_id, frame, crf):
    """Blocking. Write the animated webm plus a static webp poster fallback so an
    animated thumbnail always has a still to fall back to."""
    webm_out = get_krc_thumbnail_path(owner_id, ANIMATED_THUMBNAIL_EXTENSION)
    poster_out = get_krc_thumbnail_path(owner_id, THUMBNAIL_EXTENSION)
    ok_webm = kv.video_to_webm(source_path, webm_out, crf=crf)
    kv.video_to_webp(source_path, poster_out, frame=frame)  # best-effort fallback
    return ok_webm


def _persist_after_regen(owner_record):
    """Clear the poster-needed state after a successful re-pull. sourceType stays
    'video' (untouched) so the 'generate animated' option remains available."""
    sidecar = dict(owner_record.get("sidecar_data") or {})
    sidecar["thumbnailRemoved"] = False
    sidecar["thumbnailNeedsPoster"] = False
    sidecar["thumbnailPosterExtracted"] = True
    sidecar["thumbnailPosterExtractedAt"] = _now_ms()
    write_krc_metadata(owner_record, sidecar)
    if isinstance(owner_record.get("sidecar_data"), dict):
        owner_record["sidecar_data"].update({
            "thumbnailRemoved": False,
            "thumbnailNeedsPoster": False,
            "thumbnailPosterExtracted": True,
        })


async def regenerate(owner_record, kind, frame=None, crf=None):
    """Forced, explicit re-pull of one LoRA's thumbnail from its video source, run
    off the event loop. `kind`: 'poster' (static) | 'animated' (webm + poster
    fallback). Returns {ok, kind, reason}. Unlike enqueue() this regenerates even
    when an artifact already exists."""
    if not owner_record:
        return {"ok": False, "kind": kind, "reason": "no_source"}
    sidecar = owner_record.get("sidecar_data") or {}
    source_path = _source_video_path(sidecar)
    if not source_path:
        reason = "not_video" if sidecar.get("thumbnailSourceType") != "video" else "no_source"
        return {"ok": False, "kind": kind, "reason": reason}

    owner_id = owner_record["library_id"]
    frame = frame or "first"
    loop = asyncio.get_event_loop()

    if kind == "animated":
        if not kv.WEBM_SUPPORT:
            return {"ok": False, "kind": kind,
                    "reason": "webm_unavailable" if kv.FFMPEG_SUPPORT else "no_ffmpeg"}
        ok = await loop.run_in_executor(_executor, _regen_animated, source_path, owner_id, frame, crf)
    else:
        kind = "poster"
        if not kv.POSTER_SUPPORT:
            return {"ok": False, "kind": kind,
                    "reason": "no_webp_encoder" if kv.FFMPEG_SUPPORT else "no_ffmpeg"}
        ok = await loop.run_in_executor(_executor, _regen_poster, source_path, owner_id, frame)

    if ok:
        _persist_after_regen(owner_record)
    return {"ok": ok, "kind": kind, "reason": "" if ok else "convert_failed"}
