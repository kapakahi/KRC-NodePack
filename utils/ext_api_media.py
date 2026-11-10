"""The external API's Media routes (KRC_EXTERNAL_API.md, capabilities "media.list",
"media.detail", "search.media"): the answers, registered behind the switch and key by
ext_api_routes.py. Media presets are a kind of the existing /presets ("media").

The same records the KRC Portal's Media shows (media_store.public_item: no private paths),
the same folders, and the same rules as web/js/media (mode.js visible(), folders.js
itemInView / inFolder, api.js displayName, info_column.js presetsOf); the dev repo's
ext_api_media_check runs the node's own JS against these.

Read-only, unlike the node's list route: that one deletes the records whose file is gone
(media_store.reconcile_missing). Here the same rule (media_store.file_missing) is checked on
read and never written: the list and search leave such items out, as the node does once it
has listed them; a detail read says ``fileMissing``.
"""
import re

from .ext_api_routes import MAX_DETAIL_IDS, SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX, BadRequest, _int_param

INPUT_VIEW, OUTPUT_VIEW = "input", "output"
ALL_FOLDERS, UNSORTED = "__all__", "__unsorted__"   # folders.js chip values
KINDS = ("all", "video", "image")
SORTS = ("date-desc", "date-asc", "alpha", "alpha-desc")
_EXTENSION = re.compile(r"\.(webp|webm)$", re.IGNORECASE)
_DIGITS = re.compile(r"(\d+)")


def item_view(item):
    """folders.js itemInView: Output storage -> "output"; everything else (uploads, in
    ComfyUI's input directory or Media's private folder) -> "input"."""
    return OUTPUT_VIEW if item.get("storage") == "output" else INPUT_VIEW


def folder_view(folder):
    return OUTPUT_VIEW if folder.get("storage") == "output" else INPUT_VIEW


def display_name(item):
    """api.js displayName: the name without a .webp / .webm extension, or "(unnamed)"."""
    return _EXTENSION.sub("", str(item.get("name") or "")) or "(unnamed)"


def in_folder(item, chip):
    """folders.js inFolder: does ``item`` show under folder chip ``chip`` (ALL_FOLDERS,
    UNSORTED, or a folder id)?"""
    if chip == ALL_FOLDERS:
        return True
    if chip == UNSORTED:
        return not item.get("folder")
    return item.get("folder") == chip


def _view(value):
    view = str(value or "").strip()
    if view not in ("", INPUT_VIEW, OUTPUT_VIEW):
        raise BadRequest("view must be input or output")
    return view


def _fields(value):
    from .prompt_vault_serialization import parse_fields

    try:
        return parse_fields(value)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None


def _keep(items, fields):
    """Only ``fields`` in each item; ``id`` and ``kind`` always stay."""
    if fields is None:
        return items
    keep = fields | {"id", "kind"}
    return [{key: value for key, value in item.items() if key in keep} for item in items]


def _snapshot():
    """Items (newest first, as the node's list), folders (pinned first, then by name),
    presets (creation order) and the two revisions, all read at one moment."""
    from .db import connection as db
    from .db.presets import change_store
    from .media import media_store as store
    from .media import preset_store

    with db.read() as conn:
        items = store.items()
        folders = store.folders()
        presets = preset_store.presets()
        revision = db.revision(store.STORE, conn)
        presets_revision = db.revision(change_store(preset_store.KIND), conn)
    return items, folders, presets, revision, presets_revision


def _present(items):
    """The items whose file isn't confirmed gone (the node lists only these), and that the
    caller may read (ext_api_policy: an item is reachable through its folder)."""
    from . import ext_api_policy as policy
    from .media import media_store as store

    available = {}
    return [item for item in items if policy.media_item_readable(item) and not store.file_missing(item, available)]


def _visible_folders(folders):
    from . import ext_api_policy as policy

    return [folder for folder in folders if policy.media_folder_readable(folder)]


def _visible_presets(presets):
    from . import ext_api_policy as policy

    return [preset for preset in presets if policy.preset_readable("media", preset["id"])]


def _row(record):
    """An item as ext/v1 shows it: the browser's record, its view, and ``version`` (what an
    item write may send to refuse a stale change)."""
    from .media import media_store as store

    return {**store.public_item(record), "view": item_view(record), "version": store.item_version(record)}


def folder_row(folder):
    from .media import media_store as store

    return {**folder, "view": folder_view(folder), "version": store.folder_version(folder)}


def media_list(view_param="", fields_param=""):
    """The body of GET /krc/ext/v1/media: every item and folder (or one view's)."""
    view, fields = _view(view_param), _fields(fields_param)
    items, folders, _presets, revision, presets_revision = _snapshot()
    rows = [_row(item) for item in _present(items) if not view or item_view(item) == view]
    return {"revision": revision, "presetsRevision": presets_revision, "total": len(rows),
            "items": _keep(rows, fields),
            "folders": [folder_row(folder) for folder in _visible_folders(folders) if not view or folder_view(folder) == view]}


def _sort_key(sort):
    """mode.js SORTS, after pinned first. "alpha" compares names naturally, ignoring case
    (the node uses the browser's localeCompare; accents and punctuation may order slightly
    differently)."""
    def natural(item):
        return [(0, int(part), "") if part.isdigit() else (1, 0, part.casefold())
                for part in _DIGITS.split(display_name(item)) if part]

    if sort == "date-asc":
        return lambda item: (not item.get("pinned"), item.get("created") or 0)
    if sort in ("alpha", "alpha-desc"):
        return lambda item: (not item.get("pinned"), natural(item))
    return lambda item: (not item.get("pinned"), -(item.get("created") or 0))


def search_items(items, query="", view="", folder="", kind="all", sort="date-desc"):
    """mode.js visible(), minus the display choices (favourites, colour, NSFW): the name
    contains ``query`` (any case), the view, the folder chip and the kind filter; pinned
    first, then ``sort``."""
    text = str(query or "").strip().lower()
    chip = str(folder or "").strip()
    chip = {"": ALL_FOLDERS, "all": ALL_FOLDERS, "unsorted": UNSORTED}.get(chip, chip)
    found = [item for item in items
             if (not text or text in display_name(item).lower())
             and (kind == "all" or item.get("kind") == kind)
             and (not view or item_view(item) == view)
             and in_folder(item, chip)]
    if sort == "alpha-desc":
        pinned = [item for item in found if item.get("pinned")]
        rest = [item for item in found if not item.get("pinned")]
        key = _sort_key("alpha")
        return sorted(pinned, key=key, reverse=True) + sorted(rest, key=key, reverse=True)
    return sorted(found, key=_sort_key(sort))


def media_search(query="", view="", folder="", kind="", sort="", offset="", limit="", fields_param=""):
    """The body of GET /krc/ext/v1/search/media."""
    view, fields = _view(view), _fields(fields_param)
    kind = str(kind or "all").strip()
    if kind not in KINDS:
        raise BadRequest(f"kind must be one of {', '.join(KINDS)}")
    sort = str(sort or "date-desc").strip()
    if sort not in SORTS:
        raise BadRequest(f"sort must be one of {', '.join(SORTS)}")
    offset = _int_param(offset, "offset", 0, 0, 10**9)
    limit = _int_param(limit, "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX)
    items, _folders, _presets, revision, presets_revision = _snapshot()
    found = search_items(_present(items), query, view, folder, kind, sort)
    return {"revision": revision, "presetsRevision": presets_revision, "total": len(found), "offset": offset,
            "limit": limit, "items": _keep([_row(item) for item in found[offset:offset + limit]], fields)}


def _detail(record, folders, presets, available):
    """The Preview page's record: the card fields, its folder's name, where presets use it
    (info_column.js presetsOf: preset, slot 0-5, in creation order), and whether its file is
    gone."""
    from .media import media_store as store

    folder = next((entry for entry in folders if entry["id"] == record.get("folder")), None)
    return {
        **_row(record),
        "folderName": folder["name"] if folder else "Unsorted",
        "presets": [{"id": preset["id"], "name": preset["name"], "slot": index}
                    for preset in presets for index, slot in enumerate(preset["payload"]["slots"])
                    if slot["id"] == record["id"]],
        "fileMissing": store.file_missing(record, available),
    }


def media_details(ids):
    """The body of POST /krc/ext/v1/media/detail."""
    if not isinstance(ids, list) or not all(isinstance(value, str) for value in ids):
        raise BadRequest("ids must be a list of strings")
    wanted = list(dict.fromkeys(value.strip() for value in ids if value.strip()))
    if len(wanted) > MAX_DETAIL_IDS:
        raise BadRequest(f"At most {MAX_DETAIL_IDS} ids per call")
    items, folders, presets, revision, presets_revision = _snapshot()
    from . import ext_api_policy as policy

    # An item the caller can't read answers as missing (knowing its id grants nothing).
    by_id = {item["id"]: item for item in items if policy.media_item_readable(item)}
    folders, presets = _visible_folders(folders), _visible_presets(presets)
    available = {}
    found = {item_id: _detail(by_id[item_id], folders, presets, available) for item_id in wanted if item_id in by_id}
    return {"items": found, "missing": [item_id for item_id in wanted if item_id not in found],
            "revision": revision, "presetsRevision": presets_revision}


def media_item(item_id):
    """The body of GET /krc/ext/v1/media/{id}, or None when no item has that id."""
    item_id = str(item_id or "").strip()
    if not item_id:
        return None
    body = media_details([item_id])
    if item_id not in body["items"]:
        return None
    return {"id": item_id, "item": body["items"][item_id], "revision": body["revision"],
            "presetsRevision": body["presetsRevision"]}


def _preset_fields(preset):
    """A Media preset's fields past {id, group, name}: created, auto, slots, and ``version``
    (what a write's ``version`` must match). A slot holding an item the caller can't read
    shows as ``{"name", "id": "", "hidden": true}``: being in a preset it may read grants no
    access to the item (its id, name and file stay hidden)."""
    from .media import preset_store

    return {"created": preset["created"], "auto": preset["auto"], "slots": scoped_slots(preset["payload"]["slots"]),
            "version": preset_store.version(preset)}


def scoped_slots(slots):
    from . import ext_api_policy as policy
    from .media import media_store as store

    if policy.unrestricted("mediaFolders"):
        return slots
    out = []
    for slot in slots:
        item = store.get(slot["id"]) if slot.get("id") else None
        if slot.get("id") and (item is None or not policy.media_item_readable(item)):
            # A deleted item reads the same as a hidden one: nothing tells them apart.
            out.append({**slot, "id": "", "hidden": True})
        else:
            out.append(slot)
    return out


def media_preset_entry(preset):
    """One Media preset as /presets?kind=media&full=1 lists it."""
    return {"kind": "media", "id": preset["id"], "group": preset["group"], "name": preset["name"], "modified": 0,
            "payload": _preset_fields(preset)}


class MediaPresetStore:
    """Media presets for the external API's /presets (kind "media"), in the shape every
    preset kind has there: {id, group, name, ...}; the payload is ``created``, ``auto``,
    ``slots`` (exactly 6 {name, id}, "" = empty) and ``version``, in creation order (the
    node's)."""

    def load(self):
        from .media import preset_store

        return {"presets": [{"id": preset["id"], "group": preset["group"], "name": preset["name"], **_preset_fields(preset)}
                            for preset in _visible_presets(preset_store.presets())]}
