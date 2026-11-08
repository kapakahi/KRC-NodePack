"""KRC Model Library API routes (/krc/model-library).

Registers the route namespace and the read/write surface backed by the Stage 1 generic
model record (utils/model_library/metadata.py), the generalized multi-root scanner,
thumbnail management, manual stabilization, and Model-Library-exclusive bundles.

Kept separate from LoRA Loadout routes so LL stays untouched. Live metadata is served
no-cache: two clients on one ComfyUI instance share this data and a stale cached read
would desync a client's dirty-state baseline (same rule as LoRA Loadout).
"""

import asyncio
import json
from pathlib import Path

from aiohttp import web

from ..card_sync import notify_card_write

try:
    from server import PromptServer
except ImportError:
    PromptServer = None

from ..upload_limits import VIDEO_UPLOAD_MAX, UploadTooLarge, save_upload
from ..custom_badge import normalize_custom_badge
from .bulk_attributes import update_model_attributes
from . import selection_jobs
from ..lora_loadout.library_index import LoraLibraryIndex
from ..lora_loadout.thumbnails import find_thumbnail_variant as find_lora_thumbnail_variant
from .stabilize import stabilize_model_by_id, stabilize_model_off_loop
from ..library.nsfw import nsfw_rating
from ..library.pins import pin_limit_problem
from .library_index import ModelLibraryIndex
from ..library.response_work import prepare_library_response
from ..library.thumbnail_sizes import parse_width, thumbnail_to_serve
from ..library.thumbnails import thumbnail_cache_headers, thumbnail_version
from .folders import ModelLibraryFolderStore
from ..bundle.sections import register_section
from .zip import bundle_sections
from .thumbnails import (
    delete_model_thumbnail,
    find_model_thumbnail_paths,
    find_model_thumbnail_variant,
    save_model_thumbnail_bytes,
    transcode_model_video,
)
from .. import krc_video
from ..krc_video_settings import load_settings
from .civitai_map import apply_civitai_model_thumbnail, merge_civitai_into_model_record
from .hf_map import merge_hf_into_model_record, parse_hf_repo
from .metadata import (
    KRC_MODEL_METADATA_EXPORT_VERSION,
    KRC_MODEL_METADATA_IMPORT_VERSION,
    KRC_MODEL_METADATA_SCHEMA_VERSION,
    KRC_MODEL_METADATA_VERSION,
    as_int,
    is_local_library_id,
    normalize_model_metadata,
    read_model_metadata,
    write_model_metadata,
)
from .browser_rows import _lora_folder_name, _lora_folder_store
from .listing import library_rows
from .lora_read_through import _is_lora_read_through, _lora_detail_payload, _lora_index_get


# Only these fields may be written from the InfoPanel edit form. Everything else on a
# record (identity, versions, thumbnail/verification state, timestamps) is owned by the
# scanner/normalizer and must not be clobbered by a form post.
_EDITABLE_STRING_FIELDS = (
    "name",
    "modelType",
    "family",
    "baseModel",
    "architecture",
    "variant",
    "role",
    "parameterCount",
    "quantization",
    "precision",
    "version",
    "releaseDate",
    "baseModelReleaseDate",
    "license",
    "description",
    "notes",
    "cardColor",
    "customBadge",
)
_ROUTES_REGISTERED = False
_NO_CACHE_HEADERS = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
}


# Type folders now show the raw folder name (the model type IS the folder name under
# universal auto-detect) — the folder tree on disk is the single source of truth, so
# there's no curated label map to drift out of sync.


def _json(payload, status=200):
    return web.json_response(payload, status=status, headers=_NO_CACHE_HEADERS)


def _model_type_for_library_id(library_id):
    try:
        record = ModelLibraryIndex().get(library_id)
    except Exception:  # noqa: BLE001
        return None
    return record.get("modelType") if record else None


# ── External metadata fetch (Civitai / HuggingFace) ──────────────────────────
# Mirrors LoRA Loadout exactly: the SAME egress client + hash-keyed cache + graft,
# reused (not forked). A generic model id maps through the Model-Library generic
# mapper; a LoRA read-through id delegates the whole Civitai fetch to LoRA Loadout's
# fetch_lora_from_civitai (HF import delegates the mapper), so a LoRA opened in the Model
# Library node fetches identically to the LoRA Loadout node. Public/no-auth,
# consent-guarded inside the client.


async def _civitai_fetch_impl(library_id, force):
    if not library_id:
        return {"ok": False, "status": "unavailable", "error": "Needs a stable content hash"}, 400

    from ..library.civitai_cache import read_cache, write_cache
    from ..library.civitai_client import fetch_by_hash, fetch_model
    from ..library.civitai_map import graft_model_into_version

    model_record = (await ModelLibraryIndex.loaded()).get(library_id)
    if not model_record:
        # A LoRA read-through: LoRA records are owned by LoRA Loadout (schema §8), so
        # delegate to its one fetch core — stabilization, the gentle "already complete"
        # short-circuit, merge and thumbnail are then identical to the LL node's.
        if _lora_index_get(library_id):
            from ..lora_loadout.civitai_fetch import fetch_lora_from_civitai
            return await fetch_lora_from_civitai(library_id, force=force)
        return {"ok": False, "status": "unavailable", "error": "Unknown model"}, 404

    # Point-of-need stabilization for a generic MODEL id. Hashes through the shared
    # single-flight registry so a background warm attaches instead of double-hashing; the
    # promotion rides every response below so the client reconciles even on a miss.
    identity = None
    if str(library_id).startswith("local-"):
        try:
            _promoted, identity = await stabilize_model_off_loop(model_record)
        except OSError:
            identity = None
        if not identity or not identity.get("newId"):
            return {"ok": False, "status": "unavailable", "error": "Could not hash file for a stable id"}, 400
        ModelLibraryIndex._cache = {}
        library_id = identity["newId"]
        model_record = (await ModelLibraryIndex.loaded()).get(library_id) or _promoted

    # Shared fetch/cache/graft (identical to LoRA Loadout). By-hash returns only the
    # model-VERSION; a second models/{id} call supplies creator/description/tags/license,
    # grafted in so the enriched blob is cached and mapped once.
    envelope = None if force else read_cache(library_id)
    fetched = False
    if envelope is None or envelope.get("status") not in ("hit", "not_found"):
        result = await fetch_by_hash(library_id)
        status = result.get("status")
        if status == "hit":
            response = result.get("response")
            model_id = response.get("modelId") if isinstance(response, dict) else None
            if model_id:
                model_result = await fetch_model(model_id)
                if model_result.get("status") == "hit":
                    response = graft_model_into_version(response, model_result.get("response"))
            envelope = write_cache(library_id, "hit", response)
            fetched = True
        elif status == "not_found":
            envelope = write_cache(library_id, "not_found")
            fetched = True
        else:
            # disabled / unavailable / error — nothing cached, retry allowed.
            return {"ok": False, "status": status, "cached": False, "detail": result.get("detail"), "identity": identity}, 200

    status = envelope.get("status")
    merged = False
    if status == "hit":
        response = envelope.get("response")
        model_type = model_record.get("modelType")
        existing = read_model_metadata(library_id, model_type)
        path = model_record.get("path") or existing.get("path") or library_id
        merge_civitai_into_model_record(path, library_id, existing, response, model_type)
        await apply_civitai_model_thumbnail(library_id, model_type, response, overwrite=force)
        ModelLibraryIndex().refresh_record(library_id)
        merged = True

    return {
        "ok": True,
        "status": status,
        "cached": not fetched,
        "fetchedAt": envelope.get("fetchedAt"),
        "merged": merged,
        "identity": identity,
    }, 200


async def _hf_import_impl(library_id, repo):
    from ..library.hf_client import fetch_model_card

    model_record = (await ModelLibraryIndex.loaded()).get(library_id)
    lora_resolved = None if model_record else _lora_index_get(library_id)
    if not model_record and not lora_resolved:
        return {"ok": False, "status": "unavailable", "error": "Unknown model"}, 404

    result = await fetch_model_card(repo)
    status = result.get("status")
    if status != "hit":
        return {"ok": False, "status": status, "detail": result.get("detail")}, 200

    card = result.get("card")
    if model_record:
        model_type = model_record.get("modelType")
        existing = read_model_metadata(library_id, model_type)
        path = model_record.get("path") or existing.get("path") or library_id
        merge_hf_into_model_record(path, library_id, existing, repo, card, model_type)
        ModelLibraryIndex().refresh_record(library_id)
    else:
        record, index = lora_resolved
        from ..lora_loadout.hf_map import merge_hf_into_record
        existing = record.get("sidecar_data") if isinstance(record.get("sidecar_data"), dict) else {}
        lib_id = record.get("library_id") or library_id
        merge_hf_into_record(record.get("path"), lib_id, existing, repo, card)
        LoraLibraryIndex().refresh_record(lib_id)
    return {"ok": True, "status": "hit", "repo": repo}, 200


def register_routes():
    global _ROUTES_REGISTERED
    if PromptServer is None or _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    # This node's KRC bundle sections (UNIFIED_BUNDLE_GAMEPLAN.md).
    for section in bundle_sections():
        register_section(section)

    routes = PromptServer.instance.routes

    @routes.get("/krc/model-library/version")
    async def model_library_version(request):
        return _json(
            {
                "krcMetadataVersion": KRC_MODEL_METADATA_VERSION,
                "krcMetadataSchemaVersion": KRC_MODEL_METADATA_SCHEMA_VERSION,
                "krcMetadataExportVersion": KRC_MODEL_METADATA_EXPORT_VERSION,
                "krcMetadataImportVersion": KRC_MODEL_METADATA_IMPORT_VERSION,
            }
        )

    @routes.get("/krc/model-library/library")
    async def model_library_index(request):
        force = request.query.get("refresh") in ("1", "true", "yes")
        index = await ModelLibraryIndex.loaded(force=force)
        lora_index = await LoraLibraryIndex.loaded(force=force)
        single_array = request.query.get("rows") == "items"

        def prepare():
            # Models + LoRA read-through rows, usage, folder rail and aliases (listing.py,
            # shared with the external API's /krc/ext/v1/models).
            rows = library_rows(index, lora_index)
            return _json(
                {
                    "schemaVersion": KRC_MODEL_METADATA_SCHEMA_VERSION,
                    # scanIds: the scans this list came from (see LoRA Loadout's /library).
                    "scanIds": {"models": index.scan_id, "loras": lora_index.scan_id},
                    "scan": index.status(),
                    "status": index.status(),
                    "items": rows["items"],
                    **({} if single_array else {"loras": rows["items"]}),
                    "folders": rows["folders"],
                    "aliases": rows["aliases"],
                }
            )

        return await prepare_library_response(prepare)

    @routes.post("/krc/model-library/folder-color")
    async def model_library_folder_color(request):
        try:
            payload = await request.json()
        except Exception:
            return _json({"error": "bad-json"}, status=400)
        folder_id = payload.get("folder", "")
        # A LoRA nested folder's color is owned by LoRA Loadout (read-through); write it
        # back there so the LoRA Loadout node and Model Library stay in sync.
        lora_folder = _lora_folder_name(folder_id)
        if lora_folder is not None:
            store = _lora_folder_store()
            if store is not None:
                return _json(store.save_folder(lora_folder, payload.get("cardColor", "")))
        data = ModelLibraryFolderStore().save_folder(folder_id, payload.get("cardColor", ""))
        return _json(data)

    @routes.post("/krc/model-library/folder-pin")
    async def model_library_folder_pin(request):
        try:
            payload = await request.json()
        except Exception:
            return _json({"error": "bad-json"}, status=400)
        folder_id = payload.get("folder", "")
        # A LoRA nested folder's pin is owned by LoRA Loadout (read-through); write back
        # there so pinning a LoRA folder in Model Library reflects in the LoRA Loadout node.
        lora_folder = _lora_folder_name(folder_id)
        if lora_folder is not None:
            store = _lora_folder_store()
            if store is not None:
                return _json(store.save_pin(lora_folder, bool(payload.get("pinned"))))
        data = ModelLibraryFolderStore().save_pin(folder_id, bool(payload.get("pinned")))
        return _json(data)

    @routes.get("/krc/model-library/detail/{library_id}")
    async def model_library_detail(request):
        library_id = request.match_info.get("library_id", "")
        index = await ModelLibraryIndex.loaded()
        scanned = index.get(library_id)
        model_type = scanned.get("modelType") if scanned else None

        # LoRA ids are never scanned into ModelLibraryIndex (schema S8: read-through only), so
        # a null scan means the id may belong to LoRA Loadout. Resolve it as a LoRA FIRST and
        # return LL's own flat detail shape (with sha256) that the cloned LoRA InfoPanel's
        # ensureLoraDetail merges. This MUST precede the generic-record lookup: a stray
        # model-metadata record for a LoRA id would otherwise shadow the read-through and hand
        # the panel a {record}-shaped payload it can't merge (no sha256), silently blanking the
        # heavy text. A genuine (scanned) model skips this — it can't be a LoRA — so the LL
        # index refresh is only paid for un-scanned ids.
        if scanned is None:
            lora_payload = _lora_detail_payload(library_id)
            if lora_payload is not None:
                return _json(lora_payload)

        record = read_model_metadata(library_id, model_type)
        if not record and scanned and is_local_library_id(library_id):
            # Lazy seed: the first time the user opens an unstabilized model, persist a
            # placeholder sidecar (identityPending, Date Added frozen to file birth/mtime)
            # so the date is stable and a later edit/stabilization has a record to adopt.
            # We do NOT hash here — the SHA lands on explicit/point-of-need stabilization.
            # Best-effort: a write failure just falls through to the transient default.
            try:
                write_model_metadata(scanned, scanned.get("sidecar_data") or {}, seed=True)
                record = read_model_metadata(library_id, model_type)
            except OSError:
                record = None
        if not record and scanned:
            record = scanned.get("sidecar_data") or {}
        if record:
            # Normalize on read (never gate on the stamp): default-fill to the current schema.
            path = record.get("path") or record.get("file") or library_id
            normalized = normalize_model_metadata(Path(path), library_id, record)
            return _json({"libraryId": library_id, "record": normalized})

        return _json({"error": "not-found", "libraryId": library_id}, status=404)

    @routes.post("/krc/model-library/selection-jobs/preview")
    async def preview_selection_job(request):
        try:
            return _json(await selection_jobs.preview(await request.json()))
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc)}, status=400)

    @routes.post("/krc/model-library/selection-jobs/start")
    async def start_selection_job(request):
        try:
            return _json(await selection_jobs.start(await request.json()))
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc)}, status=400)

    @routes.get("/krc/model-library/selection-jobs/{job_id}")
    async def selection_job_status(request):
        try:
            return _json(selection_jobs.status(request.match_info["job_id"]))
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc)}, status=404)

    @routes.post("/krc/model-library/selection-jobs/{job_id}/cancel")
    async def cancel_selection_job(request):
        try:
            return _json(selection_jobs.cancel(request.match_info["job_id"]))
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc)}, status=404)

    @routes.post("/krc/model-library/bulk-attributes")
    async def model_library_bulk_attributes(request):
        try:
            return _json(await update_model_attributes(await request.json()))
        except ValueError as exc:
            return _json({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return _json({"ok": False, "error": str(exc)}, status=500)

    @routes.post("/krc/model-library/metadata/{library_id}")
    @notify_card_write("model")
    async def model_library_save(request):
        library_id = request.match_info.get("library_id", "")
        try:
            body = await request.json()
        except Exception:
            return _json({"error": "bad-json"}, status=400)
        if not isinstance(body, dict):
            return _json({"error": "bad-body"}, status=400)

        posted = body.get("metadata") if isinstance(body.get("metadata"), dict) else {}
        path = body.get("path") or posted.get("path") or ""
        if not path:
            return _json({"error": "missing-path", "libraryId": library_id}, status=400)

        # Never write a generic record over a LoRA id (schema S8). LoRA edits are delegated
        # to LoRA Loadout via the bare POST /metadata route below; this generic
        # /metadata/{id} path is non-LoRA only, so a LoRA id here is refused defensively
        # rather than minting a competing generic record.
        index = await ModelLibraryIndex.loaded()
        scanned = index.get(library_id)
        model_type = scanned.get("modelType") if scanned else posted.get("modelType")

        if not read_model_metadata(library_id, model_type) and _lora_index_get(library_id):
            return _json({"error": "lora-not-writable-here", "libraryId": library_id}, status=409)

        # Merge only whitelisted fields onto the existing stored record (or a fresh
        # scan-shaped base). This is where a scanned model's FIRST record gets written —
        # persistence happens on edit, not on scan.
        existing = read_model_metadata(library_id, model_type)
        merged = dict(existing)
        if model_type:
            merged["modelType"] = model_type
        for field in _EDITABLE_STRING_FIELDS:
            if field in posted and posted[field] is not None:
                merged[field] = posted[field]
        if "creatorName" in posted:
            merged["creator"] = {"name": str(posted.get("creatorName") or "")}
        if "companyName" in posted:
            merged["organization"] = {"name": str(posted.get("companyName") or "")}
        if "sourceName" in posted:
            merged["source"] = {"name": str(posted.get("sourceName") or "")}
        if isinstance(posted.get("tags"), list):
            merged["tags"] = posted["tags"]
        if "favorite" in posted:
            merged["favorite"] = bool(posted["favorite"])
        if "pinned" in posted:
            if posted["pinned"] is True and not existing.get("pinned"):
                problem = pin_limit_problem([library_id])
                if problem:
                    return _json({"error": problem}, status=409)
            merged["pinned"] = bool(posted["pinned"])
        if "rating" in posted:
            merged["rating"] = as_int(posted.get("rating"), 0)
        if "nsfw" in posted:
            merged["nsfw"] = bool(posted["nsfw"])
        if "nsfwLevel" in posted:
            merged["nsfwLevel"] = nsfw_rating(posted.get("nsfwLevel"))
        if "customBadge" in posted:
            custom_badge = normalize_custom_badge(posted.get("customBadge", ""))
            if custom_badge is None:
                return _json({"error": "Custom badge must use letters, numbers, and spaces only (10 max)"}, status=400)
            merged["customBadge"] = custom_badge
        # verification is set atomically as a whole object (normalize coerces it).
        if isinstance(posted.get("verification"), dict):
            merged["verification"] = posted["verification"]

        normalized = normalize_model_metadata(Path(path), library_id, merged)
        record = {
            "library_id": library_id,
            "modelType": normalized.get("modelType"),
            "relative_path": body.get("relative_path") or normalized.get("file"),
            "filename": body.get("filename") or Path(path).name,
            "path": path,
        }
        write_model_metadata(record, normalized)
        # Re-read this record into the scan cache so the browser list reflects the edit
        # (e.g. a new display name) on the next fetch, without a full rescan.
        ModelLibraryIndex().refresh_record(library_id)
        # Re-read to return exactly what was stored (post write-rules).
        saved = normalize_model_metadata(Path(path), library_id, read_model_metadata(library_id, normalized.get("modelType")))
        return _json({"libraryId": library_id, "record": saved})

    # ── LoRA read-through write-back ─────────────────────────────────────────
    # The cloned LoRA InfoPanel posts LoRA edits to these Model Library paths. LoRA
    # metadata is owned by LoRA Loadout (schema S8), so delegate to LL's shared write
    # handlers rather than writing a generic record. The bare /metadata carries the
    # sha256 in the body (the LoRA panel's save); the generic /metadata/{id} above is for
    # non-LoRA records only.
    @routes.post("/krc/model-library/metadata")
    @notify_card_write("model")
    async def model_library_lora_save(request):
        from ..lora_loadout.write_handlers import save_lora_metadata
        try:
            payload = await request.json()
        except Exception:
            return _json({"error": "bad-json"}, status=400)
        body, status = await save_lora_metadata(payload if isinstance(payload, dict) else {})
        return _json(body, status=status)

    @routes.post("/krc/model-library/metadata/blank/{sha256}")
    @notify_card_write("model")
    async def model_library_lora_blank(request):
        # Reset ID: a scanned model resets here; anything else is a LoRA read-through.
        library_id = request.match_info.get("sha256", "")
        index = await ModelLibraryIndex.loaded()
        record = index.get(library_id)
        if record is None:
            from ..lora_loadout.write_handlers import blank_lora_metadata
            body, status = await blank_lora_metadata(library_id)
            return _json(body, status=status)
        from .identity_records import blank_record_metadata
        result = await asyncio.get_running_loop().run_in_executor(None, blank_record_metadata, record)
        ModelLibraryIndex().refresh_record(record.get("library_id") or library_id)
        return _json({"ok": True, "identity": result})

    @routes.get("/krc/model-library/thumbnail/{library_id}")
    async def model_library_thumbnail(request):
        library_id = request.match_info.get("library_id", "")
        # Honor the ?kind= param (poster | animated | default) so a LoRA with both a webm
        # and a static webp serves the right one. Without it the route always returned the
        # animated webm (prefer_animated), so the card's and InfoPanel's static poster slot
        # — which requests kind=poster — got a webm and rendered empty.
        try:
            sized = parse_width(request.query) is not None
        except ValueError as exc:
            return web.Response(status=400, text=str(exc), headers=_NO_CACHE_HEADERS)
        # ?w= (outside apps) always serves the static poster, scaled down.
        kind = "poster" if sized else request.query.get("kind", "")

        # Generic model thumbnails now carry two variants (static webp poster +
        # optional animated webm). Serve the one matching the requested kind: a
        # poster/default request must never get the webm (a plain <img> renders it
        # empty); an animated request must never get the webp.
        model_type = _model_type_for_library_id(library_id)
        thumb = find_model_thumbnail_variant(library_id, kind or "default", model_type)

        # LoRA read-through: pick the variant matching the requested kind from LL's store.
        if not thumb:
            lora_index = await LoraLibraryIndex.loaded()
            lora_record = lora_index.get(library_id)
            if lora_record:
                thumb = find_lora_thumbnail_variant(lora_record.get("library_id"), kind or "default")

        if not thumb:
            return web.Response(status=404, headers=_NO_CACHE_HEADERS)
        thumb = await thumbnail_to_serve(thumb, request.query)
        return web.FileResponse(thumb, headers=thumbnail_cache_headers(request.query))

    @routes.post("/krc/model-library/thumbnail/{library_id}")
    @notify_card_write("model")
    async def model_library_thumbnail_upload(request):
        library_id = request.match_info.get("library_id", "")
        if await _is_lora_read_through(library_id):
            from ..lora_loadout.write_handlers import lora_thumbnail_upload
            return await lora_thumbnail_upload(request, library_id)
        # Accept the raw image bytes as the request body (frontend posts a File/Blob).
        data = await request.read()
        model_type = _model_type_for_library_id(library_id)
        saved = save_model_thumbnail_bytes(library_id, data, model_type)
        if not saved:
            return _json({"error": "save-failed", "libraryId": library_id}, status=400)
        ModelLibraryIndex().refresh_record(library_id)
        version = thumbnail_version(*find_model_thumbnail_paths(library_id, model_type))
        return _json({
            "libraryId": library_id,
            "thumbnail": f"/thumbnail/{library_id}?v={version}",
            "thumbnailVersion": version,
        })

    @routes.post("/krc/model-library/thumbnail/{library_id}/upload-video")
    @notify_card_write("model")
    async def model_library_thumbnail_upload_video(request):
        # Direct mp4/webm upload -> the KRC constrained thumbnail set (webp poster +
        # VP9 webm loop), via the shared Tier-3 engine. The upload is transient:
        # transcode, then discard it. Uploading a video is an explicit "I want
        # animation" act, so we always request the loop and degrade to poster-only
        # if the server has no VP9 encoder. Mirrors LoRA Loadout's route exactly.
        library_id = request.match_info.get("library_id", "")
        if not library_id:
            return _json({"error": "missing-library-id"}, status=400)
        if await _is_lora_read_through(library_id):
            from ..lora_loadout.write_handlers import lora_thumbnail_upload_video
            return await lora_thumbnail_upload_video(request, library_id)
        if not krc_video.VIDEO_SUPPORT:
            return _json(
                {"error": krc_video.NO_VIDEO_MESSAGE}, status=503)

        try:
            # A fixed suffix: the container is read from the file's bytes, never its name.
            tmp_path = await save_upload(request, VIDEO_UPLOAD_MAX)
        except UploadTooLarge as err:
            return _json({"error": str(err)}, status=413)
        if tmp_path is None:
            return _json({"error": "Missing video file"}, status=400)

        try:
            if not tmp_path.stat().st_size:
                return _json({"error": "Empty upload"}, status=400)
            if not krc_video.sniff_container(tmp_path):
                return _json({"error": krc_video.UNSUPPORTED_VIDEO_MESSAGE}, status=400)

            settings = load_settings()
            model_type = _model_type_for_library_id(library_id)
            result = transcode_model_video(
                tmp_path, library_id, model_type,
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
            return _json({"error": "Could not read that video file."}, status=400)

        ModelLibraryIndex().refresh_record(library_id)
        return _json({
            "libraryId": library_id,
            "ok": True,
            "hasPoster": bool(result["poster"]),
            "hasAnimation": bool(result["animated"]),
            "reason": result["reason"],
            "thumbnailVersion": thumbnail_version(*find_model_thumbnail_paths(library_id, model_type)),
        })

    @routes.delete("/krc/model-library/thumbnail/{library_id}")
    @notify_card_write("model")
    async def model_library_thumbnail_delete(request):
        library_id = request.match_info.get("library_id", "")
        if await _is_lora_read_through(library_id):
            from ..lora_loadout.write_handlers import lora_thumbnail_delete
            return await lora_thumbnail_delete(request, library_id)
        model_type = _model_type_for_library_id(library_id)
        deleted = delete_model_thumbnail(library_id, model_type)
        ModelLibraryIndex().refresh_record(library_id)
        return _json({"libraryId": library_id, "deleted": bool(deleted)})

    @routes.post("/krc/model-library/thumbnail/{library_id}/refresh-source")
    @notify_card_write("model")
    async def model_library_thumbnail_refresh_source(request):
        # Refresh from the recorded source exists for LoRAs only (Civitai video
        # previews); a generic model gets LoRA Loadout's "unknown" answer.
        from ..lora_loadout.write_handlers import lora_thumbnail_refresh_source
        return await lora_thumbnail_refresh_source(request, request.match_info.get("library_id", ""))

    @routes.post("/krc/model-library/civitai/fetch/{library_id}")
    @notify_card_write("model")
    async def model_library_civitai_fetch(request):
        # Public Civitai by-hash pull for one model (generic model or LoRA read-through).
        # Consent-guarded inside the client; ?force=1 re-pulls + overwrites the cache.
        library_id = request.match_info.get("library_id", "")
        force = request.query.get("force") in ("1", "true", "yes")
        body, status = await _civitai_fetch_impl(library_id, force)
        return _json(body, status=status)

    @routes.post("/krc/model-library/hf/import/{library_id}")
    @notify_card_write("model")
    async def model_library_hf_import(request):
        # Import metadata from a HuggingFace repo the user pasted, onto the selected model.
        library_id = request.match_info.get("library_id", "")
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        repo = parse_hf_repo(payload.get("repo") if isinstance(payload, dict) else "")
        if not repo:
            return _json(
                {"ok": False, "status": "invalid",
                 "error": "Not a valid HuggingFace repo URL or author/model"},
                status=400,
            )
        body, status = await _hf_import_impl(library_id, repo)
        return _json(body, status=status)

    # Options ▸ Clean stale records: saved records whose file is gone. Model Library
    # shows LoRAs too, so the list (and the clean) covers LoRA Loadout's records as well.
    async def _live_ids(force=False):
        models = await ModelLibraryIndex.loaded(force=force)
        loras = await LoraLibraryIndex.loaded(force=force)
        return set(models.records.keys()) | set(loras.records.keys()), models, loras

    @routes.get("/krc/model-library/missing")
    async def model_library_missing(_request):
        from ..lora_loadout.identity_records import stale_identity_records
        from .stale_records import stale_model_records
        live, _models, _loras = await _live_ids()
        items = stale_model_records(live) + stale_identity_records(live)
        return _json({"items": items})

    @routes.delete("/krc/model-library/missing")
    async def model_library_purge_missing(request):
        from ..lora_loadout.identity_records import purge_missing_identity
        from .stale_records import purge_stale_model
        try:
            payload = await request.json()
        except Exception:
            return _json({"error": "bad-json"}, status=400)
        ids = payload.get("ids", []) if isinstance(payload, dict) else []
        if not isinstance(ids, list):
            return _json({"error": "Expected ids list"}, status=400)
        live, models, loras = await _live_ids(force=True)
        deleted, skipped = [], []
        for library_id in [str(item or "") for item in ids]:
            if not library_id:
                continue
            if library_id in live or models.get(library_id) or loras.get(library_id):
                skipped.append(library_id)
                continue
            # Each purge touches only its own store's rows for this id.
            purge_stale_model(library_id)
            purge_missing_identity(library_id)
            deleted.append(library_id)
        ModelLibraryIndex._cache = {}
        LoraLibraryIndex._cache = {}
        return _json({"ok": True, "deleted": deleted, "skipped": skipped})

    @routes.post("/krc/model-library/stabilize/{library_id}")
    async def model_library_stabilize(request):
        if getattr(request, "query", {}).get("background") == "1":
            from .stabilize_queue import enqueue_stabilize
            return _json(enqueue_stabilize(request.match_info.get("library_id", "")), status=202)
        body, status = await stabilize_model_by_id(request.match_info.get("library_id", ""))
        if status == 200 and body.get("identity"):
            ModelLibraryIndex._cache = {}
            refreshed = await ModelLibraryIndex.loaded()
            body["item"] = refreshed.get(body["identity"]["newId"]) or body.get("item")
        return _json(body, status=status)
