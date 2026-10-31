"""Fetch a LoRA's metadata (and preview thumbnail) from Civitai by hash. Shared by the
/civitai route, the batch fill job and Model Library's LoRA read-through."""

from pathlib import Path

from .. import krc_video
from .materialize import enqueue as enqueue_materialize, regenerate as materialize_regenerate
from .library_index import LoraLibraryIndex
from ..krc_video_settings import load_settings
from .stabilize import _stabilize_off_loop


# A Civitai-sourced LoRA whose preview was withheld (mature, public fetch) gets no
# thumbnail, so a gentle FETCH would otherwise re-try it every press. Treat it as
# complete for this long after the last fetch, then allow one retry (in case the
# preview later becomes available or auth is added in the editor).
_PREVIEW_WITHHELD_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000  # 7 days


async def fetch_lora_from_civitai(library_id, *, force=False, mode=None, invalidate_index=True):
    """On-demand public Civitai by-hash fetch for one LoRA. Returns (body, http_status).

    THE one LoRA Civitai fetch: backs the LoRA Loadout route, Model Library's LoRA
    read-through route, and the batch fetch job, so a LoRA fetches identically no
    matter what triggered it (schema §8: LoRA records are owned by LoRA Loadout).

    Consent-guarded inside the client (returns 'disabled' before any socket). Caches
    hits + not_found sentinels (transient errors are not cached, so retry is allowed),
    then merges a hit into the record so trained words / images / name populate.

    `mode` picks the merge: "fill" keeps user-set fields that already have a value;
    "overwrite" replaces every Civitai-derived field. Default: fill for a plain Fetch,
    overwrite for Force Refresh (`force`); the batch passes its own. The response's
    `filled` / `kept` lists drive the client's result message. The thumbnail only ever
    replaces an existing one on `force`.

    invalidate_index=False (the batch job) updates the cached index record in place
    instead of dropping the scan cache — the caller invalidates once when it's done.
    """
    from .civitai_client import fetch_by_hash, fetch_model
    from .civitai_cache import read_cache, write_cache
    from .civitai_map import MERGE_MODES, graft_model_into_version, merge_civitai_into_record

    # Plain Fetch fills (keeps fields the user set); Force Refresh overwrites. The
    # batch passes its mode explicitly.
    if mode is None:
        mode = "overwrite" if force else "fill"
    if mode not in MERGE_MODES:
        return {"ok": False, "status": "invalid", "error": f"Unknown merge mode: {mode}"}, 400
    sha256 = library_id
    if not sha256:
        return {"ok": False, "status": "unavailable", "error": "Needs a stable content hash"}, 400

    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)

    # Point-of-need stabilization: a Civitai by-hash query needs the real content
    # sha. If the id is still path-derived, hash it now — through the shared
    # single-flight registry, so a background warm already running for this file
    # attaches instead of double-hashing — and carry the promotion back in every
    # response below so the client reconciles its ids even on a miss.
    identity = None
    if sha256.startswith("local-"):
        if not record:
            return {"ok": False, "status": "unavailable", "error": "Needs a stable content hash"}, 400
        try:
            promoted, identity = await _stabilize_off_loop(record)
        except OSError:
            identity = None
        if not identity or not identity.get("newId"):
            return {"ok": False, "status": "unavailable", "error": "Could not hash file for a stable id"}, 400
        index.records.pop(identity["oldId"], None)
        index.records[identity["newId"]] = promoted
        sha256 = identity["newId"]
        record = promoted

    # FETCH (non-force) is a gentle fill: if the record is already Civitai-sourced
    # and effectively complete, do nothing — no network, no overwrite. Force Refresh
    # is the deliberate re-pull that overwrites.
    if not force and record is not None:
        from .thumbnails import find_thumbnail
        from .metadata import current_millis
        existing = record.get("sidecar_data") if isinstance(record.get("sidecar_data"), dict) else {}
        if existing.get("metadataSource") == "civitai":
            lib_id = record.get("library_id") or sha256
            complete = find_thumbnail(None, lib_id) is not None
            # A withheld preview will never get a thumbnail on a public fetch, so
            # treat it as complete for a cooldown after the last fetch (then allow a
            # retry, in case it later becomes available).
            if not complete and existing.get("previewWithheld"):
                si = existing.get("sourceImport") if isinstance(existing.get("sourceImport"), dict) else {}
                fetched_at = si.get("fetchedAt") or si.get("importedAt") or 0
                complete = bool(fetched_at) and (current_millis() - fetched_at) < _PREVIEW_WITHHELD_COOLDOWN_MS
            if complete:
                return {"ok": True, "status": "complete", "cached": True, "identity": identity}, 200

    envelope = None if force else read_cache(sha256)
    fetched = False
    if envelope is None or envelope.get("status") not in ("hit", "not_found"):
        result = await fetch_by_hash(sha256)
        status = result.get("status")
        if status == "hit":
            response = result.get("response")
            # The by-hash response is only the model-VERSION; creator, description,
            # tags and license live on the model. Second call fills them in, then we
            # cache the enriched blob so re-reads are complete. Best-effort: a failed
            # model fetch just caches the version (name/words/images still populate).
            model_id = response.get("modelId") if isinstance(response, dict) else None
            if model_id:
                model_result = await fetch_model(model_id)
                if model_result.get("status") == "hit":
                    response = graft_model_into_version(response, model_result.get("response"))
            envelope = write_cache(sha256, "hit", response)
            fetched = True
        elif status == "not_found":
            envelope = write_cache(sha256, "not_found")
            fetched = True
        else:
            # disabled / unavailable / error — nothing cached, retry allowed.
            return {
                "ok": False, "status": status, "cached": False,
                "detail": result.get("detail"), "identity": identity,
            }, 200

    status = envelope.get("status")
    merged = False
    thumbnail = ""
    preview_withheld = False
    report = {"filled": [], "kept": []}
    if status == "hit" and record is not None:
        existing = record.get("sidecar_data") if isinstance(record.get("sidecar_data"), dict) else {}
        lib_id = record.get("library_id") or sha256
        response = envelope.get("response")
        merged_meta = merge_civitai_into_record(record.get("path"), lib_id, existing, response, mode=mode, report=report)
        # Turn the Civitai preview into a KRC thumbnail: a video goes through the
        # bounded transcode pipeline (poster + optional animated, honoring global
        # settings); a static image is downloaded and converted to a webp.
        thumbnail = await _apply_civitai_thumbnail(
            record, lib_id, merged_meta, response, overwrite=force, invalidate_index=invalidate_index,
        )
        if invalidate_index:
            LoraLibraryIndex().refresh_record(lib_id)
        else:
            record["sidecar_data"] = merged_meta
            record["display_name"] = merged_meta.get("name") or record.get("display_name")
            LoraLibraryIndex.note_record_changed()
        merged = True
        preview_withheld = bool(merged_meta.get("previewWithheld"))

    return {
        "ok": True,
        "status": status,
        "cached": not fetched,
        "fetchedAt": envelope.get("fetchedAt"),
        "merged": merged,
        "identity": identity,
        "thumbnail": thumbnail,
        "previewWithheld": preview_withheld,
        "mode": mode,
        "filled": report["filled"],
        "kept": report["kept"],
    }, 200


def _write_thumbnail_sidecar(record, library_id, sidecar):
    from pathlib import Path as _Path
    from .metadata import write_krc_metadata

    filename = _Path(record.get("path") or "").name
    write_krc_metadata(
        {
            "library_id": library_id,
            "relative_path": record.get("relative_path") or sidecar.get("file") or filename,
            "filename": filename,
            "path": record.get("path"),
        },
        sidecar,
    )


def _drop_animated_thumbnail(library_id):
    """Remove a stale animated .webm so find_thumbnail(prefer_animated) doesn't keep
    serving the old animation over a new static thumbnail."""
    from .thumbnails import ANIMATED_THUMBNAIL_EXTENSION, get_krc_thumbnail_path

    webm = get_krc_thumbnail_path(library_id, ANIMATED_THUMBNAIL_EXTENSION)
    try:
        if webm.exists():
            webm.unlink()
    except OSError:
        pass


async def _apply_civitai_thumbnail(record, library_id, sidecar, response, overwrite=True, invalidate_index=True):
    """Download the Civitai preview and produce a KRC thumbnail. Returns an outcome:
    "none" (no preview) · "kept" (a thumbnail exists, not overwritten) ·
    "download_failed" · "image" (static webp written) · "convert_failed" ·
    "video" (poster/animated generation queued or regenerated) · "video_still" (no
    PyAV: a still from Civitai instead — the video's first frame, else the first still
    preview; civitai_still.py) · "video_pending" (video saved, but this server can't make
    a poster and no still was available).

    Video preview → the bounded local-video pipeline: thumbnailSourceType=video + a
    local thumbnailSourcePath, then enqueue() makes the poster (.webp, always — the
    fallback) plus the animated .webm when videoImportMode is 'animated', honoring
    posterFrame + webmCrf. Static image preview → downloaded and converted to a webp
    thumbnail immediately (no transcode). Guarded/offline-safe throughout.

    overwrite=False (a gentle FETCH) skips when a thumbnail already exists, so it never
    replaces a nicer user thumbnail; Force Refresh passes overwrite=True.

    invalidate_index=False (the batch job) builds the video owner record in place
    instead of dropping the scan cache — that would re-walk every LoRA root per item.
    """
    from urllib.parse import urlparse
    from .civitai_client import download_media
    from .civitai_map import civitai_media_dir, first_preview, preview_video_ext
    from .thumbnails import find_thumbnail, save_thumbnail_bytes

    preview = first_preview(response)
    url = preview.get("url") if preview else ""
    if not url:
        return "none"
    if not overwrite and find_thumbnail(None, library_id) is not None:
        return "kept"

    sidecar = dict(sidecar or {})
    video_ext = preview_video_ext(preview)

    if video_ext:
        settings = load_settings()
        # Can this server make anything from the video? (a poster needs PyAV + Pillow;
        # an animated loop needs animated mode + VP9.)
        animated_possible = settings.get("videoImportMode") == "animated" and krc_video.WEBM_SUPPORT
        if not krc_video.POSTER_SUPPORT and not animated_possible:
            # No: take a still from Civitai instead — its first-frame JPEG, else the
            # first still image in the preview list. Final (Force Refresh on a server
            # with PyAV makes the real poster). Neither → save the video, pending.
            from ..library.civitai_still import fetch_video_still

            still = await fetch_video_still(preview, response, library_id)
            if still and save_thumbnail_bytes({"library_id": library_id}, still[0]) is not None:
                if overwrite:
                    _drop_animated_thumbnail(library_id)
                sidecar.update({
                    "thumbnailSourceType": "image",
                    "thumbnailSourcePath": str(still[1]),
                    "thumbnailNeedsPoster": False,
                    "thumbnailRemoved": False,
                })
                _write_thumbnail_sidecar(record, library_id, sidecar)
                return "video_still"

        dest = civitai_media_dir() / f"{library_id}{video_ext}"
        if not await download_media(url, dest):
            return "download_failed"
        sidecar.update({
            "thumbnailSourceType": "video",
            "thumbnailSourcePath": str(dest),
            "thumbnailNeedsPoster": True,
            "thumbnailRemoved": False,
        })
        _write_thumbnail_sidecar(record, library_id, sidecar)
        if invalidate_index:
            # Fresh record so the owner carries the just-written source.
            LoraLibraryIndex().refresh_record(library_id)
            fresh = await LoraLibraryIndex.loaded()
            owner = fresh.get(library_id)
        else:
            # Same owner, built in place: the record + the sidecar just written.
            owner = {**record, "library_id": library_id, "sidecar_data": sidecar}
        if owner:
            if overwrite:
                # Force Refresh: regenerate() rewrites artifacts even when they
                # already exist (enqueue() skips existing ones), so it actually
                # overwrites and drops any stale variant.
                mode = settings.get("videoImportMode", "animated")
                kind = "animated" if mode == "animated" else "poster"
                await materialize_regenerate(
                    owner,
                    kind,
                    frame=settings.get("posterFrame", "first"),
                    crf=settings.get("webmCrf"),
                )
            else:
                enqueue_materialize(owner, settings)
        # No artifact can come out of this server: no poster encoder, and no animated
        # loop either (off, or no VP9). The video stays saved for a later regenerate.
        if not krc_video.POSTER_SUPPORT and not animated_possible:
            return "video_pending"
        return "video"

    # Static image preview → download + convert to webp now.
    img_ext = Path(urlparse(url).path).suffix.lower() or ".jpg"
    dest = civitai_media_dir() / f"{library_id}{img_ext}"
    if not await download_media(url, dest):
        return "download_failed"
    try:
        data = dest.read_bytes()
    except OSError:
        return "download_failed"
    if save_thumbnail_bytes({"library_id": library_id}, data) is None:
        return "convert_failed"
    # A static image replaces any prior animated loop.
    if overwrite:
        _drop_animated_thumbnail(library_id)
    sidecar.update({
        "thumbnailSourceType": "image",
        "thumbnailSourcePath": str(dest),
        "thumbnailNeedsPoster": False,
        "thumbnailRemoved": False,
    })
    _write_thumbnail_sidecar(record, library_id, sidecar)
    return "image"
