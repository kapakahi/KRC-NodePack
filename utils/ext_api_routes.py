"""Routes for the KRC external API (KRC_EXTERNAL_API_GAMEPLAN.md).

Public, for outside apps (the contract, versioned under ``/krc/ext/v1``; every handler is
wrapped in ``guarded``, so none can skip the switch and key check):

    GET  /krc/ext/v1/info          -> pack, versions, capabilities, dbId, packs, kits, palettes
    GET  /krc/ext/v1/prompts[?fields=a,b] -> {"revision", "prompts": {category: {name: record}}}
                                      (text deferred; the get-prompts shape)
    GET  /krc/ext/v1/prompts/{id}  -> {"id", "matches": [full record, …]} (404 when none)
    POST /krc/ext/v1/prompts/detail {"ids": [...]} -> {"prompts": {id: [full record, …]},
                                       "missing": [...], "revision"}  (at most MAX_DETAIL_IDS)
    GET  /krc/ext/v1/search/prompts?q=[&offset=][&limit=][&fields=]
                                   -> {"revision", "total", "offset", "limit", "items": [...]}
    GET  /krc/ext/v1/revisions     -> {"dbId", "rev", "stores": {...}, "scans": {...}}
    GET  /krc/ext/v1/presets[?kind=ll|cs|wb|kit:<id>][&full=1]
                                   -> {"presets": [{kind, id, group, name, modified[, payload]}],
                                       "revisions": {kind: n}}
    GET  /krc/ext/v1/changes?since=<rev>[&stores=a,b][&dbId=…]
                                   -> {"dbId", "rev", "complete", "more", "changes": [...]}
    GET  /krc/ext/v1/models[?type=a,b][&fields=a,b]
                                   -> {"scans", "total", "items", "folders", "aliases", "collections"}
    GET  /krc/ext/v1/models/{id}   -> {"id", "model", "scans"} (404 when none)
    POST /krc/ext/v1/models/detail {"ids": [...]} -> {"models": {id: row}, "missing", "scans"}
    GET  /krc/ext/v1/search/models?q=[&offset=][&limit=][&fields=][&type=][&nameMode=]
                                   -> {"scans", "total", "offset", "limit", "items": [...]}
    POST /krc/ext/v1/models/resolve {"refs": [...]} -> {"results": [...], "scans"}
    (the model bodies live in ext_api_models.py)
    GET  /krc/ext/v1/media[?view=input|output][&fields=]
                                   -> {"revision", "presetsRevision", "total", "items", "folders"}
    GET  /krc/ext/v1/media/{id}    -> {"id", "item", "revision", "presetsRevision"} (404 when none)
    POST /krc/ext/v1/media/detail {"ids": [...]} -> {"items": {id: item}, "missing", "revision", "presetsRevision"}
    GET  /krc/ext/v1/search/media?q=[&view=][&folder=][&kind=][&sort=][&offset=][&limit=][&fields=]
                                   -> {"revision", "presetsRevision", "total", "offset", "limit", "items"}
    (the Media bodies live in ext_api_media.py; Media presets are /presets?kind=media)

Writes: refused while Read only is on (403 read_only; the master switch, on by default),
then per area: Media (403 media_writes_disabled) and Loadout presets (403
loadout_writes_disabled), each off by default.

    POST /krc/ext/v1/resizer/previews {source} -> {"preview", "prepared"}   (reads; ext_api_resizer.py,
    GET  /krc/ext/v1/resizer/previews/{handle} -> {"preview"}               with the Extras provider)
    GET  /krc/ext/v1/resizer/previews/{handle}/frames/{index} -> image/jpeg
    POST /krc/ext/v1/resizer/inputs {handle | source, settings} -> {"inputs", "settings", "source"}
    POST /krc/ext/v1/resizer/settings {inputs, handle? | source?} -> {"settings", "source", "stale"?, "fallback"?}
    POST /krc/ext/v1/workflows/branches {workflow} -> {"standbyRecord", "resizers"}   (stateless reads;
    POST /krc/ext/v1/workflows/prepare {workflow, enabled} -> {"workflow", "resizers"}  ext_api_workflows.py)
    GET  /krc/ext/v1/kits          -> {"kits": {id: descriptor}}   (a read; ext_api_loadout.py)
    GET  /krc/ext/v1/kits/{id}/descriptor -> {"descriptor"}
    POST /krc/ext/v1/presets/{kind} {group?, name, payload?} -> 201 {"preset", "revision"}  (kind ll | kit:<id>)
    POST /krc/ext/v1/presets/{kind}/{id}/update {version, group?, name?, payload?}
    POST /krc/ext/v1/presets/{kind}/{id}/rename {version, name, group?}
    POST /krc/ext/v1/presets/{kind}/{id}/delete {version}

Media writes (ext_api_media_writes.py):

    POST /krc/ext/v1/media/upload  multipart "file" (+ "settings" JSON) -> 201 {"id", "item"}
                                      | 202 {"id", "job"}
    GET  /krc/ext/v1/media/jobs/{id}  -> {"job"} (an upload's conversion; a read)
    POST /krc/ext/v1/media/presets {"name"?} -> 201 {"preset", "presetsRevision"}
    POST /krc/ext/v1/media/presets/{id}/rename {"name", "version"} -> {"preset", "presetsRevision"}
    POST /krc/ext/v1/media/presets/{id}/slots/{index} {"item", "version"} -> {"preset", "presetsRevision"}
                                      (409 conflict + the current preset when version is stale)
    POST /krc/ext/v1/media/presets/{id}/delete {"version"} -> {"deleted", "presetsRevision"}
    POST /krc/ext/v1/media/jobs/{id}/cancel -> {"cancelled", "job"}
    POST /krc/ext/v1/media/{id}/update {name?, folder?, favorite?, pinned?, color?, customBadge?, nsfw?, version?}
    POST /krc/ext/v1/media/{id}/delete {version?}
    POST /krc/ext/v1/media/bulk[/preview] {operation: move|delete, ids, destination?, confirmed?}
    POST /krc/ext/v1/media/bulk-attributes {ids, field, value}
    POST /krc/ext/v1/media/purge[/preview] {scope, ids?, snapshot?, confirmed?}
    POST /krc/ext/v1/media/folders {name, view?}
    POST /krc/ext/v1/media/folders/{id}/update {name?, color?, keep?, pinned?, version?}
    POST /krc/ext/v1/media/folders/{id}/delete {version?}
    POST /krc/ext/v1/media/folders/{id}/purge {confirmed: true, version?}

Internal, for KRC Portal ▸ Options ▸ Network only (not part of ext/v1):

    GET  /krc/ext-api/state        -> {"enabled", "hasKey", "keyHint"} (never the key)
    POST /krc/ext-api/consent      {"enabled": bool} -> state (+ "key" when this made it)
    POST /krc/ext-api/new-key      -> state + "key" (the old key stops working)
    POST /krc/ext-api/read-only    {"enabled": bool} -> state (the Read only master switch)
    POST /krc/ext-api/media-writes {"enabled": bool} -> state (Media uploads and presets)
    POST /krc/ext-api/loadout-writes {"enabled": bool} -> state (Loadout presets)
    The POSTs only accept ComfyUI's own page (request_guard; stage 16).
"""
import asyncio
import functools

from . import ext_api
from .request_guard import refuse_cross_site

# What this build's ext/v1 offers; a client checks it instead of the pack version.
# "thumbnails.sizes": the Prompt Vault / LoRA Loadout / Model Library thumbnail routes take
# ?w= (utils/library/thumbnail_sizes.py SIZES). "palettes": /info's palette fields
# (utils/library/palettes.py), and each KRC node's palette in API exports (_meta.krc_palette).
# "models.*" / "search.models": the Model Library (ext_api_models.py). "media.*" /
# "search.media": the Media (ext_api_media.py), with "presets.media" (kind "media" in
# /presets) and the "media" / "mediaPresets" stores in /revisions and /changes.
# "media.upload" / "presets.media.write" / "media.items.write" / "media.folders.write": the
# Media writes, available in this build; whether the user allows them is /info's
# permissions. "readOnlyMode": the Read only master switch exists (permissions.readOnly).
# "kits.descriptors" / "presets.loadout.write": Loadout Kit descriptors and LoRA Loadout /
# kit preset writes (ext_api_loadout.py; permissions.loadoutWrites).
# "prompts.profiles.meta": each Prompt Vault node's profile in API exports
# (_meta.krc_prompt_profile / krc_prompt_profile_resolved). "prompts.profiles.changes": the
# "promptProfiles" store in /revisions and /changes (profiles made, renamed, deleted).
# "permissionAreas": /info's permissionAreas registry (ext_api.WRITE_AREAS).
# "prompts.categories": GET /prompt-categories; "prompts.versions": a version on every prompt
# read; "models.marksVersion": marksVersion on Model Library rows. Writes (ext_api_prompts.py):
# "cards.marks.write" (area cardMarks), "prompts.categories.write" (promptCategories),
# "prompts.write" (promptEditing). "workflows.standby": standby branches recorded in API exports
# (_meta.krc_standby) and /workflows/branches + /workflows/prepare (ext_api_workflows.py).
CAPABILITIES = ["info", "prompts.list", "prompts.fields", "prompts.byId", "prompts.detail", "revisions", "changes",
                "thumbnails.sizes", "presets", "search.prompts", "prompts.profiles", "palettes",
                "models.list", "models.detail", "search.models", "models.resolve",
                "media.list", "media.detail", "search.media", "presets.media",
                "media.upload", "presets.media.write", "media.items.write", "media.folders.write",
                "readOnlyMode", "kits.descriptors", "presets.loadout.write",
                "prompts.profiles.meta", "prompts.profiles.changes",
                "permissionAreas", "prompts.categories", "prompts.versions", "models.marksVersion",
                "cards.marks.write", "prompts.categories.write", "prompts.write",
                "workflows.standby"]
MAX_DETAIL_IDS = 200
SEARCH_LIMIT_DEFAULT = 50
SEARCH_LIMIT_MAX = 500

_NO_STORE = {"Cache-Control": "no-store"}
_ROUTES_REGISTERED = False


def _pack_version():
    try:
        from .. import __version__
        return __version__
    except Exception:  # noqa: BLE001
        return ""


def _packs():
    try:
        from .krc_packs import krc_packs
        return krc_packs()
    except Exception:  # noqa: BLE001
        return []


def _kits():
    try:
        from .loadout_kit.kit import all_kits
        return [{"id": kit_id, "label": kit.label, "shortLabel": kit.short_label}
                for kit_id, kit in sorted(all_kits().items())]
    except Exception:  # noqa: BLE001
        return []


def info():
    """The body of GET /krc/ext/v1/info."""
    from .library.thumbnail_sizes import SIZES

    return {
        "pack": "krc-nodepack",
        "packVersion": _pack_version(),
        "extApi": ext_api.EXT_API_VERSION,
        # This build's, plus those registered providers bring (ext_api_providers.py).
        "capabilities": [*CAPABILITIES, *_provider_capabilities()],
        "providers": _provider_info(),
        "dbId": ext_api.db_id(),
        "packs": _packs(),
        "kits": _kits(),
        "thumbnailSizes": list(SIZES),
        **_palettes(),
        # What the user allows (capabilities say what this build has).
        "permissions": ext_api.permissions(),
        # Every write area, so a client can show one it doesn't know yet (ext_api.WRITE_AREAS).
        "permissionAreas": ext_api.permission_areas(),
    }


def _provider_capabilities():
    try:
        from .ext_api_providers import provider_capabilities
        return provider_capabilities()
    except Exception:  # noqa: BLE001
        return []


def _provider_info():
    try:
        from .ext_api_providers import provider_info
        return provider_info()
    except Exception:  # noqa: BLE001
        return {}


def _palettes():
    """/info's palette fields: the list, the global palette and the Portal's (as applied), and
    what to use for Native off a node (it shows the node's own colour, so with none behind
    it a surface uses this)."""
    try:
        from .library.palettes import NATIVE_FALLBACK_ID, global_palette, palette_list, portal_palette, read_settings

        settings = read_settings()
        return {"palettes": palette_list(), "globalPalette": global_palette(settings),
                "portalPalette": portal_palette(settings), "paletteNativeFallback": NATIVE_FALLBACK_ID}
    except Exception:  # noqa: BLE001
        return {"palettes": [], "globalPalette": "", "portalPalette": "", "paletteNativeFallback": ""}


def prompt_list(fields_param="", profile_id="default"):
    """The body of GET /krc/ext/v1/prompts: the Prompt Vault library as get-prompts answers
    it (text deferred; fetch text with /prompts/detail), only ``fields`` when given, plus the
    ``prompts`` revision it was read at."""
    from .prompt_vault_serialization import parse_fields, prompts_for_response, select_fields
    from .prompt_vault_store import load_prompts_with_revision

    try:
        fields = parse_fields(fields_param)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    try:
        revision, library = load_prompts_with_revision(profile_id)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    from .ext_api_prompts import add_versions

    # Every prompt carries its version (capability "prompts.versions"), fields= or not.
    return {"revision": revision,
            "prompts": add_versions(select_fields(prompts_for_response(library, profile_id=profile_id), fields), library)}


def _int_param(value, name, default, low, high):
    raw = str(value if value is not None else "").strip()
    if not raw:
        return default
    try:
        number = int(raw)
    except ValueError:
        raise BadRequest(f"{name} must be a whole number") from None
    if not low <= number <= high:
        raise BadRequest(f"{name} must be from {low} to {high}")
    return number


def prompt_search(query="", offset="", limit="", fields_param="", profile_id="default"):
    """The body of GET /krc/ext/v1/search/prompts: Prompt Vault's in-node search on the
    server (the same key:value syntax and matches; utils/prompt_vault_search.py), ordered by
    category then name, a page at a time. Items are ``{category, name, ...record}`` with text
    held back (fetch it with /prompts/detail); ``fields`` keeps only those record fields
    (category and name always stay). ``total`` counts every match."""
    from .prompt_vault_search import library_items, search_items
    from .prompt_vault_serialization import parse_fields, prompts_for_response
    from .prompt_vault_store import load_prompts_with_revision

    offset = _int_param(offset, "offset", 0, 0, 10**9)
    limit = _int_param(limit, "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX)
    try:
        fields = parse_fields(fields_param)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    try:
        revision, library = load_prompts_with_revision(profile_id)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    # Match on the full records (prompt: searches Prompt A / B), answer with the list's
    # records (text held back), as /prompts does.
    found = search_items(library_items(library), query)
    response = prompts_for_response(library, profile_id=profile_id)
    page = [{"category": item["category"], "name": item["name"], **response[item["category"]][item["name"]]}
            for item in found[offset:offset + limit]]
    if fields is not None:
        keep = fields | {"category", "name"}
        page = [{key: value for key, value in item.items() if key in keep} for item in page]
    from .ext_api_prompts import prompt_version
    for item in page:
        item["version"] = prompt_version(item["category"], item["name"], library[item["category"]][item["name"]])
    return {"revision": revision, "total": len(found), "offset": offset, "limit": limit, "items": page}


def prompt_matches(record_id):
    """The body of GET /krc/ext/v1/prompts/{id}, or None when no prompt has that id. Every
    match, ordered by category then name (copies can share an id); a client wanting one
    takes matches[0]."""
    from .prompt_vault_serialization import prompt_detail
    from .prompt_vault_store import prompts_by_id

    matches = prompts_by_id(record_id)
    if not matches:
        return None
    from .ext_api_prompts import prompt_version

    return {"id": str(record_id).strip(),
            "matches": [{**prompt_detail(*match), "version": prompt_version(*match)} for match in matches]}


# The public store names (the contract) -> krc.db's `changes` store names (internal, free to
# change). Kit presets are added per registered kit under "kitPresets". `usage` is left out
# on purpose: it changes on every run, and nothing a client shows depends on it.
REVISION_STORES = {
    "prompts": "prompts",
    "llPresets": "presets:ll",
    "csPresets": "presets:cs",
    "wbPresets": "presets:wb",
    "wordBanks": "word_banks",
    "collections": "collections",
    "loraMetadata": "metadata:loras",
    "modelMetadata": "metadata:models",
    "media": "media",
    "mediaPresets": "presets:media",
    "promptProfiles": "prompt_profiles",
}


_KIT_PREFIX = "presets:kit:"
_PUBLIC_BY_INTERNAL = {internal: public for public, internal in REVISION_STORES.items()}
# Names a client may pass in ?stores=: every public store, plus groups.
STORE_GROUPS = {
    "presets": ["llPresets", "csPresets", "wbPresets", "kitPresets", "mediaPresets"],
    "library": ["loraMetadata", "modelMetadata", "collections"],
    "media": ["media", "mediaPresets"],
}
MAX_CHANGES = 1000


def store_revisions():
    """-> (stores, kitPresets, rev): every public store's revision (0 when it never changed),
    read in one query. ``rev`` is the newest of them, the one number to compare first."""
    from .db import connection as db

    try:
        from .loadout_kit.kit import all_kits
        kit_ids = sorted(all_kits())
    except Exception:  # noqa: BLE001
        kit_ids = []
    with db.read() as conn:
        newest = dict(conn.execute("SELECT store, MAX(rev) FROM changes GROUP BY store").fetchall())
    stores = {public: int(newest.get(internal) or 0) for public, internal in REVISION_STORES.items()}
    kits = {kit_id: int(newest.get(f"presets:kit:{kit_id}") or 0) for kit_id in kit_ids}
    return stores, kits, max([0, *stores.values(), *kits.values()])


def _library_index(lineage):
    """The library index class for `lineage`: plain imports, inside the function so the
    libraries load only when asked (and no import cycle at start)."""
    if lineage == "loras":
        from .lora_loadout.library_index import LoraLibraryIndex
        return LoraLibraryIndex
    from .model_library.library_index import ModelLibraryIndex
    return ModelLibraryIndex


async def scan_tokens():
    """{"loras": token, "models": token}: changes when that library was rescanned (files
    added, moved, removed) or a record changed in place. Asking runs the library's usual
    folder check (cheap, at most every few seconds), so files changed on disk are noticed;
    a cold library scans first, on a worker thread. "" when a library can't be read."""
    tokens = {}
    for lineage in ("loras", "models"):
        try:
            tokens[lineage] = (await _library_index(lineage).loaded()).change_token()
        except Exception as exc:  # noqa: BLE001
            print(f"[KRC External API] couldn't read the {lineage} library: {exc}")
            tokens[lineage] = ""
    return tokens


async def revisions():
    """The body of GET /krc/ext/v1/revisions."""
    stores, kits, rev = store_revisions()
    return {"dbId": ext_api.db_id(), "rev": rev, "stores": {**stores, "kitPresets": kits},
            "scans": await scan_tokens()}


class BadRequest(ValueError):
    """A request ext/v1 refuses with 400 (the message says why)."""


# Fields every preset kind shares (preset-group-stored-field); the rest is its payload.
_PRESET_HEAD = ("id", "group", "name", "modified")


def _preset_stores():
    """{kind: store} for every preset kind: ll, cs, wb, media, and kit:<id> per registered
    kit. Each store normalizes its records on load, so listings match what the nodes see."""
    from .config_switcher_presets import ConfigSwitcherPresetStore
    from .ext_api_media import MediaPresetStore
    from .lora_loadout.presets import PresetStore
    from .word_bank_presets import WordBankPresetStore

    stores = {"ll": PresetStore(), "cs": ConfigSwitcherPresetStore(), "wb": WordBankPresetStore(),
              "media": MediaPresetStore()}
    try:
        from .loadout_kit.kit import all_kits
        for kit_id, kit in sorted(all_kits().items()):
            stores[f"kit:{kit_id}"] = kit.presets()
    except Exception:  # noqa: BLE001
        pass
    return stores


def preset_list(kind="", full=False):
    """The body of GET /krc/ext/v1/presets: every preset of every kind (or one ``kind``),
    as ``{kind, id, group, name, modified}``; ``full`` adds ``payload`` (everything else:
    stacks, fields, configs, rows). All kinds are read at one moment, with each kind's
    revision (the /revisions numbers), so a client can cache per kind."""
    from .db import connection as db
    from .db.presets import change_store
    from .ext_api_loadout import is_loadout_kind, preset_version

    stores = _preset_stores()
    kind = str(kind or "").strip()
    if kind and kind not in stores:
        raise BadRequest(f"Unknown preset kind {kind!r} (one of {', '.join(stores)})")
    kinds = [kind] if kind else list(stores)
    presets, revisions = [], {}
    with db.read() as conn:
        for name in kinds:
            revisions[name] = db.revision(change_store(name), conn)
            for record in stores[name].load().get("presets") or []:
                if not isinstance(record, dict):
                    continue
                entry = {"kind": name, **{key: record.get(key, "" if key != "modified" else 0) for key in _PRESET_HEAD}}
                if full:
                    entry["payload"] = {key: value for key, value in record.items() if key not in _PRESET_HEAD}
                    if is_loadout_kind(name):
                        entry["payload"]["version"] = preset_version(name, record)
                presets.append(entry)
    return {"presets": presets, "revisions": revisions}


def _public_change(change):
    """A changes row in public names: kit presets are {"store": "kitPresets", "kit": id}."""
    store = change["store"]
    public = {"rev": change["rev"], "item": change["item"], "op": change["op"], "source": change["source"]}
    if store.startswith(_KIT_PREFIX):
        return {**public, "store": "kitPresets", "kit": store[len(_KIT_PREFIX):]}
    return {**public, "store": _PUBLIC_BY_INTERNAL.get(store, store)}


def changes(since, stores_param="", client_db_id=""):
    """The body of GET /krc/ext/v1/changes. ``since`` is a revision the client saw (from
    /revisions or an earlier /changes); ``stores_param`` a comma list of public store names
    or groups (default: every public store; never usage). Collapsed per item, oldest first,
    at most MAX_CHANGES; with ``more`` the client asks again from ``rev``.

    ``complete: false`` (and no changes) means do a full resync: the log was trimmed past
    ``since``, ``since`` is ahead of this database, or ``client_db_id`` names another one."""
    from .db.changes import changes_since

    try:
        since = int(str(since).strip())
    except (TypeError, ValueError):
        raise BadRequest("since must be a revision number (0 for everything)") from None
    if since < 0:
        raise BadRequest("since must be a revision number (0 for everything)")
    wanted = [name.strip() for name in str(stores_param or "").split(",") if name.strip()]
    if not wanted:
        wanted = [*REVISION_STORES, "kitPresets"]
    public = []
    for name in wanted:
        group = STORE_GROUPS.get(name, [name])
        for member in group:
            if member != "kitPresets" and member not in REVISION_STORES:
                raise BadRequest(f"Unknown store {name!r}")
            if member not in public:
                public.append(member)
    db_id = ext_api.db_id()
    if client_db_id and client_db_id != db_id:
        newest = changes_since(0)["newest"]
        return {"dbId": db_id, "rev": newest, "complete": False, "more": False, "changes": []}
    result = changes_since(
        since,
        stores=[REVISION_STORES[name] for name in public if name != "kitPresets"],
        store_prefixes=[_KIT_PREFIX] if "kitPresets" in public else [],
        limit=MAX_CHANGES,
    )
    listed = [_public_change(change) for change in result["changes"]]
    # The next `since`: the last change listed when there are more, else the newest rev of
    # the same read (so a write landing after it is never skipped).
    rev = listed[-1]["rev"] if result["more"] else result["newest"]
    return {"dbId": db_id, "rev": rev, "complete": result["complete"], "more": result["more"], "changes": listed}


def prompt_details(ids):
    """The body of POST /krc/ext/v1/prompts/detail for a list of ids (strings, at most
    MAX_DETAIL_IDS; repeats are answered once). Every id maps to all its matches, the same
    rule as /prompts/{id}; all of them are read at one moment, given as ``revision``."""
    from .prompt_vault_serialization import prompt_details as details_for
    from .prompt_vault_store import prompts_by_ids

    if not isinstance(ids, list) or not all(isinstance(value, str) for value in ids):
        raise BadRequest("ids must be a list of strings")
    wanted = list(dict.fromkeys(value.strip() for value in ids if value.strip()))
    if len(wanted) > MAX_DETAIL_IDS:
        raise BadRequest(f"At most {MAX_DETAIL_IDS} ids per call")
    revision, found = prompts_by_ids(wanted)
    order = [(record_id, match) for record_id in wanted for match in found.get(record_id, [])]
    details = details_for([match for _record_id, match in order])
    from .ext_api_prompts import prompt_version

    prompts = {}
    for (record_id, match), detail in zip(order, details):
        prompts.setdefault(record_id, []).append({**detail, "version": prompt_version(*match)})
    return {
        "prompts": prompts,
        "missing": [record_id for record_id in wanted if record_id not in found],
        "revision": revision,
    }


def register_ext_api_routes():
    global _ROUTES_REGISTERED
    try:
        from server import PromptServer
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return
    if _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    from aiohttp import web

    routes = PromptServer.instance.routes

    def guarded(handler):
        """Every ext/v1 handler: refused (403 off, 401 key) before it runs."""
        @functools.wraps(handler)
        async def wrapper(request):
            try:
                refused = ext_api.refusal(request.headers.get("Authorization", ""))
                if refused:
                    status, body = refused
                    return web.json_response(body, status=status, headers=_NO_STORE)
                return await handler(request)
            except Exception as exc:  # storage/service failure; cancellation still propagates
                print(f"[KRC External API] {handler.__name__} failed: {type(exc).__name__}: {exc}")
                return web.json_response({"error": "internal_error", "message": "KRC could not read the requested data. Try again."},
                                         status=500, headers=_NO_STORE)
        return wrapper

    @routes.get("/krc/ext/v1/info")
    @guarded
    async def ext_v1_info(_request):
        return web.json_response(info(), headers=_NO_STORE)

    @routes.get("/krc/ext/v1/prompt-profiles")
    @guarded
    async def ext_v1_prompt_profiles(_request):
        from .prompt_profiles import list_profiles
        return web.json_response({"profiles": list_profiles()}, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/prompts")
    @guarded
    async def ext_v1_prompts(request):
        try:
            body = prompt_list(request.query.get("fields", ""), request.query.get("profile", "default"))
        except BadRequest as exc:
            return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/prompts/{id}")
    @guarded
    async def ext_v1_prompt(request):
        body = prompt_matches(request.match_info.get("id", ""))
        if body is None:
            return web.json_response({"error": "not_found", "message": "No prompt has that id."},
                                     status=404, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/revisions")
    @guarded
    async def ext_v1_revisions(_request):
        return web.json_response(await revisions(), headers=_NO_STORE)

    @routes.get("/krc/ext/v1/search/prompts")
    @guarded
    async def ext_v1_search_prompts(request):
        query = request.query
        try:
            body = prompt_search(query.get("q", ""), query.get("offset", ""), query.get("limit", ""),
                                 query.get("fields", ""), query.get("profile", "default"))
        except BadRequest as exc:
            return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/presets")
    @guarded
    async def ext_v1_presets(request):
        query = request.query
        full = str(query.get("full", "")).strip().lower() in ("1", "true", "yes")
        try:
            body = preset_list(query.get("kind", ""), full)
        except BadRequest as exc:
            return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/changes")
    @guarded
    async def ext_v1_changes(request):
        query = request.query
        try:
            body = changes(query.get("since", ""), query.get("stores", ""), query.get("dbId", "").strip())
        except BadRequest as exc:
            return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/prompts/detail")
    @guarded
    async def ext_v1_prompt_details(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = None
        try:
            body = prompt_details(payload.get("ids") if isinstance(payload, dict) else None)
        except BadRequest as exc:
            return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    # ---- the Model Library (ext_api_models.py) ---------------------------------------

    def bad_request(exc):
        return web.json_response({"error": "bad_request", "message": str(exc)}, status=400, headers=_NO_STORE)

    async def json_body(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return None
        return payload if isinstance(payload, dict) else None

    @routes.get("/krc/ext/v1/models")
    @guarded
    async def ext_v1_models(request):
        from .ext_api_models import model_list
        try:
            body = await model_list(request.query.get("type", ""), request.query.get("fields", ""))
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/models/{id}")
    @guarded
    async def ext_v1_model(request):
        from .ext_api_models import model_detail
        body = await model_detail(request.match_info.get("id", ""))
        if body is None:
            return web.json_response({"error": "not_found", "message": "No model has that id."},
                                     status=404, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/models/detail")
    @guarded
    async def ext_v1_model_details(request):
        from .ext_api_models import model_details
        payload = await json_body(request)
        try:
            body = await model_details(payload.get("ids") if payload else None)
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/search/models")
    @guarded
    async def ext_v1_search_models(request):
        from .ext_api_models import model_search
        query = request.query
        try:
            body = await model_search(query.get("q", ""), query.get("offset", ""), query.get("limit", ""),
                                      query.get("fields", ""), query.get("type", ""), query.get("nameMode", ""))
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/models/resolve")
    @guarded
    async def ext_v1_models_resolve(request):
        from .ext_api_models import resolve_models
        payload = await json_body(request)
        try:
            body = await resolve_models(payload.get("refs") if payload else None, (payload or {}).get("fields"))
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    # ---- the Media (ext_api_media.py) --------------------------------------------------

    @routes.get("/krc/ext/v1/media")
    @guarded
    async def ext_v1_media(request):
        from .ext_api_media import media_list
        try:
            body = await asyncio.to_thread(media_list, request.query.get("view", ""), request.query.get("fields", ""))
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/media/{id}")
    @guarded
    async def ext_v1_media_item(request):
        from .ext_api_media import media_item
        body = await asyncio.to_thread(media_item, request.match_info.get("id", ""))
        if body is None:
            return web.json_response({"error": "not_found", "message": "No Media item has that id."},
                                     status=404, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/media/detail")
    @guarded
    async def ext_v1_media_details(request):
        from .ext_api_media import media_details
        payload = await json_body(request)
        try:
            body = await asyncio.to_thread(media_details, payload.get("ids") if payload else None)
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/search/media")
    @guarded
    async def ext_v1_search_media(request):
        from .ext_api_media import media_search
        query = request.query
        try:
            body = await asyncio.to_thread(media_search, query.get("q", ""), query.get("view", ""), query.get("folder", ""),
                                           query.get("kind", ""), query.get("sort", ""), query.get("offset", ""),
                                           query.get("limit", ""), query.get("fields", ""))
        except BadRequest as exc:
            return bad_request(exc)
        return web.json_response(body, headers=_NO_STORE)

    # ---- Media writes (ext_api_media_writes.py) ----------------------------------------

    def write_gate(area):
        """A write of ``area`` (an ext_api.WRITE_AREAS id): refused while Read only is on (403
        read_only), then while the area isn't allowed for the key sent. Goes under
        ``guarded``, so the switch and key come first."""
        if area not in ext_api.WRITE_AREAS:
            raise KeyError(area)

        def decorate(handler):
            @functools.wraps(handler)
            async def wrapper(request):
                refused = ext_api.write_refusal(area, ext_api._bearer(request.headers.get("Authorization", "")))
                if refused:
                    status, body = refused
                    return web.json_response(body, status=status, headers=_NO_STORE)
                return await handler(request)
            return wrapper
        return decorate

    media_write = write_gate("media")

    def write_answer(work, status=200):
        """Run a preset write -> its JSON answer (``status``), or 400 / 404 / 409 (with the
        current preset)."""
        from .ext_api_media_writes import Conflict, NotFound
        try:
            return web.json_response(work(), status=status, headers=_NO_STORE)
        except BadRequest as exc:
            return bad_request(exc)
        except NotFound as exc:
            return web.json_response({"error": "not_found", "message": str(exc)}, status=404, headers=_NO_STORE)
        except Conflict as exc:
            return web.json_response({"error": "conflict", "message": str(exc), exc.kind: exc.current},
                                     status=409, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/media/upload")
    @guarded
    @media_write
    async def ext_v1_media_upload(request):
        from .ext_api_media_writes import upload
        status, body = await upload(request)
        return web.json_response(body, status=status, headers=_NO_STORE)

    @routes.get("/krc/ext/v1/media/jobs/{id}")
    @guarded
    async def ext_v1_media_job(request):
        from .ext_api_media_writes import NotFound, job
        try:
            return web.json_response(job(request.match_info.get("id", "")), headers=_NO_STORE)
        except NotFound as exc:
            return web.json_response({"error": "not_found", "message": str(exc)}, status=404, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/media/presets")
    @guarded
    @media_write
    async def ext_v1_media_preset_create(request):
        from .ext_api_media_writes import create_preset
        payload = await json_body(request)
        # On the loop, as the node's preset routes (their change announcements expect it).
        return write_answer(lambda: create_preset(payload if payload is not None else {}), 201)

    @routes.post("/krc/ext/v1/media/presets/{id}/rename")
    @guarded
    @media_write
    async def ext_v1_media_preset_rename(request):
        from .ext_api_media_writes import rename_preset
        payload = await json_body(request)
        return write_answer(lambda: rename_preset(request.match_info.get("id", ""), payload))

    @routes.post("/krc/ext/v1/media/presets/{id}/slots/{index}")
    @guarded
    @media_write
    async def ext_v1_media_preset_slot(request):
        from .ext_api_media_writes import set_slot
        payload = await json_body(request)
        return write_answer(lambda: set_slot(request.match_info.get("id", ""), request.match_info.get("index", ""), payload))

    def media_write_route(path, work, status=200, off_loop=True, gate=media_write):
        """Register a write: guarded, its area's gate, the JSON body (``{}`` when empty) and
        the URL's ids handed to ``work(match_info, payload)``. File / database work runs off
        the loop, as the node's routes do (page announcements are thread-safe)."""
        async def handler(request):
            payload = await json_body(request)
            payload = payload if payload is not None else {}
            info = {**dict(request.match_info), "_profile": request.query.get("profile", "default")}
            if off_loop:
                return await asyncio.to_thread(write_answer, lambda: work(info, payload), status)
            return write_answer(lambda: work(info, payload), status)
        handler.__name__ = "ext_v1_" + path.rsplit("/v1/", 1)[1].replace("/", "_").replace("{", "").replace("}", "").replace("-", "_")
        routes.post(path)(guarded(gate(handler)))

    def _writes():
        from . import ext_api_media_writes as writes
        return writes

    media_write_route("/krc/ext/v1/media/presets/{id}/delete", lambda m, p: _writes().delete_preset(m["id"], p), off_loop=False)
    media_write_route("/krc/ext/v1/media/jobs/{id}/cancel", lambda m, p: _writes().cancel_job(m["id"]), off_loop=False)
    media_write_route("/krc/ext/v1/media/{id}/update", lambda m, p: _writes().update_item(m["id"], p))
    media_write_route("/krc/ext/v1/media/{id}/delete", lambda m, p: _writes().delete_item(m["id"], p))
    media_write_route("/krc/ext/v1/media/bulk/preview", lambda m, p: _writes().bulk(p, preview=True))
    media_write_route("/krc/ext/v1/media/bulk", lambda m, p: _writes().bulk(p))
    media_write_route("/krc/ext/v1/media/bulk-attributes", lambda m, p: _writes().bulk_attributes(p))
    media_write_route("/krc/ext/v1/media/purge/preview", lambda m, p: _writes().purge(p, preview=True))
    media_write_route("/krc/ext/v1/media/purge", lambda m, p: _writes().purge(p))
    media_write_route("/krc/ext/v1/media/folders", lambda m, p: _writes().create_folder(p), status=201)
    media_write_route("/krc/ext/v1/media/folders/{id}/update", lambda m, p: _writes().update_folder(m["id"], p))
    media_write_route("/krc/ext/v1/media/folders/{id}/delete", lambda m, p: _writes().delete_folder(m["id"], p))
    media_write_route("/krc/ext/v1/media/folders/{id}/purge", lambda m, p: _writes().purge_folder(m["id"], p))

    # ---- Loadout: kit descriptors (reads) and preset writes (ext_api_loadout.py) ------------

    def _loadout():
        from . import ext_api_loadout as loadout
        return loadout

    @routes.get("/krc/ext/v1/kits")
    @guarded
    async def ext_v1_kits(_request):
        return web.json_response(_loadout().kit_descriptors(), headers=_NO_STORE)

    @routes.get("/krc/ext/v1/kits/{id}/descriptor")
    @guarded
    async def ext_v1_kit_descriptor(request):
        return write_answer(lambda: _loadout().kit_descriptor(request.match_info.get("id", "")))

    loadout_write = write_gate("loadoutPresets")
    media_write_route("/krc/ext/v1/presets/{kind}", lambda m, p: _loadout().create_preset(m["kind"], p),
                      status=201, gate=loadout_write)
    media_write_route("/krc/ext/v1/presets/{kind}/{id}/update", lambda m, p: _loadout().update_preset(m["kind"], m["id"], p),
                      gate=loadout_write)
    media_write_route("/krc/ext/v1/presets/{kind}/{id}/rename", lambda m, p: _loadout().rename_preset(m["kind"], m["id"], p),
                      gate=loadout_write)
    media_write_route("/krc/ext/v1/presets/{kind}/{id}/delete", lambda m, p: _loadout().delete_preset(m["kind"], m["id"], p),
                      gate=loadout_write)

    # ---- Prompt Vault and card marks (ext_api_prompts.py) ------------------------------

    def _prompts():
        from . import ext_api_prompts as prompts
        return prompts

    @routes.get("/krc/ext/v1/prompt-categories")
    @guarded
    async def ext_v1_prompt_categories(request):
        return write_answer(lambda: _prompts().category_list(request.query.get("profile", "default")))

    card_marks = write_gate("cardMarks")
    media_write_route("/krc/ext/v1/prompts/{id}/marks", lambda m, p: _prompts().prompt_marks(m["_profile"], m["id"], p),
                      gate=card_marks)

    @routes.post("/krc/ext/v1/models/{id}/marks")
    @guarded
    @card_marks
    async def ext_v1_model_marks(request):
        from .ext_api_media_writes import Conflict, NotFound
        payload = await json_body(request)
        try:
            body = await _prompts().model_marks(request.match_info.get("id", ""), payload if payload is not None else {})
        except BadRequest as exc:
            return bad_request(exc)
        except NotFound as exc:
            return web.json_response({"error": "not_found", "message": str(exc)}, status=404, headers=_NO_STORE)
        except Conflict as exc:
            return web.json_response({"error": "conflict", "message": str(exc), exc.kind: exc.current},
                                     status=409, headers=_NO_STORE)
        return web.json_response(body, headers=_NO_STORE)

    categories = write_gate("promptCategories")
    for action, status in (("create", 201), ("update", 200), ("rename", 200), ("delete", 200), ("purge", 200)):
        media_write_route(f"/krc/ext/v1/prompt-categories/{action}",
                          (lambda name: lambda m, p: getattr(_prompts(), f"category_{name}")(m["_profile"], p))(action),
                          status=status, gate=categories)

    editing = write_gate("promptEditing")
    media_write_route("/krc/ext/v1/prompts/create", lambda m, p: _prompts().prompt_create(m["_profile"], p),
                      status=201, gate=editing)
    media_write_route("/krc/ext/v1/prompts/{id}/update", lambda m, p: _prompts().prompt_update(m["_profile"], m["id"], p),
                      gate=editing)
    media_write_route("/krc/ext/v1/prompts/{id}/duplicate", lambda m, p: _prompts().prompt_duplicate(m["_profile"], m["id"], p),
                      status=201, gate=editing)
    media_write_route("/krc/ext/v1/prompts/{id}/delete", lambda m, p: _prompts().prompt_delete(m["_profile"], m["id"], p),
                      gate=editing)
    media_write_route("/krc/ext/v1/prompts/{id}/thumbnail", lambda m, p: _prompts().prompt_thumbnail(m["_profile"], m["id"], p),
                      gate=editing)
    media_write_route("/krc/ext/v1/prompts/{id}/thumbnail/clear",
                      lambda m, p: _prompts().prompt_thumbnail(m["_profile"], m["id"], p, clear=True), gate=editing)

    # ---- KRC Resizer (ext_api_resizer.py; the logic is the Extras provider's) -------------

    def _resizer():
        from . import ext_api_resizer as resizer
        return resizer

    def resizer_answer(result):
        status, body = result
        if isinstance(body, (bytes, bytearray)):
            return web.Response(body=bytes(body), content_type="image/jpeg",
                                headers={"Cache-Control": "private, max-age=3600"})
        return web.json_response(body, status=status, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/resizer/previews")
    @guarded
    async def ext_v1_resizer_prepare(request):
        payload = await json_body(request)
        return resizer_answer(await asyncio.to_thread(_resizer().prepare, payload))

    @routes.get("/krc/ext/v1/resizer/previews/{handle}")
    @guarded
    async def ext_v1_resizer_preview(request):
        return resizer_answer(await asyncio.to_thread(_resizer().preview, request.match_info.get("handle", "")))

    @routes.get("/krc/ext/v1/resizer/previews/{handle}/frames/{index}")
    @guarded
    async def ext_v1_resizer_frame(request):
        return resizer_answer(await asyncio.to_thread(
            _resizer().frame, request.match_info.get("handle", ""), request.match_info.get("index", "")))

    @routes.post("/krc/ext/v1/resizer/inputs")
    @guarded
    async def ext_v1_resizer_inputs(request):
        payload = await json_body(request)
        return resizer_answer(await asyncio.to_thread(_resizer().inputs, payload))

    @routes.post("/krc/ext/v1/resizer/settings")
    @guarded
    async def ext_v1_resizer_settings(request):
        payload = await json_body(request)
        return resizer_answer(await asyncio.to_thread(_resizer().settings, payload))

    # ---- workflow preparation (ext_api_workflows.py): stateless reads ------------------

    def workflow_answer(work, payload):
        from .ext_api_workflows import WorkflowError
        try:
            return web.json_response(work(payload), headers=_NO_STORE)
        except WorkflowError as exc:
            return web.json_response({"error": exc.code, "message": str(exc)}, status=exc.status, headers=_NO_STORE)

    @routes.post("/krc/ext/v1/workflows/branches")
    @guarded
    async def ext_v1_workflow_branches(request):
        from .ext_api_workflows import branches
        payload = await json_body(request)
        return await asyncio.to_thread(workflow_answer, branches, payload)

    @routes.post("/krc/ext/v1/workflows/prepare")
    @guarded
    async def ext_v1_workflow_prepare(request):
        from .ext_api_workflows import prepare
        payload = await json_body(request)
        return await asyncio.to_thread(workflow_answer, prepare, payload)

    # ---- internal: the Options page --------------------------------------------------

    @routes.get("/krc/ext-api/state")
    async def ext_api_state(_request):
        return web.json_response(ext_api.state(), headers=_NO_STORE)

    def same_site_only(handler):
        """Refuse a request a browser marks as coming from another site (stage 16)."""
        @functools.wraps(handler)
        async def wrapper(request):
            refused = refuse_cross_site(request, "External API")
            if refused:
                status, body = refused
                return web.json_response(body, status=status, headers=_NO_STORE)
            return await handler(request)
        return wrapper

    @routes.post("/krc/ext-api/consent")
    @same_site_only
    async def ext_api_consent(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        value = payload.get("enabled") if isinstance(payload, dict) else None
        if not isinstance(value, bool):
            return web.json_response({"error": "enabled must be true or false"}, status=400)
        return web.json_response(ext_api.set_enabled(value), headers=_NO_STORE)

    def switch_route(path, setter):
        """An Options switch: {"enabled": bool} -> state. Same-site only, never under ext/v1."""
        async def handler(request):
            try:
                payload = await request.json()
            except Exception:  # noqa: BLE001
                payload = {}
            value = payload.get("enabled") if isinstance(payload, dict) else None
            if not isinstance(value, bool):
                return web.json_response({"error": "enabled must be true or false"}, status=400)
            return web.json_response(setter(value), headers=_NO_STORE)
        handler.__name__ = "ext_api_" + path.rsplit("/", 1)[1].replace("-", "_")
        routes.post(path)(same_site_only(handler))

    switch_route("/krc/ext-api/read-only", ext_api.set_read_only)
    switch_route("/krc/ext-api/media-writes", lambda value: ext_api.set_area_writes("media", value))
    switch_route("/krc/ext-api/loadout-writes", lambda value: ext_api.set_area_writes("loadoutPresets", value))

    @routes.post("/krc/ext-api/area")
    @same_site_only
    async def ext_api_area(request):
        """Any permission area's switch: {"area": <id>, "enabled": bool} -> state."""
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        payload = payload if isinstance(payload, dict) else {}
        area, value = payload.get("area"), payload.get("enabled")
        if area not in ext_api.WRITE_AREAS or not isinstance(value, bool):
            return web.json_response({"error": "area must be a permission area id and enabled true or false"}, status=400)
        return web.json_response(ext_api.set_area_writes(area, value), headers=_NO_STORE)

    @routes.post("/krc/ext-api/new-key")
    @same_site_only
    async def ext_api_new_key(_request):
        return web.json_response(ext_api.new_key(), headers=_NO_STORE)
