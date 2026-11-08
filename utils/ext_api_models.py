"""The external API's Model Library routes (KRC_EXTERNAL_API.md, capabilities "models.list",
"models.detail", "search.models", "models.resolve"): the answers, registered behind the
switch and key by ext_api_routes.py.

Everything reads the Model Library's own list (model_library/listing.py: every model folder
plus the LoRAs, the same rows the node shows), from the libraries' cached scans (asking runs
their usual folder check, as /revisions does). Read-only: unlike the node's Info panel, a
detail read never seeds a record.
"""
from .ext_api_routes import MAX_DETAIL_IDS, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, BadRequest, _int_param

MAX_RESOLVE_REFS = 500


async def _indexes():
    """The loaded Model Library and LoRA indexes (a cold one scans on a worker thread)."""
    from .lora_loadout.library_index import LoraLibraryIndex
    from .model_library.library_index import ModelLibraryIndex

    return await ModelLibraryIndex.loaded(), await LoraLibraryIndex.loaded()


def _scans(index, lora_index):
    """The /revisions ``scans`` tokens of the indexes this answer was read from."""
    return {"loras": lora_index.change_token(), "models": index.change_token()}


async def _read(work):
    """Run ``work`` off the event loop inside one database read (the node's list does too)."""
    from .library.response_work import prepare_library_response

    return await prepare_library_response(work)


def _fields(value):
    from .prompt_vault_serialization import parse_fields

    try:
        return parse_fields(value)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None


def _keep(items, fields):
    """Only ``fields`` in each row; ``libraryId`` and ``modelType`` always stay."""
    if fields is None:
        return items
    keep = fields | {"libraryId", "modelType"}
    return [{key: value for key, value in item.items() if key in keep} for item in items]


def _types(value):
    """``?type=checkpoints,lora`` -> a set of type folders, or None for every type."""
    names = [name.strip() for name in str(value or "").split(",") if name.strip()]
    if not names:
        return None
    if len(names) > 50 or any(len(name) > 200 for name in names):
        raise BadRequest("type: at most 50 type folders")
    return {"lora" if name == "loras" else name for name in names}


def _collections():
    from .library.collections import CollectionStore

    return CollectionStore().ordered()


async def model_list(type_param="", fields_param=""):
    """The body of GET /krc/ext/v1/models: the Model Library's list (models of every type
    folder and the LoRAs), its folder rows, identity aliases and Collections."""
    from .model_library.listing import library_rows

    fields, types = _fields(fields_param), _types(type_param)
    index, lora_index = await _indexes()

    def work():
        rows = library_rows(index, lora_index, types)
        return {**rows, "collections": _collections()}

    body = await _read(work)
    return {"scans": _scans(index, lora_index), "total": len(body["items"]), "items": _keep(body["items"], fields),
            "folders": body["folders"], "aliases": body["aliases"], "collections": body["collections"]}


async def model_search(query="", offset="", limit="", fields_param="", type_param="", name_mode=""):
    """The body of GET /krc/ext/v1/search/models: the Model Library's search on the server
    (model_library/search.py), in the list's order, a page at a time."""
    from .model_library.listing import library_rows
    from .model_library.search import NAME_MODES, search_items

    offset = _int_param(offset, "offset", 0, 0, 10**9)
    limit = _int_param(limit, "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX)
    fields, types = _fields(fields_param), _types(type_param)
    name_mode = str(name_mode or "title").strip()
    if name_mode not in NAME_MODES:
        raise BadRequest(f"nameMode must be one of {', '.join(NAME_MODES)}")
    index, lora_index = await _indexes()
    items = (await _read(lambda: library_rows(index, lora_index, types)))["items"]
    found = search_items(items, query, name_mode)
    return {"scans": _scans(index, lora_index), "total": len(found), "offset": offset, "limit": limit,
            "items": _keep(found[offset:offset + limit], fields)}


def _detail_row(index, lora_index, library_id):
    """The full row for one id (the Info panel's record; aliases followed), or None.
    A model's list row already holds everything; a LoRA's gets what its list row holds back
    (description, example prompts, paths, usage terms). Ids go to the index that knows
    them, models first (card_resolve.py does the same)."""
    from .model_library.browser_rows import _browser_model_item
    from .model_library.listing import lora_rows

    record = index.get(library_id)
    if record is not None:
        row = _browser_model_item(dict(record))
        duplicates = record.get("duplicate_paths") or []
        return {**row, "duplicatePaths": list(duplicates), "duplicateCount": len(duplicates)}
    record = lora_index.get(library_id)
    if record is None:
        return None
    rows = lora_rows([dict(record)], include_detail=True)
    return rows[0] if rows else None


def _detail_rows(index, lora_index, ids):
    from .model_library.listing import join_usage

    found = {}
    for library_id in ids:
        row = _detail_row(index, lora_index, library_id)
        if row is not None:
            found[library_id] = row
    join_usage(list(found.values()))
    return found


def _wanted_ids(ids):
    if not isinstance(ids, list) or not all(isinstance(value, str) for value in ids):
        raise BadRequest("ids must be a list of strings")
    wanted = list(dict.fromkeys(value.strip() for value in ids if value.strip()))
    if len(wanted) > MAX_DETAIL_IDS:
        raise BadRequest(f"At most {MAX_DETAIL_IDS} ids per call")
    return wanted


async def model_detail(library_id):
    """The body of GET /krc/ext/v1/models/{id}, or None when no model has that id."""
    library_id = str(library_id or "").strip()
    if not library_id:
        return None
    index, lora_index = await _indexes()
    found = await _read(lambda: _detail_rows(index, lora_index, [library_id]))
    if library_id not in found:
        return None
    return {"id": library_id, "model": found[library_id], "scans": _scans(index, lora_index)}


async def model_details(ids):
    """The body of POST /krc/ext/v1/models/detail: several models' full rows at once."""
    wanted = _wanted_ids(ids)
    index, lora_index = await _indexes()
    found = await _read(lambda: _detail_rows(index, lora_index, wanted))
    return {"models": found, "missing": [library_id for library_id in wanted if library_id not in found],
            "scans": _scans(index, lora_index)}


def _ref_entry(ref):
    """A model reference as the Config Switcher stores a model option (``value``,
    ``libraryId`` / ``sha256``, ``modelType``), or the Card API's {id, path, folder}."""
    if not isinstance(ref, dict):
        raise BadRequest("refs must be a list of objects")

    def text(*keys):
        for key in keys:
            value = ref.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
        return ""

    return {"id": text("libraryId", "sha256", "id"), "path": text("value", "relativePath", "path"),
            "folder": text("modelType", "folder")}


async def resolve_models(refs, fields=None):
    """The body of POST /krc/ext/v1/models/resolve: per ref, in order, the model it names
    now (its current card row) and whether a run would find it (library/card_status.py, the
    Config Switcher's MISSING rule)."""
    from .library.card_status import STATUS_MISSING, model_card_status
    from .model_library.listing import library_rows

    if not isinstance(refs, list):
        raise BadRequest("refs must be a list")
    if len(refs) > MAX_RESOLVE_REFS:
        raise BadRequest(f"At most {MAX_RESOLVE_REFS} refs per call")
    if fields is not None and not isinstance(fields, (list, str)):
        raise BadRequest("fields must be a list or a comma list")
    keep = _fields(",".join(fields) if isinstance(fields, list) else (fields or ""))
    entries = [_ref_entry(ref) for ref in refs]
    index, lora_index = await _indexes()
    rows = await _read(lambda: library_rows(index, lora_index))
    results = []
    for entry, (status, item) in zip(entries, model_card_status(entries, rows["items"], rows["aliases"])):
        relative = str((item or {}).get("relativePath") or "")
        results.append({
            "status": status,
            # A hand-typed option (no id) is never MISSING: it may point at a folder the
            # library doesn't scan (the Config Switcher never badges it either).
            "missing": status == STATUS_MISSING and bool(entry["id"]),
            "libraryId": str((item or {}).get("libraryId") or ""),
            "relativePath": relative,
            "moved": bool(item) and bool(entry["path"]) and bool(relative) and relative.replace("\\", "/") != entry["path"].replace("\\", "/"),
            "model": _keep([item], keep)[0] if item else None,
        })
    return {"results": results, "scans": _scans(index, lora_index)}
