import asyncio
import json
from pathlib import Path

from aiohttp import web

from ..card_sync import notify_card_write

try:
    from server import PromptServer
except ImportError:
    PromptServer = None

from .. import krc_video
from ..library.usage_stats import load_usage_section
from .identity import IdentityStore
from .materialize import enqueue as enqueue_materialize, regenerate as materialize_regenerate
from .identity_records import last_known_identity, purge_missing_identity, stale_identity_records
from .library_index import LoraLibraryIndex
from ..library.response_work import prepare_library_response
from ..library.thumbnail_sizes import parse_width, thumbnail_to_serve
from ..library.thumbnails import thumbnail_cache_headers, thumbnail_listing_scope
from .presets import FolderColorStore, PresetStore
from ..preset_naming import GROUP_ACTIONS, group_action_answer
from ..krc_video_settings import load_settings, save_settings
from .thumbnails import find_thumbnail_variant
from ..bundle.sections import register_section
from .zip import bundle_sections
from .write_handlers import (
    blank_lora_metadata,
    lora_thumbnail_delete,
    lora_thumbnail_refresh_source,
    lora_thumbnail_upload,
    lora_thumbnail_upload_video,
    save_lora_metadata,
)
from .serialize import (
    _join_civitai_not_found,
    seed_unstabilized_lora,
    _serialize_lora,
)
from .stabilize import stabilize_lora_by_id
from .civitai_fetch import fetch_lora_from_civitai


_ROUTES_REGISTERED = False
# Live backend metadata (library/detail/presets/missing) must never be served from
# a browser or reverse-proxy cache: two clients on the same ComfyUI instance share
# this data, and a stale cached read desyncs one client's dirty-state baseline from
# the other (false "modified" with no edits). These GETs have no ETag, so no-store
# is the correct, unambiguous directive — always fetch the current server state.
_NO_STORE = {"Cache-Control": "no-store"}


def register_routes():
    global _ROUTES_REGISTERED

    if PromptServer is None or _ROUTES_REGISTERED:
        return

    _ROUTES_REGISTERED = True

    # This node's KRC bundle sections (UNIFIED_BUNDLE_GAMEPLAN.md).
    for section in bundle_sections():
        register_section(section)

    routes = PromptServer.instance.routes

    @routes.get("/krc/lora-loadout/library")
    async def get_library(request):
        force = request.query.get("refresh", "").lower() in ("1", "true", "yes")
        index = await LoraLibraryIndex.loaded(force=force)

        def prepare():
            records = {key: dict(record) for key, record in tuple(index.records.items())}
            folder_store = FolderColorStore().load()
            folder_colors = folder_store["folders"]
            pinned_set = set(folder_store["pinned"])
            folders = {}
            root_count = 0
            loras = []

            # One listing per thumbnail dir for the whole list, not a stat per LoRA per variant.
            with thumbnail_listing_scope():
                for record in records.values():
                    sidecar = record.get("sidecar_data") or {}
                    folder = record.get("folder") or ""
                    if folder:
                        folders[folder] = folders.get(folder, 0) + 1
                    else:
                        root_count += 1
                    loras.append(_serialize_lora(
                        record,
                        sidecar,
                        folder_colors,
                        include_heavy_text=False,
                        include_detail_fields=False,
                    ))

            # Join in the silent usage ledger (one file read for the whole list) so the
            # browser can later sort by Most Used / Last Used. Unseen ids read as zero.
            usage_map = load_usage_section("loras")
            for item in loras:
                stats = usage_map.get(item.get("sha256") or "")
                item["useCount"] = int(stats.get("count") or 0) if isinstance(stats, dict) else 0
                item["lastUsedMs"] = int(stats.get("lastUsedMs") or 0) if isinstance(stats, dict) else 0
            _join_civitai_not_found(loras)

            loras.sort(key=lambda item: item["display_name"].lower())
            # Fixed scope rows first: All LoRAs (everything), then Root (LoRAs sitting
            # directly in the root folder, no subfolder) when any exist.
            folder_rows = [{"name": "loras", "count": len(loras), "cardColor": folder_colors.get("loras", ""), "scope": True, "pinned": False}]
            if root_count:
                folder_rows.append({"name": "__root__", "count": root_count, "cardColor": "", "scope": True, "pinned": False})
            # Real folders: pinned first, then alphabetical within each group.
            folder_items = sorted(folders.items(), key=lambda kv: (kv[0].lower(), kv[0]))
            folder_items.sort(key=lambda kv: kv[0] in pinned_set, reverse=True)
            folder_rows.extend(
                {"name": name, "count": count, "cardColor": folder_colors.get(name, ""), "scope": False, "pinned": name in pinned_set}
                for name, count in folder_items
            )
            aliases = IdentityStore().load().get("aliases", {})
            return web.json_response(
                # scanIds: which scan this list came from, so a page skips a krc-library-healed
                # push for a scan it already shows (path healing step 3).
                {"loras": loras, "folders": folder_rows, "scan": index.status(), "aliases": aliases,
                 "scanIds": {"loras": index.scan_id}},
                headers=_NO_STORE,
            )

        return await prepare_library_response(prepare)

    @routes.get("/krc/lora-loadout/detail/{sha256}")
    async def get_lora_detail(request):
        index = await LoraLibraryIndex.loaded()
        record = index.get(request.match_info["sha256"])
        if not record:
            return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)
        folder_store = FolderColorStore().load()
        # Lazy seed: the first time the user opens an unstabilized LoRA, freeze its
        # Date Added into a placeholder sidecar so a later edit/stabilization adopts it.
        record = seed_unstabilized_lora(record)
        sidecar = record.get("sidecar_data") or {}
        return web.json_response(
            _serialize_lora(
                record,
                sidecar,
                folder_store["folders"],
                include_heavy_text=True,
                include_detail_fields=True,
            ),
            headers=_NO_STORE,
        )

    @routes.get("/krc/lora-loadout/thumbnail/{sha256}")
    async def get_thumbnail(request):
        index = await LoraLibraryIndex.loaded()
        record = index.get(request.match_info["sha256"])
        if not record:
            # A missing thumbnail is normal (a LoRA with none), not an error.
            # 204 (not 404) lets the <img> onerror fall back to the placeholder
            # without the browser logging a 404 per thumbnail-less LoRA.
            return web.Response(status=204)
        try:
            sized = parse_width(request.query) is not None
        except ValueError as exc:
            return web.Response(status=400, text=str(exc))
        # ?w= (outside apps) always serves the static poster, scaled down.
        kind = "poster" if sized else request.query.get("kind", "")
        path = find_thumbnail_variant(record.get("library_id"), kind)
        if not path:
            return web.Response(status=204)
        path = await thumbnail_to_serve(path, request.query)
        return web.FileResponse(path, headers=thumbnail_cache_headers(request.query))

    @routes.post("/krc/lora-loadout/thumbnail/{sha256}")
    @notify_card_write("model")
    async def upload_thumbnail(request):
        return await lora_thumbnail_upload(request, request.match_info["sha256"])

    @routes.post("/krc/lora-loadout/thumbnail/{sha256}/upload-video")
    @notify_card_write("model")
    async def upload_video_thumbnail(request):
        return await lora_thumbnail_upload_video(request, request.match_info["sha256"])

    @routes.delete("/krc/lora-loadout/thumbnail/{sha256}")
    @notify_card_write("model")
    async def delete_thumbnail(request):
        return await lora_thumbnail_delete(request, request.match_info["sha256"])

    @routes.post("/krc/lora-loadout/thumbnail/{sha256}/refresh-source")
    @notify_card_write("model")
    async def refresh_thumbnail_from_source(request):
        return await lora_thumbnail_refresh_source(request, request.match_info["sha256"])


    @routes.get("/krc/lora-loadout/presets")
    async def get_presets(_request):
        return web.json_response(PresetStore().load(), headers=_NO_STORE)

    @routes.post("/krc/lora-loadout/presets")
    async def save_preset(request):
        payload = await request.json()
        preset = PresetStore().upsert(
            payload.get("id", ""),
            payload.get("group", ""),
            payload.get("name", ""),
            payload.get("loras", []),
            payload.get("stacks"),
            payload.get("stackEnabled"),
        )
        return web.json_response(preset)

    @routes.post("/krc/lora-loadout/folder-color")
    async def save_folder_color(request):
        payload = await request.json()
        data = FolderColorStore().save_folder(payload.get("folder", "loras"), payload.get("cardColor", ""))
        return web.json_response({"ok": True, **data})

    @routes.post("/krc/lora-loadout/folder-pin")
    async def save_folder_pin(request):
        payload = await request.json()
        data = FolderColorStore().save_pin(payload.get("folder", ""), bool(payload.get("pinned")))
        return web.json_response({"ok": True, **data})

    @routes.post("/krc/lora-loadout/metadata/blank/{sha256}")
    @notify_card_write("model")
    async def blank_metadata(request):
        body, status = await blank_lora_metadata(request.match_info["sha256"])
        return web.json_response(body, status=status)

    @routes.post("/krc/network/consent")
    async def set_network_consent(request):
        # Sync the global network-consent master switch from the ComfyUI setting so the
        # server-side egress guard can read it. Registered here (runs at import) though
        # the flag is pack-global.
        from ..krc_network import set_network_enabled
        from ..request_guard import refuse_cross_site
        refused = refuse_cross_site(request, "Network")
        if refused:
            status, body = refused
            return web.json_response(body, status=status)
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        value = bool(payload.get("allowInternet", False))
        set_network_enabled(value)
        return web.json_response({"ok": True, "allowInternet": value})

    @routes.post("/krc/lora-loadout/log-names")
    async def set_log_names(request):
        # Sync the global "Log loaded LoRA names" option for the run-time loaders.
        from ..krc_log_settings import set_log_lora_names
        from ..request_guard import refuse_cross_site
        refused = refuse_cross_site(request, "LoRA logging")
        if refused:
            status, body = refused
            return web.json_response(body, status=status)
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        value = set_log_lora_names(bool(payload.get("enabled", False)) if isinstance(payload, dict) else False)
        return web.json_response({"ok": True, "enabled": value})

    @routes.get("/krc/lora-loadout/civitai/batch/targets")
    async def civitai_batch_targets(request):
        # Pre-run preview for the Portal's Civitai Fetch page: LoRA folders + which
        # LoRAs a fill-missing batch would touch and why the rest are skipped. No
        # network, no hashing. ?folder= absent = whole library; "" = the root folder.
        from .civitai_batch import build_targets_preview, normalize_folder

        folder = request.query.get("folder")
        scope_folder = normalize_folder(folder) if folder is not None else None
        subfolders = request.query.get("subfolders") in ("1", "true", "yes")
        loop = asyncio.get_event_loop()
        preview = await loop.run_in_executor(
            None, lambda: build_targets_preview(scope_folder, subfolders=subfolders)
        )
        preview["capability"] = krc_video.capability()
        return web.json_response(preview, headers=_NO_STORE)

    @routes.get("/krc/lora-loadout/civitai/batch/status")
    async def civitai_batch_status(_request):
        # The live job (full snapshot: summary + log ring + issues) and the persisted
        # last run — what a page shows when it (re)attaches.
        from .civitai_batch_job import status_payload

        return web.json_response(status_payload(), headers=_NO_STORE)

    @routes.post("/krc/lora-loadout/civitai/batch/start")
    async def civitai_batch_start(request):
        # Body: {folder?: str ("" = root; absent = whole library), subfolders, overwrite}.
        from .civitai_batch import normalize_folder
        from .civitai_batch_job import start_job

        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        payload = payload if isinstance(payload, dict) else {}
        folder = payload.get("folder")
        scope_folder = normalize_folder(folder) if isinstance(folder, str) else None
        body, status = await start_job(
            scope_folder,
            subfolders=payload.get("subfolders") is True,
            overwrite=payload.get("overwrite") is True,
        )
        return web.json_response(body, status=status)

    @routes.post("/krc/lora-loadout/civitai/batch/cancel")
    async def civitai_batch_cancel(_request):
        from .civitai_batch_job import cancel_job

        body, status = cancel_job()
        return web.json_response(body, status=status)

    @routes.post("/krc/lora-loadout/civitai/batch/clear-issues")
    async def civitai_batch_clear_issues(_request):
        from .civitai_batch_job import clear_issues

        body, status = clear_issues()
        return web.json_response(body, status=status)

    @routes.post("/krc/lora-loadout/civitai/fetch/{sha256}")
    @notify_card_write("model")
    async def civitai_fetch(request):
        # On-demand public Civitai by-hash fetch for one LoRA — the shared core
        # (fetch_lora_from_civitai) also backs Model Library's LoRA read-through.
        force = request.query.get("force") in ("1", "true", "yes")
        body, status = await fetch_lora_from_civitai(request.match_info["sha256"], force=force)
        return web.json_response(body, status=status)

    @routes.post("/krc/lora-loadout/hf/import/{sha256}")
    @notify_card_write("model")
    async def hf_import(request):
        # Import metadata from a HuggingFace repo the user pasted, onto the selected
        # LoRA. Consent-guarded inside the client (returns 'disabled' before any socket).
        # One public /resolve/ fetch of the model card, then a thin merge. Unlike the
        # Civitai path there is no by-hash identity — the repo is attached to whatever
        # LoRA is open, so a local- id is fine.
        from .hf_client import fetch_model_card
        from .hf_map import merge_hf_into_record, parse_hf_repo

        sha256 = request.match_info["sha256"]
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}

        repo = parse_hf_repo(payload.get("repo"))
        if not repo:
            return web.json_response(
                {"ok": False, "status": "invalid", "error": "Not a valid HuggingFace repo URL or author/model"},
                status=400,
            )

        index = await LoraLibraryIndex.loaded()
        record = index.get(sha256)
        if not record:
            return web.json_response({"ok": False, "status": "unavailable", "error": "Unknown LoRA"}, status=404)

        result = await fetch_model_card(repo)
        status = result.get("status")
        if status != "hit":
            # disabled / unavailable / not_found / error — nothing written, retry allowed.
            return web.json_response({"ok": False, "status": status, "detail": result.get("detail")})

        existing = record.get("sidecar_data") if isinstance(record.get("sidecar_data"), dict) else {}
        library_id = record.get("library_id") or sha256
        merge_hf_into_record(record.get("path"), library_id, existing, repo, result.get("card"))
        LoraLibraryIndex().refresh_record(library_id)
        return web.json_response({"ok": True, "status": "hit", "repo": repo})

    @routes.post("/krc/lora-loadout/presets/rename")
    async def rename_preset(request):
        payload = await request.json()
        store = PresetStore()
        # Addressed by id; fall back to resolving the legacy "old" name for a
        # browser tab that hasn't reloaded onto the id-primary client yet.
        preset_id = payload.get("id", "")
        if not preset_id and payload.get("old"):
            match = store.find_by_name("", payload.get("old"))
            preset_id = match.get("id", "") if match else ""
        result = store.rename(
            preset_id,
            payload.get("group", ""),
            payload.get("name", ""),
            payload.get("stacks"),
            payload.get("loras"),
            payload.get("stackEnabled"),
        )
        if result.get("ok"):
            status = 200
        elif result.get("error") == "exists":
            status = 409
        elif result.get("error") == "not_found":
            status = 404
        else:
            status = 400
        return web.json_response(result, status=status)

    # Group menu: POST .../presets/rename-group {from, to}, ungroup-group {group},
    # delete-group {group} (PRESET_GROUP_RENAME_GAMEPLAN.md).
    def group_route(action):
        async def handler(request):
            payload = await request.json()
            result, status = group_action_answer(PresetStore(), action, payload, "LoRA Loadout")
            return web.json_response(result, status=status)
        return handler

    for action in GROUP_ACTIONS:
        routes.post(f"/krc/lora-loadout/presets/{action}-group")(group_route(action))

    @routes.get("/krc/lora-loadout/missing")
    async def get_missing_all(_request):
        records = (await LoraLibraryIndex.loaded()).records
        return web.json_response({"items": stale_identity_records(records.keys())}, headers=_NO_STORE)

    @routes.delete("/krc/lora-loadout/missing")
    async def purge_missing_all(request):
        payload = await request.json()
        ids = payload.get("ids", []) if isinstance(payload, dict) else []
        if not isinstance(ids, list):
            return web.json_response({"error": "Expected ids list"}, status=400)

        index = await LoraLibraryIndex.loaded(force=True)
        records = index.records
        live = set(records.keys())
        deleted = []
        skipped = []
        for library_id in [str(item or "") for item in ids]:
            if not library_id:
                continue
            canonical = IdentityStore().canonical_id(library_id)
            if library_id in live or canonical in live or index.get(library_id):
                skipped.append(library_id)
                continue
            if purge_missing_identity(library_id):
                deleted.append(library_id)

        LoraLibraryIndex._cache = {}
        return web.json_response({"ok": True, "deleted": deleted, "skipped": skipped})

    @routes.get("/krc/lora-loadout/missing/{library_id}")
    async def get_missing(request):
        info = last_known_identity(request.match_info["library_id"])
        if not info:
            return web.json_response({"error": "Missing library id"}, status=400)
        return web.json_response(info, headers=_NO_STORE)

    @routes.get("/krc/lora-loadout/missing-thumbnail/{library_id}")
    async def get_missing_thumbnail(request):
        library_id = request.match_info["library_id"]
        kind = request.query.get("kind", "")
        index = await LoraLibraryIndex.loaded()
        record = index.get(library_id)
        owner = record
        owner_id = owner.get("library_id") if owner else library_id

        # kind=source: serve the raw video sidecar so the client can paint its first
        # frame with zero server transcode (fallback-ladder rung while a poster is
        # still materializing). aiohttp FileResponse honors Range requests natively.
        if kind == "source":
            source = (owner.get("sidecar_data") or {}).get("thumbnailSourcePath", "") if owner else ""
            if source and Path(source).exists():
                return web.FileResponse(source)
            return web.Response(status=204)

        thumb = find_thumbnail_variant(owner_id, kind)
        if thumb and thumb.exists():
            return web.FileResponse(thumb)

        # No artifact yet: kick off deferred, bounded materialization (per import
        # mode) for this viewport-visible card, then return 204 now. The card shows
        # its placeholder and picks up the real thumbnail on a later request.
        if owner:
            enqueue_materialize(owner, load_settings())
        # 204 (not 404): a missing tombstone thumbnail is normal; keeps the <img>
        # onerror placeholder without logging a browser 404.
        return web.Response(status=204)

    @routes.get("/krc/lora-loadout/settings")
    async def get_settings(_request):
        return web.json_response({
            "settings": load_settings(),
            "capability": krc_video.capability(),
        })

    @routes.post("/krc/lora-loadout/settings")
    async def post_settings(request):
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        return web.json_response({"settings": save_settings(payload)})

    @routes.post("/krc/lora-loadout/thumbnail/{sha256}/from-source")
    @notify_card_write("model")
    async def regenerate_thumbnail(request):
        # Explicit, forced re-pull of a LoRA's thumbnail from its recorded video
        # sidecar — the user chooses static (poster) or animated (webm + poster
        # fallback) at will. Regenerates even when an artifact already exists.
        index = await LoraLibraryIndex.loaded()
        record = index.get(request.match_info["sha256"])
        owner = record
        if not owner:
            return web.json_response({"error": "Unknown LoRA SHA256"}, status=404)
        try:
            payload = await request.json()
        except (ValueError, json.JSONDecodeError):
            payload = {}
        settings = load_settings()
        kind = payload.get("kind") or "poster"
        frame = payload.get("frame") or settings.get("posterFrame", "first")
        crf = payload.get("webmCrf", settings.get("webmCrf"))
        result = await materialize_regenerate(owner, kind, frame=frame, crf=crf)
        if result.get("ok"):
            LoraLibraryIndex().refresh_record(owner["library_id"])
        return web.json_response(result)

    @routes.post("/krc/lora-loadout/thumbnails/generate-missing")
    async def generate_missing_thumbnails(_request):
        # Bulk pre-generation: schedule the import-mode target for every video-source
        # LoRA still missing it. Feeds the same bounded queue, so "do all" drips
        # instead of spiking. (Lazy scroll would generate these too; this is the
        # explicit "don't make me scroll the whole library" convenience.)
        records = (await LoraLibraryIndex.loaded()).records
        settings = load_settings()
        owners = {rec["library_id"]: rec for rec in records.values() if rec}
        scheduled = sum(enqueue_materialize(owner, settings) for owner in owners.values())
        return web.json_response({"ok": True, "scheduled": scheduled})

    @routes.delete("/krc/lora-loadout/missing/{library_id}")
    async def purge_missing(request):
        library_id = request.match_info["library_id"]
        # Refuse to purge a LoRA that is actually present — this only cleans up
        # orphaned metadata for something no longer in the library.
        if (await LoraLibraryIndex.loaded()).get(library_id):
            return web.json_response({"error": "LoRA is present, not missing"}, status=409)
        purge_missing_identity(library_id)
        LoraLibraryIndex._cache = {}
        return web.json_response({"ok": True})

    @routes.delete("/krc/lora-loadout/presets")
    async def delete_preset(request):
        payload = await request.json()
        store = PresetStore()
        # Addressed by id; fall back to the legacy name for a not-yet-reloaded client.
        preset_id = payload.get("id", "")
        if not preset_id and payload.get("name"):
            match = store.find_by_name("", payload.get("name"))
            preset_id = match.get("id", "") if match else ""
        deleted = store.delete(preset_id)
        return web.json_response({"ok": deleted})

    @routes.post("/krc/lora-loadout/stabilize/{library_id}")
    async def stabilize_lora(request):
        # Promote a path-derived (local-) id to a content sha without touching any
        # metadata fields. Idempotent; Model Library's LoRA read-through shares the body.
        body, status = await stabilize_lora_by_id(request.match_info["library_id"])
        return web.json_response(body, status=status)

    @routes.post("/krc/lora-loadout/metadata")
    @notify_card_write("model")
    async def save_metadata(request):
        payload = await request.json()
        body, status = await save_lora_metadata(payload)
        return web.json_response(body, status=status)
