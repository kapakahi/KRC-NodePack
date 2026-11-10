"""The external API's Media writes (KRC_EXTERNAL_API.md, capabilities "media.upload" and
"presets.media.write"): the one exception to ext/v1 being read-only (2026-11-06), behind
the switch, the key, Read only off AND the Media writes switch (ext_api.write_refusal("media")).

Every write goes through the node's own code, so it validates, stores, logs its revision and
tells open pages exactly as the Media does:
- an upload is media_routes.receive_upload (the node's upload: formats, size caps, WebP /
  WebM conversion, thumbnails, ComfyUI's input directory), with stricter settings (an unknown
  key or an out-of-range value is refused here; the node quietly falls back);
- presets are preset_store.create / rename / set_slots (six slots, "Slot n" names, the first
  change clears ``auto``), with ``version`` (preset_store.version) checked under the write
  lock, so a stale client gets 409 instead of overwriting.

Items and folders take an optional ``version`` (media_store.item_version / folder_version)
the same way; presets require theirs. Bulk moves / deletes / attributes and the Media's
global Purge (preview -> snapshot -> confirm) are the node's own, unchanged. Batch is the
node's client side (a queue of uploads, job polling, cancel, and a duplicate check against
each item's ``source``): it needs nothing else here. Nothing counts usage.
"""
import json

from . import ext_api_policy as policy
from .ext_api_routes import BadRequest

UPLOAD_SETTINGS = ("maxMegapixels", "keepAlpha", "fps", "audio", "trimIn", "trimOut", "maxLength", "folder")


class NotFound(LookupError):
    """A preset, item or job that doesn't exist (404)."""


class Conflict(Exception):
    """The preset / item / folder changed since the client read it (409); ``current`` is it
    now, answered under ``kind`` ("preset", "item" or "folder")."""

    def __init__(self, message, current, kind="preset"):
        super().__init__(message)
        self.current, self.kind = current, kind


def _number(settings, key, test, message):
    value = settings.get(key)
    if value is None:
        return
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not test(value):
        raise BadRequest(message)


def check_upload_settings(settings):
    """The external API's upload settings: only UPLOAD_SETTINGS, each 0 (none / the
    source's) or within the range the node accepts for a custom value (process_image /
    process_video CUSTOM_*). Raises BadRequest (the upload answers 400)."""
    from .media import media_store as store
    from .media.process_image import CUSTOM_MEGAPIXELS
    from .media.process_video import CUSTOM_FPS, CUSTOM_LENGTH

    unknown = sorted(set(settings) - set(UPLOAD_SETTINGS))
    if unknown:
        hint = " (fill a preset slot with the slot route after the upload)" if "assign" in unknown else ""
        raise BadRequest(f"Unknown upload setting {unknown[0]!r}{hint}")
    low, high = CUSTOM_MEGAPIXELS
    _number(settings, "maxMegapixels", lambda v: v == 0 or low <= v <= high, f"maxMegapixels must be 0 or from {low} to {high}")
    _number(settings, "fps", lambda v: v == 0 or CUSTOM_FPS[0] <= v <= CUSTOM_FPS[1],
            f"fps must be 0 (the source's) or from {CUSTOM_FPS[0]:g} to {CUSTOM_FPS[1]:g}")
    _number(settings, "maxLength", lambda v: v == 0 or CUSTOM_LENGTH[0] <= v <= CUSTOM_LENGTH[1],
            f"maxLength must be 0 (all) or from {CUSTOM_LENGTH[0]:g} to {CUSTOM_LENGTH[1]:g} seconds")
    _number(settings, "trimIn", lambda v: v >= 0, "trimIn must be 0 or more (seconds)")
    _number(settings, "trimOut", lambda v: v >= 0, "trimOut must be 0 or more (seconds)")
    for flag in ("keepAlpha", "audio"):
        if flag in settings and not isinstance(settings[flag], bool):
            raise BadRequest(f"{flag} must be true or false")
    folder = settings.get("folder", "")
    if not isinstance(folder, str):
        raise BadRequest("folder must be a folder id, or \"\" for Unsorted")
    if folder and not any(entry["id"] == folder and store.folder_side(entry) == "input" for entry in store.folders()):
        raise BadRequest("folder must be an Input folder's id (see /media?view=input), or \"\" for Unsorted")


async def upload(request):
    """POST /krc/ext/v1/media/upload -> (status, body). A still: 201 {"id", "item"}; a video
    or animated GIF: 202 {"id", "job"} (poll /media/jobs/{job id})."""
    from .ext_api_media import _row
    from .media import media_store as store
    from .media.media_routes import receive_upload

    principal = policy.current()

    def check(settings):
        try:
            check_upload_settings(settings)
            # Where it goes: a folder this caller may write (omitted -> its default).
            settings["folder"] = policy.upload_folder(settings.get("folder"), "input")
            target = settings.get("assign")
            if isinstance(target, dict) and target.get("preset"):
                policy.require_preset("media", str(target["preset"]), write=True, message="No Media preset has that id.")
        except BadRequest as exc:
            raise store.MediaError(f"bad_request:{exc}") from None
        except policy.Denied as denied:
            raise store.MediaError("denied:" + json.dumps([denied.status, denied.body])) from None

    status, body = await receive_upload(request, check)
    if body.get("ok"):
        if "job" in body:
            remember_job(body["job"]["id"], principal)
            return 202, {"id": body["job"]["itemId"], "job": body["job"]}
        item = store.get(body["item"]["id"]) or {}
        return 201, {"id": body["item"]["id"], "item": _row(item) if item else body["item"]}
    message = str(body.get("error") or "The upload failed.")
    if message.startswith("denied:"):
        denied_status, denied_body = json.loads(message[len("denied:"):])
        return denied_status, denied_body
    if message.startswith("bad_request:"):
        return 400, {"error": "bad_request", "message": message[len("bad_request:"):]}
    code = {400: "bad_request", 413: "too_large", 415: "unsupported_media", 503: "unavailable"}.get(status, "internal_error")
    return status, {"error": code, "message": message}


# Which API profile started each upload job (in memory, like the jobs). A restricted caller
# sees and cancels only its own; an unrestricted one also those started in KRC Portal.
_JOB_OWNERS = {}
_JOB_OWNERS_MAX = 500


def remember_job(job_id, principal):
    if principal is not None:
        _JOB_OWNERS[str(job_id)] = principal.profile_id
        while len(_JOB_OWNERS) > _JOB_OWNERS_MAX:
            _JOB_OWNERS.pop(next(iter(_JOB_OWNERS)))


def _job_visible(job_id):
    p = policy.current()
    if p is None:
        return True
    owner = _JOB_OWNERS.get(str(job_id))
    return owner == p.profile_id or (owner is None and p.unrestricted("mediaFolders"))


def job(job_id):
    """GET /krc/ext/v1/media/jobs/{id}: an upload's conversion (jobs live in memory; the last
    50 finished ones are kept, and none survive a restart)."""
    from .media import media_jobs

    found = media_jobs.get(job_id) if _job_visible(job_id) else None
    if found is None:
        raise NotFound("No upload job has that id (finished jobs are forgotten after a while, and on restart).")
    return {"job": found}


# ---- presets --------------------------------------------------------------------------

def _preset_body(record):
    """A preset as /presets?kind=media lists it, plus the revision after the write."""
    from .db import connection as db
    from .db.presets import change_store
    from .ext_api_media import media_preset_entry
    from .media import preset_store

    return {"preset": media_preset_entry(record), "presetsRevision": db.revision(change_store(preset_store.KIND))}


def _announce(op, preset_id):
    from .media.media_routes import _announce_presets
    _announce_presets(op, preset_id)


def _text(payload, key, required=True):
    value = payload.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise BadRequest(f"{key} must be a string")
    return value


def _version(payload):
    value = payload.get("version")
    if not isinstance(value, str) or not value:
        raise BadRequest("version is required: the preset's version from your last read (/presets?kind=media)")
    return value


def _existing(preset_id, write=True):
    from .media import preset_store

    policy.require_preset("media", preset_id, write=write, message="No Media preset has that id.")
    try:
        record = preset_store.get(preset_id)
    except preset_store.PresetError:
        record = None
    if record is None:
        raise NotFound("No Media preset has that id.")
    return record


def _run(write):
    """Run a preset_store write, mapping its errors to the external API's."""
    from .media import media_store as store
    from .media import preset_store

    try:
        return write()
    except preset_store.PresetConflict as exc:
        from .ext_api_media import media_preset_entry
        raise Conflict(str(exc), media_preset_entry(exc.current)) from None
    except preset_store.PresetError as exc:
        if "no longer exists" in str(exc) and "preset" in str(exc):
            raise NotFound("No Media preset has that id.") from None
        raise BadRequest(str(exc)) from None
    except store.MediaError as exc:
        raise BadRequest(str(exc)) from None


def create_preset(payload):
    """POST /krc/ext/v1/media/presets {"name"?}: a new preset with six empty slots. No name
    makes "Untitled n", as the Media's "+ New preset"."""
    from .media import preset_store

    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    name = _text(payload, "name", required=False) or ""
    policy.require_create("presets.media", "Media presets")
    record = _run(lambda: preset_store.create(name))
    policy.created("presets.media", record["id"])
    _announce("create", record["id"])
    return _preset_body(record)


def rename_preset(preset_id, payload):
    """POST /krc/ext/v1/media/presets/{id}/rename {"name", "version"}."""
    from .media import preset_store

    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    name, expected = _text(payload, "name"), _version(payload)
    _existing(preset_id)
    record = _run(lambda: preset_store.rename(preset_id, name, if_version=expected))
    _announce("rename", record["id"])
    return _preset_body(record)


def set_slot(preset_id, index, payload):
    """POST /krc/ext/v1/media/presets/{id}/slots/{index} {"item", "version"}: put a Media item
    in slot ``index`` (0-5), replacing what's there, or empty it ("")."""
    from .media import media_store as store
    from .media import preset_store

    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    try:
        slot = int(str(index))
    except ValueError:
        slot = -1
    if not 0 <= slot < preset_store.SLOT_COUNT or str(slot) != str(index):
        raise BadRequest(f"The slot index must be 0 to {preset_store.SLOT_COUNT - 1}")
    item_id, expected = _text(payload, "item"), _version(payload)
    _existing(preset_id)
    if item_id:
        try:
            found = store.get(item_id)
        except store.MediaError:
            found = None
        # The caller must be able to read the item it puts in a slot (an id it guessed
        # reads as missing): a slot assignment never grants access across folders.
        if found is None or not policy.media_item_readable(found):
            raise BadRequest("No Media item has that id")
    record = _run(lambda: preset_store.set_slots(preset_id, [item_id], start=slot, if_version=expected))
    _announce("slot", record["id"])
    return _preset_body(record)


# ---- jobs ---------------------------------------------------------------------------

def cancel_job(job_id):
    """POST /krc/ext/v1/media/jobs/{id}/cancel: stop a queued or converting upload (the Media's
    Stop). -> {"cancelled", "job"}; ``cancelled`` false when it had already finished."""
    from .media import media_jobs

    if not _job_visible(job_id) or media_jobs.get(job_id) is None:
        raise NotFound("No upload job has that id (finished jobs are forgotten after a while, and on restart).")
    cancelled = media_jobs.cancel(job_id)
    return {"cancelled": cancelled, "job": media_jobs.get(job_id)}


# ---- items --------------------------------------------------------------------------

ITEM_FIELDS = ("name", "folder", "favorite", "pinned", "color", "customBadge", "nsfw")


def _object(payload):
    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    return payload


def _optional_version(payload):
    value = payload.get("version")
    if value is None:
        return None
    if not isinstance(value, str) or not value:
        raise BadRequest("version must be the version string from your last read")
    return value


def _store_call(work, noun="item"):
    """Run a media_store write, mapping its errors: MediaConflict -> 409, a vanished record
    -> 404, the rest -> 400."""
    from .ext_api_media import _row, folder_row
    from .media import media_store as store

    try:
        return work()
    except store.MediaConflict as exc:
        current = _row(exc.current) if noun == "item" else folder_row(exc.current)
        raise Conflict(str(exc), current, noun) from None
    except store.MediaError as exc:
        text = str(exc)
        if text in ("Unknown Media item.", "That folder no longer exists."):
            raise NotFound(f"No Media {noun} has that id.") from None
        raise BadRequest(text) from None


def _item_or_404(item_id, write=True):
    """The item, if the caller may change it (unreadable = missing, readable only = 403)."""
    from .media import media_store as store

    try:
        record = store.get(item_id)
    except store.MediaError:
        record = None
    if record is None or not policy.media_item_readable(record):
        raise NotFound("No Media item has that id.")
    if write and not policy.media_item_writable(record):
        raise policy.read_only_resource()
    return record


def _check_destination(folder_id, items):
    """A move: the caller must write the destination ("" = Unsorted of the items' side)."""
    if folder_id:
        policy.require_write("mediaFolders", folder_id, "No Media folder has that id.")
        return
    for item in items:
        policy.require_write("mediaFolders", policy.UNSORTED_OUTPUT if item.get("storage") == "output"
                             else policy.UNSORTED_INPUT, "No Media folder has that id.")


def _require_items(ids):
    """Every id in a selection must be one the caller may change; any other refuses the whole
    operation (404, as missing), so nothing is applied in part."""
    from .media import media_store as store

    if not isinstance(ids, list):
        return []
    records = []
    for item_id in ids:
        try:
            record = store.get(item_id) if isinstance(item_id, str) else None
        except store.MediaError:
            record = None
        if record is None or not policy.media_item_readable(record):
            raise NotFound("No Media item has that id.")
        if not policy.media_item_writable(record):
            raise policy.read_only_resource()
        records.append(record)
    return records


def update_item(item_id, payload):
    """POST /krc/ext/v1/media/{id}/update: rename, move to a folder of its own view ("" =
    Unsorted; the file moves too), favourite, pin, colour, badge, NSFW (media_store.update,
    the Media's own validation). -> {"item", "revision"}."""
    from .db import connection as db
    from .ext_api_media import _row
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    unknown = sorted(set(payload) - set(ITEM_FIELDS) - {"version"})
    if unknown:
        raise BadRequest(f"Unknown item field {unknown[0]!r} (one of {', '.join(ITEM_FIELDS)})")
    fields = {key: payload[key] for key in ITEM_FIELDS if key in payload}
    if not fields:
        raise BadRequest(f"Nothing to change: send one of {', '.join(ITEM_FIELDS)}")
    for key in ("name", "folder", "color", "customBadge"):
        if key in fields and not isinstance(fields[key], str):
            raise BadRequest(f"{key} must be a string")
    expected = _optional_version(payload)
    current = _item_or_404(item_id)
    if "folder" in fields:
        _check_destination(fields["folder"], [current])
    record = _store_call(lambda: store.update(item_id, fields, if_version=expected))
    _announce("update", record["id"])
    return {"item": _row(record), "revision": db.revision(store.STORE)}


def delete_item(item_id, payload):
    """POST /krc/ext/v1/media/{id}/delete: the item, its file and thumbnail, for good (the
    Media's Delete; presets keep pointing at it and show it Missing)."""
    from .db import connection as db
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    expected = _optional_version(payload)
    _item_or_404(item_id)
    removed = _store_call(lambda: store.delete(item_id, if_version=expected))
    if removed:
        _announce("delete", item_id)
    return {"deleted": item_id, "revision": db.revision(store.STORE)}


def bulk(payload, preview=False):
    """POST /krc/ext/v1/media/bulk[/preview]: the Media's selection Move / Delete
    (media_store.bulk_operation). Delete needs "confirmed": true."""
    from .db import connection as db
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    selected = _require_items(payload.get("ids"))
    if payload.get("operation") == "move" and not preview:
        destination = payload.get("destination")
        if isinstance(destination, str):
            _check_destination(destination, selected)
    try:
        result = store.bulk_operation(payload, preview=preview)
    except store.MediaError as exc:
        raise BadRequest(str(exc)) from None
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    result.pop("ok", None)
    if "destinations" in result and not policy.unrestricted("mediaFolders"):
        # Only folders the caller may move into (no other folder's name).
        sides = {item.get("storage") == "output" for item in selected}
        unsorted_ok = all(policy.writable("mediaFolders", policy.UNSORTED_OUTPUT if side else policy.UNSORTED_INPUT)
                          for side in sides)
        result["destinations"] = [entry for entry in result["destinations"]
                                  if (entry["value"] == "" and unsorted_ok)
                                  or (entry["value"] and policy.writable("mediaFolders", entry["value"]))]
    if not preview and result.get("updated"):
        _announce(payload["operation"])
    return {**result, "revision": db.revision(store.STORE)}


def bulk_attributes(payload):
    """POST /krc/ext/v1/media/bulk-attributes {ids, field, value}: one card attribute on many
    items (media_store.bulk_attributes, the shared bulk rules)."""
    from .db import connection as db
    from .ext_api_media import _row
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    _require_items(payload.get("ids"))
    try:
        result = store.bulk_attributes(payload)
    except (store.MediaError, ValueError) as exc:
        raise BadRequest(str(exc)) from None
    _announce("bulk-attributes")
    return {"ids": result["ids"], "updated": result["updated"], "skipped": result["skipped"],
            "items": [_row(item) for item in result["items"]], "revision": db.revision(store.STORE)}


def purge(payload, preview=False):
    """POST /krc/ext/v1/media/purge[/preview]: the Media's global Delete (media_purge.purge):
    a scope (unsorted / selected / all / output), a preview with its ``snapshot``, then the
    purge with that snapshot and "confirmed": true. Preset references and protected folders
    are always kept."""
    from .db import connection as db
    from .media import media_store as store
    from .media.media_purge import purge as run_purge
    from .media.media_routes import _announce

    payload = _object(payload)
    # A restricted caller purges only a selection it may change; the whole-Media scopes
    # (unsorted / output / all) need every folder writable.
    if payload.get("scope") == "selected":
        _require_items(payload.get("ids"))
    elif not (policy.unrestricted("mediaFolders") and policy.writable("mediaFolders", policy.UNSORTED_INPUT)):
        raise policy.Denied(403, {"error": "scope_not_permitted",
                                  "message": "This API profile may purge only a selection of its own items (scope selected)."})
    try:
        result = run_purge(payload, preview=preview)
    except (store.MediaError, ValueError) as exc:
        raise BadRequest(str(exc)) from None
    result.pop("ok", None)
    if not preview and result.get("removed"):
        _announce("purge")
    return {**result, "revision": db.revision(store.STORE)}


# ---- folders ------------------------------------------------------------------------

FOLDER_FIELDS = ("name", "color", "keep", "pinned")


def create_folder(payload):
    """POST /krc/ext/v1/media/folders {name, view}: a new folder (a directory under
    KRC-Media/) in the Input view (default) or the Output view."""
    from .db import connection as db
    from .ext_api_media import folder_row
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    name, view = payload.get("name"), payload.get("view", "input")
    if not isinstance(name, str):
        raise BadRequest("name must be a string")
    if view not in ("input", "output"):
        raise BadRequest("view must be input or output")
    policy.require_create("mediaFolders", "Media folders")
    folder = _store_call(lambda: store.create_folder(name, storage="output" if view == "output" else "media"), "folder")
    policy.created("mediaFolders", folder["id"])
    _announce("folder", folder["id"])
    return {"folder": folder_row(folder), "revision": db.revision(store.STORE)}


def _folder_or_404(folder_id):
    from .media import media_store as store

    if not store.ID_PATTERN.match(str(folder_id or "")) or not any(entry["id"] == folder_id for entry in store.folders()):
        raise NotFound("No Media folder has that id.")
    policy.require_write("mediaFolders", folder_id, "No Media folder has that id.")
    return next(entry for entry in store.folders() if entry["id"] == folder_id)


def update_folder(folder_id, payload):
    """POST /krc/ext/v1/media/folders/{id}/update {name?, color?, keep?, pinned?, version?}:
    a new name renames its directory and its files follow."""
    from .db import connection as db
    from .ext_api_media import folder_row
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    unknown = sorted(set(payload) - set(FOLDER_FIELDS) - {"version"})
    if unknown:
        raise BadRequest(f"Unknown folder field {unknown[0]!r} (one of {', '.join(FOLDER_FIELDS)})")
    fields = {key: payload[key] for key in FOLDER_FIELDS if key in payload}
    if not fields:
        raise BadRequest(f"Nothing to change: send one of {', '.join(FOLDER_FIELDS)}")
    for key in ("name", "color"):
        if key in fields and not isinstance(fields[key], str):
            raise BadRequest(f"{key} must be a string")
    for key in ("keep", "pinned"):
        if key in fields and not isinstance(fields[key], bool):
            raise BadRequest(f"{key} must be true or false")
    if fields.get("color"):
        from .library.card_colors import CARD_COLOR_IDS
        if fields["color"].strip().lower() not in CARD_COLOR_IDS:
            raise BadRequest("Unknown card color.")
    expected = _optional_version(payload)
    _folder_or_404(folder_id)
    folder = _store_call(lambda: store.update_folder(folder_id, fields, if_version=expected), "folder")
    _announce("folder", folder["id"])
    return {"folder": folder_row(folder), "revision": db.revision(store.STORE)}


def delete_folder(folder_id, payload):
    """POST /krc/ext/v1/media/folders/{id}/delete {version?}: the folder goes; its items move
    to Unsorted (their files loose into KRC-Media/)."""
    from .db import connection as db
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    expected = _optional_version(payload)
    folder = _folder_or_404(folder_id)
    # Its items move to Unsorted: the caller must write that Unsorted too, or deleting the
    # folder would hand its items to whoever reads Unsorted.
    policy.require_write("mediaFolders", policy.UNSORTED_OUTPUT if folder.get("storage") == "output"
                         else policy.UNSORTED_INPUT, "No Media folder has that id.")
    moved = _store_call(lambda: store.delete_folder(folder_id, if_version=expected), "folder")
    if moved is None:
        raise NotFound("No Media folder has that id.")
    _announce("folder", folder_id)
    return {"deleted": folder_id, "moved": moved, "revision": db.revision(store.STORE)}


def purge_folder(folder_id, payload):
    """POST /krc/ext/v1/media/folders/{id}/purge {"confirmed": true, version?}: the folder AND
    every item in it, protected or in presets or not (the Media's PURGE)."""
    from .db import connection as db
    from .media import media_store as store
    from .media.media_routes import _announce

    payload = _object(payload)
    if payload.get("confirmed") is not True:
        raise BadRequest('Purging a folder deletes it and every item in it: send "confirmed": true')
    expected = _optional_version(payload)
    _folder_or_404(folder_id)
    result = _store_call(lambda: store.purge_folder(folder_id, if_version=expected), "folder")
    if result is None:
        raise NotFound("No Media folder has that id.")
    print(f"[KRC Media] purged a folder: {result['removed']} item(s), {result['bytes'] // 1024} KB freed")
    _announce("folder", folder_id)
    return {"deleted": folder_id, "removed": result["removed"], "bytes": result["bytes"], "revision": db.revision(store.STORE)}


# ---- preset delete ------------------------------------------------------------------

def delete_preset(preset_id, payload):
    """POST /krc/ext/v1/media/presets/{id}/delete {"version"}: a Media Loader using it shows
    "Missing preset"; its media stay."""
    from .db import connection as db
    from .db.presets import change_store
    from .media import preset_store

    payload = _object(payload)
    expected = _version(payload)
    _existing(preset_id)
    removed = _run(lambda: preset_store.delete(preset_id, if_version=expected))
    if not removed:
        raise NotFound("No Media preset has that id.")
    _announce("delete", preset_id)
    return {"deleted": preset_id, "presetsRevision": db.revision(change_store(preset_store.KIND))}
