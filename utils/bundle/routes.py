"""The KRC bundle's routes (UNIFIED_BUNDLE_GAMEPLAN.md). Writes are behind the same-site
check (utils/request_guard.py) like every KRC route.

GET  /krc/bundle/sections  -> {ok, sections: [{id, count}]}  (the Export dialog's counts)
POST /krc/bundle/export    {sections: [ids], selection: {id: subset}, includeLinked}
                           -> the bundle .zip (streamed from a temp file)
POST /krc/bundle/upload    the .zip (multipart) -> {ok, token, sections: [{id, counts, linkedOnly, known}]}
POST /krc/bundle/preview   {token, sections: [ids], mode, history} -> {ok, sections: {id: summary}}
POST /krc/bundle/import    {token, sections: [ids], mode, history} -> {ok, sections: {id: {summary, result}}}
POST /krc/bundle/discard   {token} -> {ok}  (the Import dialog was closed)
GET  /krc/bundle/undo      -> {ok, undo: {createdMs, sections, mode, fileName, changesSince} | null}
POST /krc/bundle/undo      -> {ok, sections, rows, files}  (Undo last import)
Each section's export / import date lands in the transfer history (key = section id).
"""
import asyncio
import json
import tempfile
import time
from pathlib import Path

from ..archive_guard import ArchiveGuardError
from ..import_worker import run_import
from ..library.transfer_history import log_transfer, size_text, stamp_transfer
from ..upload_limits import BUNDLE_UPLOAD_MAX, UploadTooLarge, save_upload
from .export import BundleExportError, export_bundle
from .importer import (
    BundleImportError, clean_leftovers, discard_upload, import_bundle, inspect_bundle, preview_bundle, store_upload,
    upload_path,
)
from .sections import all_sections
from .undo import UndoError, info as undo_info, undo as undo_last_import

_REGISTERED = False
_CHUNK = 1024 * 1024


def section_counts():
    """[{id, count}] for every section; count None when it couldn't be read."""
    out = []
    for section in all_sections():
        try:
            count = int(section.count())
        except Exception as exc:  # noqa: BLE001 - one section never hides the others
            print(f"[KRC Bundle] couldn't count {section.id}: {exc}")
            count = None
        out.append({"id": section.id, "count": count})
    return out


def _stamp(action, section_ids, mode=""):
    """Each section's date in the transfer history: the section id is its key, a keyed one
    ("kit_presets/<kit>", "pack/<pack>__<name>") as kind + item."""
    for section_id in section_ids:
        kind, _, item = section_id.partition("/")
        stamp_transfer(action, kind, mode, item) if item else stamp_transfer(action, section_id, mode)


def _import_summary(result):
    parts = []
    for section_id, entry in result.get("sections", {}).items():
        counts = ", ".join(f"{key}={value}" for key, value in (entry.get("result") or {}).items())
        parts.append(f"{section_id} [{counts}]")
    files = result.get("files", {})
    return f"{'; '.join(parts)}; thumbnails placed={files.get('placed', 0)}"


async def _json_body(request):
    try:
        payload = await request.json()
    except (ValueError, json.JSONDecodeError):
        payload = {}
    return payload if isinstance(payload, dict) else {}


def _summary(manifest):
    parts = []
    for section_id, entry in manifest.items():
        counts = ", ".join(f"{key}={value}" for key, value in (entry.get("counts") or {}).items())
        parts.append(f"{section_id}{' (linked)' if entry.get('linkedOnly') else ''} [{counts}]")
    return "; ".join(parts)


def register_bundle_routes():
    """Idempotent; called once from NodePack's __init__."""
    global _REGISTERED
    if _REGISTERED:
        return
    from aiohttp import web
    from server import PromptServer

    routes = PromptServer.instance.routes
    try:
        clean_leftovers()  # what an interrupted import or an abandoned dialog left behind
    except Exception as exc:  # noqa: BLE001 - never blocks KRC's start
        print(f"[KRC Bundle] couldn't clean leftovers: {exc}")

    @routes.get("/krc/bundle/sections")
    async def bundle_sections_route(_request):
        return web.json_response({"ok": True, "sections": await asyncio.to_thread(section_counts)})

    @routes.post("/krc/bundle/export")
    async def bundle_export_route(request):
        payload = await _json_body(request)
        with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as handle:
            path = Path(handle.name)
        try:
            manifest = await asyncio.to_thread(
                export_bundle, path, payload.get("sections") or [], payload.get("selection") or {},
                payload.get("includeLinked") is not False,
            )
        except BundleExportError as err:
            path.unlink(missing_ok=True)
            return web.json_response({"ok": False, "error": str(err)}, status=400)
        except Exception as err:  # noqa: BLE001
            path.unlink(missing_ok=True)
            log_transfer("export", "krc_bundle", False, summary=f"{type(err).__name__}: {err}")
            return web.json_response({"ok": False, "error": f"Export failed: {err}"}, status=500)

        size = path.stat().st_size
        log_transfer("export", "krc_bundle", True, summary=f"{size_text(size)}; {_summary(manifest)}")
        _stamp("export", list(manifest))
        name = f"krc_bundle_{time.strftime('%Y-%m-%d_%H%M')}.zip"
        response = web.StreamResponse(headers={
            "Content-Type": "application/zip",
            "Content-Disposition": f'attachment; filename="{name}"',
            "Content-Length": str(size),
        })
        try:
            await response.prepare(request)
            with path.open("rb") as handle:
                while True:
                    chunk = handle.read(_CHUNK)
                    if not chunk:
                        break
                    await response.write(chunk)
            await response.write_eof()
        finally:
            path.unlink(missing_ok=True)
        return response

    @routes.post("/krc/bundle/upload")
    async def bundle_upload_route(request):
        try:
            path = await save_upload(request, BUNDLE_UPLOAD_MAX, ".zip")
        except UploadTooLarge as err:
            return web.json_response({"ok": False, "error": str(err)}, status=413)
        if path is None:
            return web.json_response({"ok": False, "error": "Missing bundle file"}, status=400)
        token = await asyncio.to_thread(store_upload, path)
        try:
            sections = await asyncio.to_thread(inspect_bundle, upload_path(token))
        except (BundleImportError, ArchiveGuardError) as err:
            discard_upload(token)
            return web.json_response({"ok": False, "error": str(err)}, status=400)
        except Exception as err:  # noqa: BLE001
            discard_upload(token)
            return web.json_response({"ok": False, "error": f"Couldn't read the bundle: {err}"}, status=400)
        return web.json_response({"ok": True, "token": token, "sections": sections})

    @routes.post("/krc/bundle/preview")
    async def bundle_preview_route(request):
        payload = await _json_body(request)
        try:
            result = await run_import(preview_bundle, upload_path(payload.get("token")), payload.get("sections") or [],
                                      str(payload.get("mode") or "merge"), payload.get("history") is not False, payload.get("promptProfile"))
        except (BundleImportError, ArchiveGuardError, ValueError, UnicodeDecodeError) as err:
            return web.json_response({"ok": False, "error": str(err)}, status=400)
        except Exception as err:  # noqa: BLE001
            return web.json_response({"ok": False, "error": f"Preview failed: {err}"}, status=500)
        return web.json_response({"ok": True, **result})

    @routes.post("/krc/bundle/import")
    async def bundle_import_route(request):
        payload = await _json_body(request)
        token = payload.get("token")
        mode = str(payload.get("mode") or "merge")
        try:
            path = upload_path(token)
            result = await run_import(import_bundle, path, payload.get("sections") or [], mode,
                                      payload.get("history") is not False, str(payload.get("fileName") or ""), payload.get("promptProfile"))
        except (BundleImportError, ArchiveGuardError, UndoError, ValueError, UnicodeDecodeError) as err:
            log_transfer("import", "krc_bundle", False, mode=mode, summary=str(err))
            return web.json_response({"ok": False, "error": str(err)}, status=400)
        except Exception as err:  # noqa: BLE001
            log_transfer("import", "krc_bundle", False, mode=mode, summary=f"{type(err).__name__}: {err}")
            return web.json_response({"ok": False, "error": f"Import failed: {err}"}, status=500)
        discard_upload(token)
        log_transfer("import", "krc_bundle", True, mode=mode, summary=_import_summary(result))
        _stamp("import", list(result["sections"]), mode)
        return web.json_response({"ok": True, **result})

    @routes.get("/krc/bundle/undo")
    async def bundle_undo_info_route(_request):
        return web.json_response({"ok": True, "undo": await asyncio.to_thread(undo_info)})

    @routes.post("/krc/bundle/undo")
    async def bundle_undo_route(_request):
        try:
            result = await run_import(undo_last_import)
        except UndoError as err:
            return web.json_response({"ok": False, "error": str(err)}, status=400)
        except Exception as err:  # noqa: BLE001
            log_transfer("undo", "krc_bundle", False, summary=f"{type(err).__name__}: {err}")
            return web.json_response({"ok": False, "error": f"Undo failed: {err}"}, status=500)
        log_transfer("undo", "krc_bundle", True,
                     summary=f"{', '.join(result['sections'])}; rows={result['rows']}, files={result['files']}")
        return web.json_response({"ok": True, **result})

    @routes.post("/krc/bundle/discard")
    async def bundle_discard_route(request):
        discard_upload((await _json_body(request)).get("token"))
        return web.json_response({"ok": True})

    _REGISTERED = True
