"""Routes for the KRC external API (KRC_EXTERNAL_API_GAMEPLAN.md).

Public, for outside apps (the contract, versioned under ``/krc/ext/v1``; every handler is
wrapped in ``guarded``, so none can skip the switch and key check):

    GET  /krc/ext/v1/info          -> pack, versions, capabilities, dbId, packs, kits
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

Internal, for KRC Portal ▸ Options ▸ Network only (not part of ext/v1):

    GET  /krc/ext-api/state        -> {"enabled", "hasKey", "keyHint"} (never the key)
    POST /krc/ext-api/consent      {"enabled": bool} -> state (+ "key" when this made it)
    POST /krc/ext-api/new-key      -> state + "key" (the old key stops working)
    The two POSTs only accept ComfyUI's own page (request_guard; stage 16).
"""
import functools
import importlib

from . import ext_api
from .request_guard import refuse_cross_site

# What this build's ext/v1 offers; a client checks it instead of the pack version.
# "thumbnails.sizes": the Prompt Vault / LoRA Loadout / Model Library thumbnail routes take
# ?w= (utils/library/thumbnail_sizes.py SIZES).
CAPABILITIES = ["info", "prompts.list", "prompts.fields", "prompts.byId", "prompts.detail", "revisions", "changes",
                "thumbnails.sizes", "presets", "search.prompts", "prompts.profiles"]
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
        "capabilities": list(CAPABILITIES),
        "dbId": ext_api.db_id(),
        "packs": _packs(),
        "kits": _kits(),
        "thumbnailSizes": list(SIZES),
    }


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
    return {"revision": revision, "prompts": select_fields(prompts_for_response(library, profile_id=profile_id), fields)}


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
    return {"id": str(record_id).strip(), "matches": [prompt_detail(*match) for match in matches]}


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
}


_KIT_PREFIX = "presets:kit:"
_PUBLIC_BY_INTERNAL = {internal: public for public, internal in REVISION_STORES.items()}
# Names a client may pass in ?stores=: every public store, plus groups.
STORE_GROUPS = {
    "presets": ["llPresets", "csPresets", "wbPresets", "kitPresets"],
    "library": ["loraMetadata", "modelMetadata", "collections"],
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


async def scan_tokens():
    """{"loras": token, "models": token}: changes when that library was rescanned (files
    added, moved, removed) or a record changed in place. Asking runs the library's usual
    folder check (cheap, at most every few seconds), so files changed on disk are noticed;
    a cold library scans first, on a worker thread. "" when a library can't be read."""
    tokens = {}
    for lineage, module, name in (("loras", "lora_loadout.library_index", "LoraLibraryIndex"),
                                  ("models", "model_library.library_index", "ModelLibraryIndex")):
        try:
            cls = getattr(importlib.import_module(f"{__package__}.{module}"), name)
            tokens[lineage] = (await cls.loaded()).change_token()
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
    """{kind: store} for every preset kind: ll, cs, wb, and kit:<id> per registered kit.
    Each store normalizes its records on load, so listings match what the nodes see."""
    from .config_switcher_presets import ConfigSwitcherPresetStore
    from .lora_loadout.presets import PresetStore
    from .word_bank_presets import WordBankPresetStore

    stores = {"ll": PresetStore(), "cs": ConfigSwitcherPresetStore(), "wb": WordBankPresetStore()}
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
    prompts = {}
    for (record_id, _match), detail in zip(order, details):
        prompts.setdefault(record_id, []).append(detail)
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

    @routes.post("/krc/ext-api/new-key")
    @same_site_only
    async def ext_api_new_key(_request):
        return web.json_response(ext_api.new_key(), headers=_NO_STORE)
