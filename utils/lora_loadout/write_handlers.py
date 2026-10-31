"""LoRA metadata and thumbnail write handlers, module-level so the LoRA Loadout routes AND
Model Library's LoRA read-through share them (LoRA metadata is owned by LoRA Loadout).
Each metadata handler returns (body, http_status)."""

from pathlib import Path

from aiohttp import web

from .. import krc_video
from ..upload_limits import VIDEO_UPLOAD_MAX, UploadTooLarge, save_upload
from ..custom_badge import normalize_custom_badge
from .materialize import regenerate as materialize_regenerate
from .identity_records import blank_record_metadata
from .library_index import LoraLibraryIndex
from ..library.nsfw import nsfw_rating
from ..library.pins import pin_limit_problem
from ..library.thumbnails import thumbnail_version
from .metadata import PLAIN_METADATA_KEYS, as_int, coerce_verification, write_krc_metadata
from ..krc_video_settings import load_settings
from .thumbnails import (
    ANIMATED_THUMBNAIL_EXTENSION,
    THUMBNAIL_EXTENSION,
    delete_thumbnails,
    get_krc_thumbnail_path,
    find_thumbnail_paths,
    save_thumbnail_image,
    save_thumbnail_bytes,
)
from .stabilize import _stabilize_off_loop


def _thumbnail_source_name(sidecar):
    source_import = sidecar.get("sourceImport") if isinstance(sidecar.get("sourceImport"), dict) else {}
    return source_import.get("type") or sidecar.get("metadataSource") or ""


def _thumbnail_refresh_failure(sidecar, reason):
    return {
        "ok": False,
        "kind": "",
        "reason": reason,
        "source": _thumbnail_source_name(sidecar),
        "sourceType": sidecar.get("thumbnailSourceType") or "",
    }


async def _refresh_thumbnail_from_recorded_source(owner):
    if not owner:
        return _thumbnail_refresh_failure({}, "no_source")
    sidecar = dict(owner.get("sidecar_data") or {})
    source_type = sidecar.get("thumbnailSourceType") or ""
    source_path = sidecar.get("thumbnailSourcePath") or ""
    if not source_type:
        return _thumbnail_refresh_failure(sidecar, "no_source")
    if not source_path or not Path(source_path).exists():
        return _thumbnail_refresh_failure(sidecar, "no_source")

    if source_type == "image":
        try:
            from PIL import Image
        except ImportError:
            return _thumbnail_refresh_failure(sidecar, "pillow_unavailable")
        try:
            with Image.open(source_path) as image:
                save_thumbnail_image(owner, image)
        except Exception:
            return _thumbnail_refresh_failure(sidecar, "convert_failed")
        sidecar["thumbnailRemoved"] = False
        sidecar["thumbnailNeedsPoster"] = False
        sidecar["thumbnailPosterExtracted"] = False
        write_krc_metadata(owner, sidecar)
        if isinstance(owner.get("sidecar_data"), dict):
            owner["sidecar_data"].update({
                "thumbnailRemoved": False,
                "thumbnailNeedsPoster": False,
                "thumbnailPosterExtracted": False,
            })
        return {
            "ok": True,
            "kind": "poster",
            "reason": "",
            "source": _thumbnail_source_name(sidecar),
            "sourceType": source_type,
        }

    if source_type != "video":
        return _thumbnail_refresh_failure(sidecar, "unsupported_source")

    settings = load_settings()
    frame = settings.get("posterFrame", "first")
    crf = settings.get("webmCrf")
    kind = "animated" if settings.get("videoImportMode") == "animated" and krc_video.WEBM_SUPPORT else "poster"
    thumbnail = await materialize_regenerate(owner, kind, frame=frame, crf=crf)
    if kind == "animated" and not thumbnail.get("ok") and krc_video.POSTER_SUPPORT:
        thumbnail = await materialize_regenerate(owner, "poster", frame=frame, crf=crf)
    thumbnail["source"] = _thumbnail_source_name(sidecar)
    thumbnail["sourceType"] = source_type
    thumbnail["frame"] = frame
    return thumbnail


# ── Shared LoRA metadata write handlers ──────────────────────────────────────
# Extracted from the /metadata and /metadata/blank route bodies so the
# same logic backs both the LoRA Loadout routes AND Model Library's LoRA read-through
# write-back (schema S8: LoRA metadata is owned by LoRA Loadout; Model Library delegates
# here rather than writing a competing record). Each returns (body, http_status).

async def save_lora_metadata(payload):
    library_id = payload.get("sha256")
    index = await LoraLibraryIndex.loaded()
    record = index.get(library_id)
    if not record:
        return {"error": "Unknown LoRA SHA256"}, 404
    if payload.get("pinned") is True:
        problem = pin_limit_problem([record.get("library_id")])
        if problem:
            return {"error": problem}, 409

    promote = payload.get("stabilizeIdentity") is True
    promotion = None
    if promote:
        record, promotion = await _stabilize_off_loop(record)
        if promotion:
            index.records.pop(promotion["oldId"], None)
            index.records[promotion["newId"]] = record
            library_id = promotion["newId"]

    return save_lora_metadata_record(record, payload, promotion)


def save_lora_metadata_record(record, payload, promotion=None):
    """Write an already-resolved record; shared by individual and atomic batch edits."""
    sidecar = dict(record.get("sidecar_data") or {})
    # Per-file identity edits (name, verification) land on the member sidecar — verification is
    # about THIS file's hash.
    if "name" in payload:
        sidecar["name"] = payload["name"]
    if "verification" in payload:
        sidecar["verification"] = coerce_verification(payload["verification"])
    if "customBadge" in payload:
        payload = dict(payload)
        custom_badge = normalize_custom_badge(payload.get("customBadge", ""))
        if custom_badge is None:
            return {"error": "Custom badge must use letters, numbers, and spaces only (10 max)"}, 400
        payload["customBadge"] = custom_badge
    if "rating" in payload:
        payload = dict(payload)
        payload["rating"] = as_int(payload.get("rating"), 0)

    for key in PLAIN_METADATA_KEYS:
        if key in payload:
            sidecar[key] = payload[key]
    _apply_inherited_metadata_edits(sidecar, payload)

    if record.get("sha256"):
        sidecar["sha256"] = record["sha256"]
    else:
        sidecar.pop("sha256", None)
    previous_source = sidecar.get("metadataSource")
    source_import = sidecar.get("sourceImport") if isinstance(sidecar.get("sourceImport"), dict) else {}
    sidecar["metadataSource"] = "krc"
    if previous_source == "default" or not source_import.get("type"):
        sidecar["sourceImport"] = {"type": "krc_manual"}
    write_krc_metadata(record, sidecar)

    # Update the cached record in place rather than nuking the whole cache — clearing it
    # forced a full filesystem rescan on the next request.
    record["sidecar_data"] = sidecar
    record["display_name"] = sidecar.get("name") or record.get("display_name") or record.get("filename")
    LoraLibraryIndex.note_record_changed()
    return {"ok": True, "identity": promotion}, 200


async def blank_lora_metadata(sha256):
    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)
    if not record:
        return {"error": "Unknown LoRA SHA256"}, 404

    result = blank_record_metadata(record)
    LoraLibraryIndex().refresh_record(record.get("library_id") or sha256)
    return {"ok": True, "identity": result}, 200


# Thumbnail write handlers, module-level so Model Library's thumbnail routes can hand a
# LoRA read-through id to them (the same request shape: multipart image / video).
async def lora_thumbnail_upload(request, sha256):
    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)
    if not record:
        return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)

    reader = await request.multipart()
    field = await reader.next()
    if field is None:
        return web.json_response({"error": "Missing image file"}, status=400)

    data = await field.read(decode=False)
    path = save_thumbnail_bytes(record, data)
    if path is None:
        return web.json_response({"error": "Could not process thumbnail image"}, status=400)

    sidecar = dict(record.get("sidecar_data") or {})
    sidecar["thumbnailRemoved"] = False
    # A real thumbnail now exists, so this is no longer a poster-needed
    # video placeholder.
    sidecar["thumbnailNeedsPoster"] = False
    write_krc_metadata(record, sidecar)
    LoraLibraryIndex().refresh_record(record["library_id"])
    return web.json_response({
        "ok": True,
        "thumbnail": str(path),
        "thumbnailVersion": thumbnail_version(*find_thumbnail_paths(record["library_id"])),
    })


async def lora_thumbnail_upload_video(request, sha256):
    # Direct mp4/webm upload -> the KRC constrained thumbnail set (webp poster +
    # VP9 webm loop). The upload is transient: transcode, then discard it (no
    # original is stored). Uploading a video is an explicit "I want animation"
    # act, so we always request the loop and degrade to poster-only if the server
    # has no VP9 encoder.
    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)
    if not record:
        return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)
    if not krc_video.FFMPEG_SUPPORT:
        return web.json_response(
            {"error": krc_video.NOT_FOUND_MESSAGE}, status=503)

    try:
        # A fixed suffix: the container is read from the file's bytes, never its name.
        tmp_path = await save_upload(request, VIDEO_UPLOAD_MAX)
    except UploadTooLarge as err:
        return web.json_response({"error": str(err)}, status=413)
    if tmp_path is None:
        return web.json_response({"error": "Missing video file"}, status=400)

    try:
        if not tmp_path.stat().st_size:
            return web.json_response({"error": "Empty upload"}, status=400)
        if not krc_video.sniff_container(tmp_path):
            return web.json_response({"error": krc_video.UNSUPPORTED_VIDEO_MESSAGE}, status=400)

        settings = load_settings()
        owner_id = record["library_id"]
        delete_thumbnails(record)  # clear any prior image/loop for a clean replace
        result = krc_video.transcode_upload(
            tmp_path,
            get_krc_thumbnail_path(owner_id, THUMBNAIL_EXTENSION),
            get_krc_thumbnail_path(owner_id, ANIMATED_THUMBNAIL_EXTENSION),
            want_animated=True,
            frame=settings.get("posterFrame", "first"),
            crf=settings.get("webmCrf"),
        )
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass

    if not result["poster"] and not result["animated"]:
        return web.json_response(
            {"error": "Could not read that video file."}, status=400)

    sidecar = dict(record.get("sidecar_data") or {})
    sidecar["thumbnailRemoved"] = False
    sidecar["thumbnailNeedsPoster"] = False
    sidecar["thumbnailPosterExtracted"] = True
    # Mark it a video thumbnail (drives the info-panel player), but drop any
    # re-pull source — the upload was transient, there is nothing to regenerate
    # from, so enqueue()/regenerate() correctly no-op.
    sidecar["thumbnailSourceType"] = "video"
    sidecar["thumbnailSourcePath"] = ""
    write_krc_metadata(record, sidecar)
    LoraLibraryIndex().refresh_record(record["library_id"])
    return web.json_response({
        "ok": True,
        "hasPoster": bool(result["poster"]),
        "hasAnimation": bool(result["animated"]),
        "reason": result["reason"],
        "thumbnailVersion": thumbnail_version(*find_thumbnail_paths(record["library_id"])),
    })


async def lora_thumbnail_delete(request, sha256):
    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)
    if not record:
        return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)

    delete_thumbnails(record)
    sidecar = dict(record.get("sidecar_data") or {})
    sidecar["thumbnailRemoved"] = True
    sidecar["thumbnailNeedsPoster"] = False
    write_krc_metadata(record, sidecar)
    LoraLibraryIndex().refresh_record(record["library_id"])
    return web.json_response({"ok": True})


async def lora_thumbnail_refresh_source(request, sha256):
    # Source-aware thumbnail refresh for the UI: re-makes the thumbnail from the
    # recorded local source (a downloaded Civitai preview); other sources can
    # branch here without changing the modal contract.
    index = await LoraLibraryIndex.loaded()
    record = index.get(sha256)
    if not record:
        return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)
    result = await _refresh_thumbnail_from_recorded_source(record)
    if result.get("ok"):
        LoraLibraryIndex().refresh_record(record["library_id"])
        status = 200
    else:
        status = 400
    return web.json_response(result, status=status)


def _apply_inherited_metadata_edits(target_sidecar, payload):
    """Apply metadata edits that don't map to a flat sidecar key.

    `creator` is a dict whose only user-editable subfield is `username`; merge it
    so other subfields (id, image, links) survive. `nsfwLevel` is the shared NSFW
    rating (utils/library/nsfw.py), stored as the highest content flag.
    `usage.license` is a free-text license note merged into the usage dict so the
    scraped usage flags survive. All are model-level ("shared") edits, so callers
    apply them to whichever sidecar owns the shared metadata (local when
    standalone, else the source).
    """
    if "creator" in payload:
        incoming = payload["creator"] if isinstance(payload["creator"], dict) else {}
        current = dict(target_sidecar.get("creator")) if isinstance(target_sidecar.get("creator"), dict) else {}
        if "username" in incoming:
            current["username"] = str(incoming.get("username") or "")
        target_sidecar["creator"] = current
    if "nsfwLevel" in payload:
        target_sidecar["nsfwLevel"] = nsfw_rating(payload["nsfwLevel"])
    if "usage" in payload:
        incoming = payload["usage"] if isinstance(payload["usage"], dict) else {}
        current = dict(target_sidecar.get("usage")) if isinstance(target_sidecar.get("usage"), dict) else {}
        if "license" in incoming:
            current["license"] = str(incoming.get("license") or "")
        target_sidecar["usage"] = current
