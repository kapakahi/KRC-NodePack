"""Media's catalog (items and folders) lives in krc.db (tables media_items / media_folders,
MEDIA_INTO_NODEPACK_GAMEPLAN.md stage 2); thumbnails and transient uploads in KRC's private
data folder. Completed uploads use ComfyUI input/KRC-Media/uploads/; generated media uses
output/KRC-Media/. Presets reference stable record IDs, independently of filesystem paths.

Every read-modify-save runs inside :func:`locked`: one write transaction (so a write from
another thread can't land between the read and the save), and the thread lock the files
next to the records rely on. Files are removed only after the transaction commits.
"""

import json
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

from ..db import connection as db
from .krc import api
from . import media_paths

MEDIA_DIRNAME = "media"
# Where Media Output saves with no folder chosen ("Default" on the node; the Output view's
# Unsorted). Under ComfyUI's output directory.
DEFAULT_OUTPUT_DIRECTORY = "KRC-Media/Default"
STORE = "media"   # the `changes` store name: revisions, live sync, the external API's feed
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
CARD_FIELDS = ("favorite", "pinned", "color", "name", "folder", "customBadge", "nsfw")
FOLDER_NAME_MAX = 40
NAME_MAX = 80

_lock = threading.RLock()
_root_override = None    # tests point the store at a scratch folder


@contextmanager
def locked():
    """A read-modify-save: the store's lock plus one krc.db write transaction (nested use
    joins the outer one, so presets and items can change together)."""
    with _lock, db.write() as conn:
        yield conn


class MediaError(ValueError):
    """A request the Media refuses; the message is shown to the user."""


def use_root(path):
    """Tests: keep the Media in ``path`` instead of NodePack's data folder."""
    global _root_override
    _root_override = Path(path) if path else None


def root():
    base = _root_override if _root_override is not None else Path(api().get_krc_node_dir("media")) / MEDIA_DIRNAME
    return Path(base).resolve()


def confined(*parts):
    """A path inside the media folder; MediaError for anything that would escape it."""
    base = root()
    path = base.joinpath(*parts).resolve()
    if path != base and base not in path.parents:
        raise MediaError("That path is outside Media's folder.")
    return path


def valid_id(item_id):
    item_id = str(item_id or "")
    if not ID_PATTERN.match(item_id):
        raise MediaError("Unknown Media item.")
    return item_id


def new_id():
    return uuid.uuid4().hex


def media_path(item):
    valid_id(item["id"])
    try:
        return media_paths.media_path(item, root())
    except media_paths.MediaPathError as err:
        raise MediaError(str(err)) from err


def public_item(record):
    """Shared browser/job projection; private storage roots and paths never leave here."""
    keys = ("id", "kind", "name", "width", "height", "bytes", "alpha", "oriented", "created",
            "storage", "favorite", "pinned", "color", "folder", "customBadge", "nsfw", "source", "frames", "fps", "duration", "audio", "outputKey")
    result = {key: record.get(key) for key in keys if key in record}
    if record.get("storage") in ("input", "output"):
        result["filename"] = Path(record["relative_path"]).name
    return result


def thumb_path(item_id):
    return confined("thumbs", f"{valid_id(item_id)}.webp")


def incoming_dir():
    folder = confined("incoming")
    folder.mkdir(parents=True, exist_ok=True)
    return folder


def _valid_records(raw):
    return [entry for entry in raw if isinstance(entry, dict) and ID_PATTERN.match(str(entry.get("id") or ""))] \
        if isinstance(raw, list) else []


def _decode(rows):
    """Stored records -> dicts. An unreadable row is an error, never skipped: the next save
    would otherwise delete it."""
    out = []
    for (record,) in rows:
        try:
            out.append(json.loads(record))
        except ValueError as err:
            raise MediaError(f"Cannot read Media: a stored record is damaged ({err}).") from err
    return _valid_records(out)


def _read_doc():
    """The whole catalog, as one snapshot: {"items": [...], "folders": [...]}."""
    try:
        with db.read() as conn:
            items = _decode(conn.execute("SELECT record FROM media_items ORDER BY rowid").fetchall())
            raw_folders = _decode(conn.execute("SELECT record FROM media_folders ORDER BY rowid").fetchall())
    except Exception as err:  # noqa: BLE001 - shown to the user, as an unreadable index was
        raise MediaError(f"Cannot read Media: {err}") from err
    folders = [_clean_folder(entry) for entry in raw_folders]
    known = {folder["id"] for folder in folders}
    for item in items:
        # An item whose folder is gone is Unsorted ("").
        if item.get("folder") not in known:
            item["folder"] = ""
    return {"items": items, "folders": folders}


def _write_doc(doc, source=""):
    """Store ``doc`` as the whole catalog: rows that differ are written, rows that are gone
    deleted, each change noted, in one transaction (joins the caller's)."""
    with db.write() as conn:
        for table, entries, columns in (("media_items", doc["items"], ("folder",)),
                                        ("media_folders", doc["folders"], ())):
            current = dict(conn.execute(f"SELECT id, record FROM {table}").fetchall())
            wanted = {entry["id"]: json.dumps(entry, ensure_ascii=False) for entry in entries}
            kind = "folder:" if table == "media_folders" else ""
            for entry_id in current.keys() - wanted.keys():
                conn.execute(f"DELETE FROM {table} WHERE id = ?", (entry_id,))
                db.note_change(conn, STORE, f"{kind}{entry_id}", "delete", source)
            for entry in entries:
                record = wanted[entry["id"]]
                if current.get(entry["id"]) == record:
                    continue
                values = [entry["id"], *(str(entry.get(column) or "") for column in columns), record]
                names = ", ".join(("id", *columns, "record"))
                updates = ", ".join(f"{name} = excluded.{name}" for name in (*columns, "record"))
                conn.execute(f"INSERT INTO {table} ({names}) VALUES ({', '.join('?' * len(values))}) "
                             f"ON CONFLICT (id) DO UPDATE SET {updates}", values)
                db.note_change(conn, STORE, f"{kind}{entry['id']}", "save", source)


def _read():
    return _read_doc()["items"]


def _write(items):
    with locked():
        doc = _read_doc()
        doc["items"] = items
        _write_doc(doc)


def items():
    """Every item record, newest first."""
    with _lock:
        return sorted(_read(), key=lambda item: item.get("created") or 0, reverse=True)


def get(item_id):
    item_id = valid_id(item_id)
    with _lock:
        return next((item for item in _read() if item["id"] == item_id), None)


def add(record):
    """Register a completed file through the shared atomic batch path."""
    return add_many([record])[0]


def _new_record(record):
    record = dict(record)
    record["id"] = valid_id(record.get("id"))
    storage = record.get("storage") or "media"
    if storage != "media":
        try:
            record["relative_path"] = media_paths.relative_path(record.get("relative_path"))
            record.setdefault("storage_root", str(media_paths.configured_root(storage)))
        except media_paths.MediaPathError as err:
            raise MediaError(str(err)) from err
        media_path(record)
    record.setdefault("created", int(time.time() * 1000))
    for field, default in (("favorite", False), ("pinned", False), ("color", ""), ("folder", ""), ("customBadge", ""), ("nsfw", False)):
        record.setdefault(field, default)
    return record


def add_many(records):
    """Register a completed batch in one index write, or register none of it. A record whose
    folder is gone (deleted mid-save) lands in Unsorted; its file stays where it was saved."""
    records = [_new_record(record) for record in records]
    with locked():
        doc = _read_doc()
        folders_by_id = {folder["id"]: folder for folder in doc["folders"]}
        for record in records:
            folder = folders_by_id.get(record["folder"])
            if folder is None:
                record["folder"] = ""
            if any(entry["id"] == record["id"] for entry in doc["items"]):
                raise MediaError("That Media ID already exists.")
            if (record.get("storage") or "media") != "media" and any(media_path(entry) == media_path(record) for entry in doc["items"]):
                raise MediaError("That media file is already registered.")
            doc["items"].append(record)
        _write_doc(doc)
    return records


def clean_name(name):
    """A card name: one line, no control characters, at most NAME_MAX characters."""
    text = "".join(char if char.isprintable() else " " for char in str(name or ""))
    return " ".join(text.split())[:NAME_MAX]


def pin_limit():
    """NodePack's canonical limit, resolved lazily so pack load order does not matter."""
    return api().max_pinned()


def update(item_id, fields):
    """Change card attributes, badge, NSFW, name, or folder ("" = Unsorted).
    -> the record."""
    item_id = valid_id(item_id)
    changes = {key: fields[key] for key in CARD_FIELDS if key in (fields or {})}
    if "name" in changes:
        changes["name"] = clean_name(changes["name"])
        if not changes["name"]:
            raise MediaError("A name can't be empty.")
    for flag in ("favorite", "pinned", "nsfw"):
        if flag in changes and not isinstance(changes[flag], bool):
            raise MediaError(f"{flag} must be true or false.")
    if "customBadge" in changes:
        changes["customBadge"] = api().normalize_custom_badge(changes["customBadge"])
        if changes["customBadge"] is None:
            raise MediaError("Invalid custom badge (letters, numbers, spaces; 10 max; no reserved labels).")
    if "color" in changes:
        color = str(changes["color"] or "").strip().lower()
        if color and color not in api().CARD_COLOR_IDS:
            raise MediaError("Unknown card color.")
        changes["color"] = color
    with locked():
        current = _read()
        record = next((item for item in current if item["id"] == item_id), None)
        if record is None:
            raise MediaError("Unknown Media item.")
        if changes.get("pinned") and not record.get("pinned"):
            if sum(1 for item in current if item.get("pinned")) >= pin_limit():
                raise MediaError(f"Only {pin_limit()} items can be pinned.")
        if "folder" in changes:
            changes["folder"] = str(changes["folder"] or "")
            if changes["folder"] and changes["folder"] not in {folder["id"] for folder in folders()}:
                raise MediaError("That folder no longer exists.")
        for key, value in changes.items():
            record[key] = value if key in ("name", "folder", "customBadge") else str(value or "")[:32] if key == "color" else bool(value)
        _write(current)
        return dict(record)


def bulk_attributes(payload):
    """One validated attribute patch, one atomic index write; never touches media files."""
    try:
        ids, field, value = api().validate_bulk_attributes(payload)
        ids = [valid_id(item_id) for item_id in ids]
        stored_field = "color" if field == "cardColor" else field
        with locked():
            current = _read()
            records = {item["id"]: item for item in current}
            if any(item_id not in records for item_id in ids):
                raise MediaError("A selected Media item no longer exists. Refresh and select again.")
            if field == "pinned":
                api().check_bulk_pin_capacity(current, ids, value)
            updated = sum(records[item_id].get(stored_field, "" if field in ("cardColor", "customBadge") else False) != value for item_id in ids)
            for item_id in ids:
                records[item_id][stored_field] = value
            _write(current)
            return {"ok": True, "ids": ids, "updated": updated, "skipped": len(ids) - updated,
                    "items": [dict(records[item_id]) for item_id in ids]}
    except ValueError as exc:
        raise MediaError(str(exc)) from exc


# ---- folders (GAMEPLAN.md section 1): one level, id-primary; an item's "folder" is a folder
# id ("" = Unsorted). Renaming never touches the items; deleting moves them to Unsorted.
def _clean_folder(raw):
    cleaned = {
        "id": str(raw["id"]),
        "name": clean_name(raw.get("name"))[:FOLDER_NAME_MAX] or "Folder",
        "color": str(raw.get("color") or "")[:32],
        "keep": bool(raw.get("keep")),
        "pinned": bool(raw.get("pinned")),
        "created": int(raw.get("created") or 0),
    }
    if raw.get("storage") == "output":
        cleaned["storage"] = "output"
        try:
            cleaned["directory"] = media_paths.relative_path(raw.get("directory") or f"KRC-Media/{cleaned['id']}")
        except media_paths.MediaPathError as err:
            raise MediaError(str(err)) from err
    return cleaned


def folders():
    """Every folder: pinned first, then by name."""
    with _lock:
        return sorted(_read_doc()["folders"], key=lambda folder: (not folder["pinned"], folder["name"].lower()))


def _folder_name(name, current, own_id=""):
    clean = clean_name(name)[:FOLDER_NAME_MAX]
    if not clean:
        raise MediaError("A folder name can't be empty.")
    if clean.lower() in ("all", "unsorted"):
        raise MediaError(f'"{clean}" is taken by a built-in chip.')
    if any(folder["id"] != own_id and folder["name"].lower() == clean.lower() for folder in current):
        raise MediaError(f'Another folder is already called "{clean}".')
    return clean


def create_folder(name, *, storage="media"):
    if storage not in ("media", "output"):
        raise MediaError("Unknown folder storage location.")
    with locked():
        doc = _read_doc()
        folder = _clean_folder({"id": new_id(), "name": _folder_name(name, doc["folders"]),
                                "created": int(time.time() * 1000)})
        if storage == "output":
            slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", folder["name"]).strip("_") or "Output"
            folder["storage"] = "output"
            folder["directory"] = f"KRC-Media/{slug}-{folder['id']}"
        doc["folders"].append(folder)
        _write_doc(doc)
        return folder


def output_destination(folder_id, filename, *, subfolders=False):
    """Resolve a future output save without creating files or changing folder membership.
    ``folder_id`` "" is Default: DEFAULT_OUTPUT_DIRECTORY, no folder (Unsorted)."""
    with _lock:
        if folder_id:
            folder_id = valid_id(folder_id)
            folder = next((item for item in _read_doc()["folders"] if item["id"] == folder_id), None)
            if not folder or folder.get("storage") != "output":
                raise MediaError("Choose an existing output folder.")
            directory = folder["directory"]
        else:
            directory = DEFAULT_OUTPUT_DIRECTORY
        name = str(filename or "")
        if (not name or "\x00" in name or "\\" in name or Path(name).is_absolute()
                or ".." in Path(name).parts or name in (".", "..") or (not subfolders and "/" in name)):
            raise MediaError("Output destination expects a filename, without subfolders.")
        relative = f"{directory}/{name}"
        try:
            return relative, media_paths.shared_path("output", relative)
        except media_paths.MediaPathError as err:
            raise MediaError(str(err)) from err


def update_folder(folder_id, fields):
    """{name, color, keep, pinned} -> the folder."""
    folder_id = valid_id(folder_id)
    fields = fields or {}
    with locked():
        doc = _read_doc()
        folder = next((entry for entry in doc["folders"] if entry["id"] == folder_id), None)
        if folder is None:
            raise MediaError("That folder no longer exists.")
        if "name" in fields:
            folder["name"] = _folder_name(fields["name"], doc["folders"], folder_id)
        if "color" in fields:
            folder["color"] = str(fields["color"] or "")[:32]
        for flag in ("keep", "pinned"):
            if flag in fields:
                folder[flag] = bool(fields[flag])
        _write_doc(doc)
        return dict(folder)


def delete_folder(folder_id):
    """Remove a folder; its items move to Unsorted. -> how many moved (None: no such folder)."""
    folder_id = valid_id(folder_id)
    with locked():
        doc = _read_doc()
        if not any(entry["id"] == folder_id for entry in doc["folders"]):
            return None
        doc["folders"] = [entry for entry in doc["folders"] if entry["id"] != folder_id]
        moved = 0
        for item in doc["items"]:
            if item.get("folder") == folder_id:
                item["folder"] = ""
                moved += 1
        _write_doc(doc)
        return moved


def purge_folder(folder_id):
    """Delete a folder AND every item in it (records, media files, thumbnails), protected
    or not, in presets or not: the explicit, armed "PURGE". -> {"removed", "bytes"}, or None
    when there's no such folder."""
    folder_id = valid_id(folder_id)
    with locked():
        doc = _read_doc()
        if not any(entry["id"] == folder_id for entry in doc["folders"]):
            return None
        doomed = [item for item in doc["items"] if item.get("folder") == folder_id]
        for item in doomed:
            media_path(item), thumb_path(item["id"])
        doc["folders"] = [entry for entry in doc["folders"] if entry["id"] != folder_id]
        doc["items"] = [item for item in doc["items"] if item.get("folder") != folder_id]
        _write_doc(doc)
    freed = 0
    for item in doomed:
        for path in (media_path(item), thumb_path(item["id"])):
            try:
                if path.is_file():
                    freed += path.stat().st_size
                path.unlink(missing_ok=True)
            except OSError as exc:
                print(f"[KRC Media] purge: couldn't remove {path.name}: {exc}")
    return {"removed": len(doomed), "bytes": freed}


def delete(item_id):
    """Remove one item: its record, media file and thumbnail. -> whether it existed."""
    item_id = valid_id(item_id)
    with locked():
        current = _read()
        record = next((item for item in current if item["id"] == item_id), None)
        if record is None:
            return False
        media_path(record), thumb_path(item_id)
        _write([item for item in current if item["id"] != item_id])
    for warning in _remove_media_files([record]):
        print(f"[KRC Media] {warning}")
    return True


def bulk_operation(payload, *, preview=False):
    """Move memberships or explicitly delete selected records/files, never user inputs."""
    if not isinstance(payload, dict) or payload.get("operation") not in ("move", "delete"):
        raise MediaError("Unsupported Media operation.")
    ids = [valid_id(item_id) for item_id in api().validate_card_ids(payload.get("ids"))]
    operation = payload["operation"]
    if not preview and operation == "delete" and payload.get("confirmed") is not True:
        raise MediaError("Confirm deletion before continuing.")
    selected = set(ids)
    with locked():
        doc = _read_doc()
        records = {item["id"]: item for item in doc["items"]}
        if any(item_id not in records for item_id in ids):
            raise MediaError("A selected Media item no longer exists. Refresh and select again.")
        doomed = [records[item_id] for item_id in ids]
        if preview:
            from . import preset_store
            references = [preset for preset in preset_store.presets()
                          if any(slot["id"] in selected for slot in preset["payload"]["slots"])]
            referenced = selected & preset_store.used_ids()
            kept_folders = {folder["id"] for folder in doc["folders"] if folder.get("keep")}
            protected = sum(bool(item.get("favorite") or item.get("pinned") or item.get("folder") in kept_folders) for item in doomed)
            message = (f"Permanently deletes {len(ids)} stored media files and their thumbnails. "
                       f"{len(referenced)} selected items are used by {len(references)} saved presets; "
                       f"{protected} are favorites, pinned or in Keep folders. Explicit deletion includes these items. "
                       "Preset and workflow references remain unchanged and will report missing media when loaded. This cannot be undone."
                       if operation == "delete" else "Changes folder membership only. Files keep their IDs, names and storage paths; preset references remain valid.")
            return {"ok": True, "count": len(ids), "referenced": len(referenced),
                    "message": message, "destinations": [{"value": "", "label": "Unsorted"}] +
                    [{"value": folder["id"], "label": folder["name"]} for folder in doc["folders"]]}
        if operation == "move":
            destination = payload.get("destination")
            if not isinstance(destination, str) or (destination and destination not in {folder["id"] for folder in doc["folders"]}):
                raise MediaError("That destination folder no longer exists.")
            updated = sum((item.get("folder") or "") != destination for item in doomed)
            for item in doomed:
                item["folder"] = destination
        else:
            # Confine every path before committing any deletion, as in individual Delete.
            for item in doomed:
                media_path(item), thumb_path(item["id"])
            updated = len(ids)
            doc["items"] = [item for item in doc["items"] if item["id"] not in selected]
        if updated:
            _write_doc(doc)
    warnings = _remove_media_files(doomed) if operation == "delete" else []
    return {"ok": True, "ids": ids, "updated": updated, "skipped": len(ids) - updated,
            "deleted": ids if operation == "delete" else [], "warnings": warnings}


def _remove_media_files(records):
    """Shared Delete cleanup. Surface filesystem failures instead of claiming removal."""
    warnings = []
    for record in records:
        for path in (media_path(record), thumb_path(record["id"])):
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                warnings.append(f"Record {record['id']} was deleted, but {path.name} could not be removed: {exc}")
    return warnings


def kept_by_flush(item):
    """A normal Flush spares favourites and pinned items (GAMEPLAN.md section 6)."""
    return bool(item.get("favorite") or item.get("pinned"))


def flush(everything=False, protected=frozenset()):
    """Empty the Media: every item except favourites and pinned ones (all of them with
    ``everything``), the ``protected`` ids (what presets use) and the items in folders
    marked Keep (those two always), and any stray file in files/ or thumbs/ that no kept
    record owns. -> {"removed", "kept", "bytes"} (bytes freed)."""
    with locked():
        doc = _read_doc()
        current = doc["items"]
        kept_folders = {folder["id"] for folder in doc["folders"] if folder["keep"]}
        keep = [item for item in current if item["id"] in protected or item.get("folder") in kept_folders
                or (not everything and kept_by_flush(item))]
        drop = [item for item in current if item not in keep]
        for item in drop:
            media_path(item), thumb_path(item["id"])
        doc["items"] = keep
        _write_doc(doc)
    freed = 0
    for item in drop:
        if (item.get("storage") or "media") == "media":
            continue
        try:
            path = media_path(item)
            if path.is_file():
                freed += path.stat().st_size
            path.unlink(missing_ok=True)
        except (OSError, MediaError) as err:
            print(f"[KRC Media] flush: could not remove tracked shared media: {err}")
    # Serialize the orphan sweep with newly completed batch registrations.
    with _lock:
        owned = {item["id"] for item in _read()}
        for folder in ("files", "thumbs"):
            try:
                directory = confined(folder)
            except MediaError:
                continue
            if not directory.is_dir():
                continue
            for entry in directory.iterdir():
                item_id = entry.name.split(".", 1)[0]
                if item_id in owned or not entry.is_file():
                    continue
                try:
                    freed += entry.stat().st_size
                    entry.unlink()
                except OSError as exc:
                    print(f"[KRC Media] flush: couldn't remove {entry.name}: {exc}")
    return {"removed": len(drop), "kept": len(keep), "bytes": freed}


def reconcile_missing():
    """Remove confirmed-missing records/cached thumbs on refresh; never heal filenames."""
    with locked():
        doc = _read_doc()
        absent = []
        available = {}
        for item in doc["items"]:
            storage = item.get("storage") or "media"
            try:
                base = root() if storage == "media" else media_paths.configured_root(storage)
                if storage not in available:
                    available[storage] = media_paths.storage_available(base)
                if not available[storage]:
                    continue
                path = media_path(item)
                path.stat()
            except FileNotFoundError:
                absent.append(item["id"])
            except (OSError, MediaError, media_paths.MediaPathError):
                # Access errors, changed roots and invalid records are not deletion.
                continue
        if not absent:
            return []
        missing = set(absent)
        doc["items"] = [item for item in doc["items"] if item["id"] not in missing]
        _write_doc(doc)
    for item_id in absent:
        try:
            thumb_path(item_id).unlink(missing_ok=True)
        except OSError as err:
            print(f"[KRC Media] missing media thumbnail cleanup failed: {err}")
    return absent


def clean_incoming():
    """At startup: no upload can be converting yet, so anything in incoming/ is left over."""
    try:
        folder = confined("incoming")
    except Exception:  # noqa: BLE001 - NodePack not loaded: nothing to clean
        return 0
    if not folder.is_dir():
        return 0
    removed = 0
    for entry in folder.iterdir():
        try:
            shutil.rmtree(entry) if entry.is_dir() else entry.unlink()
            removed += 1
        except OSError:
            pass
    return removed
