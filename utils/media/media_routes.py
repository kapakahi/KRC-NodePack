"""The Media's HTTP routes (all under /krc/media/, so NodePack's same-site guard covers
every write).

    GET  /krc/media/media          the item records and the folders
    POST /krc/media/upload           multipart "file" (+ "settings" JSON): a still -> the new
                                        record; a video / animated GIF -> {job} (converts in
                                        the background)
    GET  /krc/media/job/{id}         a conversion's {status, progress, error, item}
    POST /krc/media/job/{id}/cancel  stop it
    GET  /krc/media/file/{id}        the media (WebP / WebM)
    GET  /krc/media/download/{id}    image as PNG; video in its stored format
    GET  /krc/media/thumb/{id}       the card thumbnail (a still; ?w= scales it down)
    POST /krc/media/item/{id}        {favorite, pinned, color, customBadge, nsfw, name, folder} -> the record
    POST /krc/media/folders/create   {name} -> the folder
    POST /krc/media/folders/{id}     {name, color, keep, pinned} -> the folder
    POST /krc/media/folders/{id}/delete   (its items move to Unsorted)
    POST /krc/media/folders/{id}/purge    the folder AND its items -> {removed, bytes}
    POST /krc/media/delete/{id}      remove one item
    POST /krc/media/purge/preview    {scope, ids?} -> counts, protections and confirmation snapshot
    POST /krc/media/purge            {scope, ids?, snapshot, confirmed} -> tracked-file deletion
    POST /krc/media/flush            {everything} -> {removed, kept, bytes} (spares what
                                        presets use)
    GET  /krc/media/presets          the media presets
    POST /krc/media/presets/create   {name, auto, numbered} -> the new preset
    POST /krc/media/presets/{id}     {name} -> the preset (renamed)
    POST /krc/media/presets/{id}/slot/{n}  {id, version?} (n = 0-5) -> the preset; with
                                        version, 409 {conflict, preset, version} when the
                                        preset changed (the Loader's multi-file Upload)
    POST /krc/media/presets/{id}/slots  {ids: [1–6 references], start?} -> the preset
    POST /krc/media/presets/{id}/delete

An upload's settings: {"maxMegapixels"} (0 = as is), {"keepAlpha"} (stills), {"fps", "audio",
"trimIn", "trimOut", "maxLength"} (videos); {"folder": id} (the Media's selected chip; "" = Unsorted) and
{"assign": {"preset", "slot"}}: the new item goes into that slot when it's added (a still at
once, a video when its conversion is done).
Every preset answer (list included) carries ``version`` (preset_store.version).
A change publishes MEDIA_EVENT / PRESETS_EVENT so every open page refreshes.
"""

import asyncio
import json
import mimetypes
from pathlib import Path
from urllib.parse import quote

from . import media_jobs as jobs
from . import media_store as store
from . import preset_store as presets
from .input_storage import prepare_upload
from .media_store import public_item as _public
from .krc import api
from .process_image import ImageProcessError, heif_available, png_bytes, process, valid_megapixels
from .process_video import VideoProcessError, is_animated_image, require_encoder

MEDIA_EVENT = "krc-media-media-changed"
PRESETS_EVENT = "krc-media-presets-changed"
IMAGE_UPLOAD_MAX = 200 * 1024 * 1024          # a still's upload cap (bytes)
VIDEO_UPLOAD_MAX = 4 * 1024 * 1024 * 1024     # a video's
CHUNK = 1024 * 1024
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic", ".heif", ".avif"}
VIDEO_EXTENSIONS = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"}


def _announce(op, item_id=""):
    try:
        api().publish_sync(MEDIA_EVENT, {"op": op, "id": item_id})
    except Exception:  # noqa: BLE001 - a missed push only means pages refresh later
        pass


def _announce_presets(op, preset_id=""):
    try:
        api().publish_sync(PRESETS_EVENT, {"op": op, "id": preset_id})
    except Exception:  # noqa: BLE001
        pass


def _upload_folder(settings):
    """The folder an upload goes into (an unknown one = Unsorted; store.add checks again)."""
    folder = settings.get("folder") if isinstance(settings, dict) else ""
    return str(folder or "") if store.ID_PATTERN.match(str(folder or "")) else ""


def _assign(item_id, settings):
    """Put a new item into the slot its upload asked for (a node's Upload). The Loader picks
    or makes its preset before uploading; if that preset is gone by the time the item is
    added (deleted while a video converted), the item still lands in a slot, of a new
    "Preset n", instead of only in Media."""
    target = settings.get("assign") if isinstance(settings, dict) else None
    if not isinstance(target, dict) or "preset" not in target:
        return
    try:
        preset_id = str(target.get("preset") or "")
        if not (store.ID_PATTERN.match(preset_id) and presets.get(preset_id)):
            preset_id = presets.create(numbered=True)["id"]
            _announce_presets("create", preset_id)
        presets.set_slot(preset_id, target.get("slot"), item_id=item_id)
        _announce_presets("slot", preset_id)
    except (presets.PresetError, store.MediaError) as err:
        print(f"[KRC Media] couldn't put the upload into its slot: {err}")


def _after_add(item_id, settings):
    _assign(item_id, settings)
    _announce("add", item_id)


def _display_name(filename):
    """The card's name: the uploaded file's name without folders or extension (every item
    is WebP or WebM, so the extension says nothing)."""
    return store.clean_name(Path(Path(str(filename or "upload")).name).stem) or "upload"


async def _save_part(part, dest, cap):
    """Stream one multipart part to ``dest``; refuses past ``cap`` bytes."""
    size = 0
    with dest.open("wb") as handle:
        while True:
            chunk = await part.read_chunk(CHUNK)
            if not chunk:
                break
            size += len(chunk)
            if size > cap:
                raise store.MediaError(f"That file is larger than {cap // (1024 * 1024)} MB.")
            handle.write(chunk)
    return size


def _refused(message, status=400):
    return status, {"ok": False, "error": str(message)}


async def receive_upload(request, check_settings=None):
    """One upload (multipart "file" + optional "settings" JSON), the node's and the external
    API's: checked, saved under incoming/, then a still converted to WebP at once, or a video /
    animated GIF queued as a conversion job. ``check_settings(settings)`` may refuse the
    settings (raise MediaError) once they're read. -> (status, body): 200 {"ok", "item"},
    202 {"ok", "job"}, or an error {"ok": False, "error"} (400, 413, 415, 500, 503)."""
    temp = None
    try:
        reader = await request.multipart()
        settings, filename, size = {}, "", 0
        temp = store.incoming_dir() / f"{store.new_id()}.upload"
        received = False
        while True:
            part = await reader.next()
            if part is None:
                break
            if part.name == "settings":
                try:
                    settings = json.loads(await part.text() or "{}")
                except ValueError:
                    settings = {}
            elif part.name == "file" and not received:
                filename = part.filename or ""
                ext = Path(filename).suffix.lower()
                if ext not in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
                    return _refused("Upload an image (PNG, JPEG, WebP, GIF, BMP, TIFF, HEIC, AVIF) or a video "
                                   "(MP4, MOV, M4V, WebM, MKV, AVI).", 415)
                if ext in (".heic", ".heif", ".avif") and not heif_available():
                    return _refused("HEIC / AVIF needs pillow-heif on the server (pip install pillow-heif).", 415)
                if ext in VIDEO_EXTENSIONS:
                    try:
                        require_encoder()
                    except VideoProcessError as err:
                        return _refused(err, 503)
                size = await _save_part(part, temp, VIDEO_UPLOAD_MAX if ext in VIDEO_EXTENSIONS else IMAGE_UPLOAD_MAX)
                received = True
        if not received:
            return _refused("No file in the upload.")
        ext = Path(filename).suffix.lower()
        settings = settings if isinstance(settings, dict) else {}
        if check_settings is not None:
            check_settings(settings)
        # The picked file's own name and size (not the converted one's): what "Skip
        # duplicates" compares a new upload with.
        source_info = {"name": Path(filename).name[:200], "bytes": size}
        if ext in VIDEO_EXTENSIONS or (ext == ".gif" and await asyncio.to_thread(is_animated_image, temp)):
            if ext == ".gif":
                try:
                    require_encoder()
                except VideoProcessError as err:
                    return _refused(err, 503)
            # A video (or an animated GIF): convert in the background; the page polls the job.
            source = temp.with_suffix(f".source{ext}")
            temp.rename(source)
            temp = None
            record = {"id": store.new_id(), "kind": "video", "ext": ".webm", "name": _display_name(filename),
                      "folder": _upload_folder(settings), "source": source_info}
            try:
                job = jobs.submit(source, record, settings)
            except Exception:
                source.unlink(missing_ok=True)
                raise
            return 202, {"ok": True, "job": job}
        megapixels = valid_megapixels(settings.get("maxMegapixels"))
        item_id = store.new_id()
        record = {"id": item_id, "kind": "image", "ext": ".webp", "name": _display_name(filename),
                  "folder": _upload_folder(settings), "source": source_info}
        record = prepare_upload(record)
        dest, thumb = store.media_path(record), store.thumb_path(item_id)
        try:
            info = await asyncio.to_thread(process, temp, dest, thumb, max_megapixels=megapixels,
                                           keep_alpha=settings.get("keepAlpha", True) is not False)
            record.update(info)
            store.add(record)
        except (ImageProcessError, store.MediaError, OSError) as err:
            for path in (dest, thumb):
                path.unlink(missing_ok=True)
            return _refused(err, 415 if isinstance(err, ImageProcessError) else 500)
        print(f"[KRC Media] uploaded {record['name']} ({info['width']}x{info['height']}"
              f"{', orientation fixed' if info['oriented'] else ''})")
        _after_add(item_id, settings)
        return 200, {"ok": True, "item": _public(record)}
    except (store.MediaError, VideoProcessError) as err:
        return _refused(err, 413 if "larger" in str(err) else 400)
    except Exception as err:  # noqa: BLE001
        print(f"[KRC Media] upload failed: {err}")
        return _refused(f"The upload failed ({err}).", 500)
    finally:
        if temp is not None:
            try:
                temp.unlink(missing_ok=True)
            except OSError:
                pass


async def download_response(web, record, path):
    """The Media's Download for one item (also ext/v1's): a video as is, a still as PNG (an
    existing PNG keeps its embedded metadata), named after the card."""
    video = record.get("kind") == "video"
    extension = path.suffix if video else ".png"
    name = store.clean_name(record.get("name") or path.stem).replace("\\", "_").replace("/", "_")
    if Path(name).suffix.lower() in IMAGE_EXTENSIONS | VIDEO_EXTENSIONS:
        name = Path(name).stem
    filename = (name or "media") + extension
    headers = {
        "Content-Disposition": "attachment; filename*=UTF-8''" + quote(filename, safe=""),
        "Cache-Control": "no-store",
        "Content-Type": (mimetypes.guess_type(path.name)[0] or "application/octet-stream") if video else "image/png",
    }
    # Stream videos unchanged; existing PNGs retain their embedded metadata.
    if video or path.suffix.lower() == ".png":
        return web.FileResponse(path, headers=headers)
    return web.Response(body=await asyncio.to_thread(png_bytes, path), headers=headers)


def register_routes():
    jobs.set_on_added(_after_add)
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return
    routes = PromptServer.instance.routes

    def refused(message, status=400):
        return web.json_response({"ok": False, "error": str(message)}, status=status)

    @routes.get("/krc/media/output-options")
    async def output_options(request):
        from .output_save import capabilities
        try:
            available = await asyncio.to_thread(capabilities)
            return web.json_response({"ok": True, "formats": available,
                                      "folders": [folder for folder in store.folders() if folder.get("storage") == "output"]})
        except Exception as err:  # noqa: BLE001 - report server capability failure to the node
            return refused(err, 500)

    @routes.get("/krc/media/media")
    async def media_list(_request):
        try:
            missing = await asyncio.to_thread(store.reconcile_missing)
            if missing:
                _announce("missing")
            return web.json_response({"ok": True, "items": [_public(item) for item in store.items()],
                                      "folders": store.folders(),
                                      "heif": heif_available(), "maxPinned": store.pin_limit()})
        except Exception as err:  # noqa: BLE001
            return refused(err, 500)

    @routes.post("/krc/media/upload")
    async def media_upload(request):
        status, body = await receive_upload(request)
        return web.json_response(body, status=status)

    def _file_response(path):
        if not path.is_file():
            return refused("Not found.", 404)
        content_type = mimetypes.guess_type(path.name)[0] or ("image/webp" if path.suffix == ".webp" else "video/webm")
        return web.FileResponse(path, headers={
            "Content-Type": content_type,
            "Cache-Control": "private, max-age=31536000, immutable",  # ids never change content
        })

    @routes.get("/krc/media/file/{item_id}")
    async def media_file(request):
        try:
            record = store.get(request.match_info["item_id"])
            if record is None:
                return refused("Not found.", 404)
            return _file_response(store.media_path(record))
        except store.MediaError as err:
            return refused(err, 404)

    @routes.get("/krc/media/download/{item_id}")
    async def media_download(request):
        try:
            record = store.get(request.match_info["item_id"])
            if record is None:
                return refused("Not found.", 404)
            path = store.media_path(record)
            if not path.is_file():
                return refused("Not found.", 404)
            return await download_response(web, record, path)
        except (store.MediaError, FileNotFoundError) as err:
            return refused(err, 404)
        except ImageProcessError as err:
            return refused(err, 400)

    @routes.get("/krc/media/thumb/{item_id}")
    async def media_thumb(request):
        # Always a still (a video's poster frame). ?w= (outside apps, KRC_EXTERNAL_API.md)
        # serves it scaled down to one of the shared thumbnail widths.
        from ..library.thumbnail_sizes import thumbnail_to_serve
        try:
            item_id = store.valid_id(request.match_info["item_id"])
            path = store.thumb_path(item_id)
        except store.MediaError as err:
            return refused(err, 404)
        if not path.is_file():
            return refused("Not found.", 404)
        try:
            return _file_response(await thumbnail_to_serve(path, request.query))
        except ValueError as err:
            return refused(err, 400)

    @routes.post("/krc/media/bulk-operation/preview")
    async def media_preview_operation(request):
        try:
            payload = await request.json()
            return web.json_response(await asyncio.to_thread(store.bulk_operation, payload, preview=True))
        except (store.MediaError, ValueError) as err:
            return refused(err)
        except Exception as err:
            return refused(err, 500)

    @routes.post("/krc/media/bulk-operation")
    async def media_bulk_operation(request):
        try:
            payload = await request.json()
            result = await asyncio.to_thread(store.bulk_operation, payload)
            if result["updated"]:
                _announce(payload["operation"])
            return web.json_response(result)
        except (store.MediaError, ValueError) as err:
            return refused(err)
        except Exception as err:
            return refused(err, 500)

    @routes.post("/krc/media/bulk-attributes")
    async def media_bulk_attributes(request):
        try:
            result = store.bulk_attributes(await request.json())
            result["items"] = [_public(item) for item in result["items"]]
            _announce("bulk-attributes")
            return web.json_response(result)
        except (store.MediaError, ValueError) as err:
            return refused(err)
        except Exception as err:
            return refused(err, 500)

    @routes.post("/krc/media/item/{item_id}")
    async def media_item(request):
        try:
            payload = await request.json()
            record = store.update(request.match_info["item_id"], payload if isinstance(payload, dict) else {})
            _announce("update", record["id"])
            return web.json_response({"ok": True, "item": _public(record)})
        except store.MediaError as err:
            return refused(err)
        except ValueError:
            return refused("Bad request.")

    @routes.get("/krc/media/job/{job_id}")
    async def media_job(request):
        job = jobs.get(request.match_info["job_id"])
        return web.json_response({"ok": True, "job": job}) if job else refused("Unknown job.", 404)

    @routes.post("/krc/media/job/{job_id}/cancel")
    async def media_job_cancel(request):
        return web.json_response({"ok": True, "cancelled": jobs.cancel(request.match_info["job_id"])})

    @routes.post("/krc/media/purge/preview")
    async def media_purge_preview(request):
        from .media_purge import purge
        try:
            result = await asyncio.to_thread(purge, await request.json(), preview=True)
            return web.json_response(result)
        except (store.MediaError, ValueError) as err:
            return refused(err)
        except Exception as err:  # noqa: BLE001 - surface storage errors without deleting
            return refused(err, 500)

    @routes.post("/krc/media/purge")
    async def media_purge(request):
        from .media_purge import purge
        try:
            result = await asyncio.to_thread(purge, await request.json())
            if result["removed"]:
                _announce("purge")
            return web.json_response(result)
        except (store.MediaError, ValueError) as err:
            return refused(err)
        except Exception as err:  # noqa: BLE001
            return refused(err, 500)

    @routes.post("/krc/media/flush")
    async def media_flush(request):
        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        everything = bool(payload.get("everything")) if isinstance(payload, dict) else False
        result = await asyncio.to_thread(presets.flush_media, everything)
        print(f"[KRC Media] flush{' (everything)' if everything else ''}: {result['removed']} removed, "
              f"{result['kept']} kept, {result['bytes'] // 1024} KB freed")
        _announce("flush")
        return web.json_response({"ok": True, **result})

    @routes.post("/krc/media/delete/{item_id}")
    async def media_delete(request):
        try:
            item_id = store.valid_id(request.match_info["item_id"])
            removed = store.delete(item_id)
            if removed:
                _announce("delete", item_id)
            return web.json_response({"ok": True, "removed": removed})
        except store.MediaError as err:
            return refused(err)


    # A JSON body as a dict ({} when missing or not an object).
    async def body(request):
        try:
            payload = await request.json()
        except ValueError:
            payload = {}
        return payload if isinstance(payload, dict) else {}

    # ---- folders -------------------------------------------------------------------------
    @routes.post("/krc/media/folders/create")
    async def folders_create(request):
        payload = await body(request)
        try:
            folder = store.create_folder(payload.get("name"), storage=payload.get("storage", "media"))
        except store.MediaError as err:
            return refused(err)
        _announce("folder", folder["id"])
        return web.json_response({"ok": True, "folder": folder})

    @routes.post("/krc/media/folders/{folder_id}")
    async def folders_update(request):
        payload = await body(request)
        try:
            folder = store.update_folder(request.match_info["folder_id"], payload)
        except store.MediaError as err:
            return refused(err)
        _announce("folder", folder["id"])
        return web.json_response({"ok": True, "folder": folder})

    @routes.post("/krc/media/folders/{folder_id}/delete")
    async def folders_delete(request):
        try:
            moved = store.delete_folder(request.match_info["folder_id"])
        except store.MediaError as err:
            return refused(err)
        if moved is not None:
            _announce("folder", request.match_info["folder_id"])
        return web.json_response({"ok": True, "removed": moved is not None, "moved": moved or 0})

    @routes.post("/krc/media/folders/{folder_id}/purge")
    async def folders_purge(request):
        try:
            result = await asyncio.to_thread(store.purge_folder, request.match_info["folder_id"])
        except store.MediaError as err:
            return refused(err)
        if result is None:
            return refused("That folder no longer exists.", 404)
        print(f"[KRC Media] purged a folder: {result['removed']} item(s), {result['bytes'] // 1024} KB freed")
        _announce("folder", request.match_info["folder_id"])
        return web.json_response({"ok": True, **result})

    # ---- media presets ---------------------------------------------------------------
    def preset_json(record):
        return web.json_response({"ok": True, "preset": record, "version": presets.version(record)})

    @routes.get("/krc/media/presets")
    async def presets_list(_request):
        try:
            listed = [{**record, "version": presets.version(record)} for record in presets.presets()]
            return web.json_response({"ok": True, "presets": listed, "slots": presets.SLOT_COUNT})
        except Exception as err:  # noqa: BLE001
            return refused(err, 500)

    @routes.post("/krc/media/presets/create")
    async def presets_create(request):
        payload = await body(request)
        try:
            record = presets.create(payload.get("name") or "", auto=bool(payload.get("auto")),
                                    numbered=payload.get("numbered") is True)
        except presets.PresetError as err:
            return refused(err)
        _announce_presets("create", record["id"])
        return preset_json(record)

    @routes.post("/krc/media/presets/{preset_id}")
    async def presets_rename(request):
        payload = await body(request)
        try:
            record = presets.rename(request.match_info["preset_id"], payload.get("name"))
        except presets.PresetError as err:
            return refused(err)
        _announce_presets("rename", record["id"])
        return preset_json(record)

    @routes.post("/krc/media/presets/{preset_id}/slot/{index}")
    async def presets_slot(request):
        payload = await body(request)
        if_version = payload.get("version")
        if if_version is not None and not isinstance(if_version, str):
            return refused("version must be a string")
        try:
            record = presets.set_slot(request.match_info["preset_id"], request.match_info["index"],
                                      item_id=payload["id"] if "id" in payload else None, if_version=if_version)
        except presets.PresetConflict as err:
            return web.json_response({"ok": False, "error": str(err), "conflict": True, "preset": err.current,
                                      "version": presets.version(err.current)}, status=409)
        except (presets.PresetError, store.MediaError) as err:
            return refused(err)
        _announce_presets("slot", record["id"])
        return preset_json(record)

    @routes.post("/krc/media/presets/{preset_id}/slots")
    async def presets_slots(request):
        payload = await body(request)
        try:
            record = presets.set_slots(request.match_info["preset_id"], payload.get("ids"), start=payload.get("start"))
        except (presets.PresetError, store.MediaError) as err:
            return refused(err)
        _announce_presets("slots", record["id"])
        return preset_json(record)

    @routes.post("/krc/media/presets/{preset_id}/delete")
    async def presets_delete(request):
        try:
            removed = presets.delete(request.match_info["preset_id"])
        except presets.PresetError as err:
            return refused(err)
        if removed:
            _announce_presets("delete", request.match_info["preset_id"])
        return web.json_response({"ok": True, "removed": removed})


def startup_cleanup():
    removed = store.clean_incoming()
    if removed:
        print(f"[KRC Media] removed {removed} unfinished upload(s)")
    pruned = presets.prune_untouched()
    if pruned:
        print(f"[KRC Media] removed {pruned} untouched new preset(s)")
