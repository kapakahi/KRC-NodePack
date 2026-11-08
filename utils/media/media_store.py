"""Media's catalog (items and folders) lives in krc.db (tables media_items / media_folders,
MEDIA_INTO_NODEPACK_GAMEPLAN.md stage 2); thumbnails and transient uploads in KRC's private
data folder. Files live in ComfyUI's input (uploads) and output (generated) directories, under
KRC-Media/: an item in a folder sits in KRC-Media/<folder name>/, an Unsorted one loose in
KRC-Media/ (2026-11-01). Moving an item, renaming or deleting a folder moves the files to
match. Presets reference stable record IDs, independently of filesystem paths.

Every read-modify-save runs inside :func:`locked`: one write transaction (so a write from
another thread can't land between the read and the save), and the thread lock the files
next to the records rely on. Files are removed only after the transaction commits.

``item_version`` / ``folder_version`` are short hashes of what a client sees and can edit.
A write given ``if_version`` (the external API's) is refused with MediaConflict when the
record changed since the client read it, checked under the same lock as the write.
"""

import hashlib
import json
import os
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
# Unsorted media (an upload with no folder, Media Output's "Default") sits loose here, under
# ComfyUI's input / output directory; a folder's files in KRC-Media/<folder name>/.
UNSORTED_DIRECTORY = media_paths.MANAGED_DIRECTORY
DEFAULT_OUTPUT_DIRECTORY = UNSORTED_DIRECTORY
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


class MediaConflict(MediaError):
    """The item / folder changed since the client read it (``if_version`` didn't match);
    ``current`` is the record as it is now (the full stored record: callers project it, e.g.
    public_item, before it leaves the server)."""

    def __init__(self, current, noun="item"):
        super().__init__(f"That {noun} changed since you read it. Read it again, then retry.")
        self.current = current


def _short_hash(value):
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def item_version(record):
    """A short hash of an item's editable fields (name, folder and the card attributes)."""
    return _short_hash({key: record.get(key) for key in CARD_FIELDS})


def folder_version(folder):
    """A short hash of a folder's editable fields."""
    return _short_hash({key: folder.get(key) for key in ("name", "color", "keep", "pinned")})


def _check_version(record, if_version, version, current, noun):
    if if_version is not None and version(record) != if_version:
        raise MediaConflict(current, noun)


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


def update(item_id, fields, if_version=None):
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
        doc = _read_doc()
        current = doc["items"]
        record = next((item for item in current if item["id"] == item_id), None)
        if record is None:
            raise MediaError("Unknown Media item.")
        _check_version(record, if_version, item_version, dict(record), "item")
        if changes.get("pinned") and not record.get("pinned"):
            if sum(1 for item in current if item.get("pinned")) >= pin_limit():
                raise MediaError(f"Only {pin_limit()} items can be pinned.")
        if "folder" in changes:
            changes["folder"] = str(changes["folder"] or "")
            _check_destination(doc, [record], changes["folder"])
        for key, value in changes.items():
            record[key] = value if key in ("name", "folder", "customBadge") else str(value or "")[:32] if key == "color" else bool(value)
        with _moving(doc, [record] if "folder" in changes else []):
            _write_doc(doc)
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
# id ("" = Unsorted). A folder belongs to one side (Input, or Output: storage "output") and is a
# real directory on that side: KRC-Media/<name>. Renaming renames it; deleting moves its
# files to KRC-Media/ (Unsorted).
_FORBIDDEN_CHARACTERS = set('<>:"/\\|?*')
_RESERVED_NAMES = {"con", "prn", "aux", "nul", *(f"com{n}" for n in range(1, 10)), *(f"lpt{n}" for n in range(1, 10))}


def folder_dirname(name):
    """A folder name as a directory name that works on every OS: characters Windows forbids
    become "_", no trailing dots / spaces, never a reserved device name (CON, NUL, COM1...)."""
    text = "".join("_" if char in _FORBIDDEN_CHARACTERS or not char.isprintable() else char for char in str(name or ""))
    text = text.strip().rstrip(". ") or "Folder"
    if text.split(".", 1)[0].lower() in _RESERVED_NAMES:
        text += "_"
    return text[:FOLDER_NAME_MAX]


def folder_side(folder):
    return "output" if folder.get("storage") == "output" else "input"


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
        cleaned["directory"] = media_paths.relative_path(raw.get("directory") or f"{UNSORTED_DIRECTORY}/{folder_dirname(cleaned['name'])}")
    except media_paths.MediaPathError as err:
        raise MediaError(str(err)) from err
    return cleaned


def folders():
    """Every folder: pinned first, then by name."""
    with _lock:
        return sorted(_read_doc()["folders"], key=lambda folder: (not folder["pinned"], folder["name"].lower()))


def _folder_name(name, current, own_id="", side="input"):
    clean = clean_name(name)[:FOLDER_NAME_MAX]
    if not clean:
        raise MediaError("A folder name can't be empty.")
    if clean.lower() in ("all", "unsorted"):
        raise MediaError(f'"{clean}" is taken by a built-in chip.')
    if any(folder["id"] != own_id and folder["name"].lower() == clean.lower() for folder in current):
        raise MediaError(f'Another folder is already called "{clean}".')
    directory = folder_dirname(clean).lower()
    if any(folder["id"] != own_id and folder_side(folder) == side and folder_dirname(folder["name"]).lower() == directory
           for folder in current):
        raise MediaError(f'Another folder already uses the directory name "{folder_dirname(clean)}".')
    return clean


# ---- files follow their folders --------------------------------------------------------
def item_side(item):
    """"input" / "output" for a file in ComfyUI's input / output directory; None for one in
    Media's private folder (storage "media"), which has no on-disk folders."""
    storage = item.get("storage") or "media"
    return storage if storage in ("input", "output") else None


def _home_directory(item, folders_by_id):
    """Where ``item``'s file belongs: its folder's directory on its own side, else loose."""
    folder = folders_by_id.get(item.get("folder") or "")
    return folder["directory"] if folder and folder_side(folder) == item_side(item) else UNSORTED_DIRECTORY


def _free_name(side, directory, inner, taken):
    """``directory/inner``, numbered (name_2.ext, name_3.ext...) when another record or any
    file already holds it: a move never overwrites. ``inner`` may keep subfolders (a Media
    Output prefix like shots/%date%)."""
    head, _, filename = inner.rpartition("/")
    stem, suffix = os.path.splitext(filename)
    for number in range(1, 10000):
        name = filename if number == 1 else f"{stem}_{number}{suffix}"
        candidate = "/".join(part for part in (directory, head, name) if part)
        if (side, candidate.lower()) in taken:
            continue
        try:
            if media_paths.shared_path(side, candidate).exists():
                continue
        except media_paths.MediaPathError as err:
            raise MediaError(str(err)) from err
        return candidate
    raise MediaError(f"No free file name for {filename} in {directory}.")


def _split_base(path, bases):
    """(the folder directory ``path`` sits under, the rest of the path below it). ``bases``:
    folder directories (and a renamed / deleted folder's old one); a path under none of them
    is Unsorted (loose in KRC-Media)."""
    lowered = path.lower()
    for base in sorted(bases, key=len, reverse=True):
        if lowered.startswith(base.lower() + "/"):
            return base, path[len(base) + 1:]
    return UNSORTED_DIRECTORY, path[len(UNSORTED_DIRECTORY) + 1:] if lowered.startswith(UNSORTED_DIRECTORY.lower() + "/") else Path(path).name


def _relocate(doc, records, old_directories=()):
    """Move each of ``records``' files to its folder's directory (records in ``doc``), keeping
    any subfolders below its old folder, and update relative_path. ``old_directories``: a
    renamed / deleted folder's previous directory, still where its files are. -> the moves
    done, for _undo_moves when the catalog write fails. A file that isn't there stays put."""
    folders_by_id = {folder["id"]: folder for folder in doc["folders"]}
    wanted_ids = {record["id"] for record in records}
    taken = {(item_side(item), str(item.get("relative_path") or "").lower())
             for item in doc["items"] if item_side(item) and item["id"] not in wanted_ids}
    moves = []
    try:
        for record in records:
            side = item_side(record)
            if not side:
                continue
            current = str(record.get("relative_path") or "")
            bases = {folder["directory"] for folder in doc["folders"] if folder_side(folder) == side}
            bases.update(old_directories)
            base, inner = _split_base(current, bases)
            home = _home_directory(record, folders_by_id)
            if base.lower() == home.lower() and base not in old_directories:
                taken.add((side, current.lower()))
                continue
            source = media_paths.shared_path(side, current, record.get("storage_root", ""))
            if not source.is_file():
                taken.add((side, current.lower()))
                continue
            target_relative = _free_name(side, home, inner, taken)
            target = media_paths.shared_path(side, target_relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            os.replace(source, target)
            moves.append((source, target, record, current))
            record["relative_path"] = target_relative
            taken.add((side, target_relative.lower()))
    except (OSError, media_paths.MediaPathError) as err:
        _undo_moves(moves)
        raise MediaError(f"Couldn't move a file to its folder: {err}") from err
    return moves


def _undo_moves(moves):
    for source, target, record, old in reversed(moves):
        try:
            os.replace(target, source)
            record["relative_path"] = old
        except OSError as err:
            print(f"[KRC Media] couldn't move {target.name} back: {err}")


@contextmanager
def _moving(doc, records, old_directories=()):
    """Relocate ``records``, then let the caller write the catalog; a failed write moves the
    files back."""
    moves = _relocate(doc, records, old_directories)
    try:
        yield moves
    except BaseException:
        _undo_moves(moves)
        raise


def _side_directory(side, relative):
    """A folder's directory on its side, or None (an invalid path, or no ComfyUI to ask)."""
    try:
        return media_paths.shared_path(side, relative)
    except (media_paths.MediaPathError, ImportError):
        return None


def _same_directory(first, second):
    try:
        return os.path.samefile(first, second)
    except OSError:
        return False


def _remove_if_empty(side, relative):
    """Remove a folder's directory once nothing is left in it (only an empty one)."""
    directory = _side_directory(side, relative)
    try:
        if directory and directory.is_dir() and not any(directory.iterdir()):
            directory.rmdir()
    except OSError:
        pass


def _check_destination(doc, records, destination):
    """A move target must exist and be on the items' own side (an Input file never moves
    into an Output folder, or back)."""
    if not destination:
        return
    folder = next((entry for entry in doc["folders"] if entry["id"] == destination), None)
    if folder is None:
        raise MediaError("That destination folder no longer exists.")
    if any(item_side(record) and item_side(record) != folder_side(folder) for record in records):
        raise MediaError("Input media and Output media stay on their own side: pick a folder from the same view.")


def create_folder(name, *, storage="media"):
    if storage not in ("media", "output"):
        raise MediaError("Unknown folder storage location.")
    side = "output" if storage == "output" else "input"
    with locked():
        doc = _read_doc()
        folder = _clean_folder({"id": new_id(), "name": _folder_name(name, doc["folders"], side=side),
                                "created": int(time.time() * 1000), **({"storage": "output"} if storage == "output" else {})})
        directory = _side_directory(side, folder["directory"])
        if directory is not None:
            try:
                directory.mkdir(parents=True, exist_ok=True)
            except OSError as err:
                raise MediaError(f"Couldn't create the folder's directory: {err}") from err
        doc["folders"].append(folder)
        _write_doc(doc)
        return folder


def upload_directory(folder_id):
    """Where a new upload into ``folder_id`` goes: that Input folder's directory, else loose
    in KRC-Media/ (Unsorted; an unknown or Output folder too)."""
    if not ID_PATTERN.match(str(folder_id or "")):
        return UNSORTED_DIRECTORY
    with _lock:
        folder = next((entry for entry in _read_doc()["folders"] if entry["id"] == folder_id), None)
    return folder["directory"] if folder and folder_side(folder) == "input" else UNSORTED_DIRECTORY


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


def update_folder(folder_id, fields, if_version=None):
    """{name, color, keep, pinned} -> the folder. A new name renames its directory too, and
    every file in it follows."""
    folder_id = valid_id(folder_id)
    fields = fields or {}
    with locked():
        doc = _read_doc()
        folder = next((entry for entry in doc["folders"] if entry["id"] == folder_id), None)
        if folder is None:
            raise MediaError("That folder no longer exists.")
        _check_version(folder, if_version, folder_version, dict(folder), "folder")
        side = folder_side(folder)
        old_directory = folder["directory"]
        if "name" in fields:
            folder["name"] = _folder_name(fields["name"], doc["folders"], folder_id, side=side)
            folder["directory"] = f"{UNSORTED_DIRECTORY}/{folder_dirname(folder['name'])}"
        if "color" in fields:
            folder["color"] = str(fields["color"] or "")[:32]
        for flag in ("keep", "pinned"):
            if flag in fields:
                folder[flag] = bool(fields[flag])
        members = [item for item in doc["items"] if item.get("folder") == folder_id and item_side(item) == side]
        renamed = folder["directory"] != old_directory
        old_path, new_path = _side_directory(side, old_directory), _side_directory(side, folder["directory"])
        # Rename the directory itself in one step (it also handles a capitals-only rename on a
        # case-insensitive disk); move file by file only when the new name is taken on disk.
        whole = bool(renamed and old_path and new_path and old_path.is_dir()
                     and (not new_path.exists() or _same_directory(old_path, new_path)))
        previous = {item["id"]: item.get("relative_path") for item in members}
        if whole:
            try:
                os.replace(old_path, new_path)
            except OSError as err:
                raise MediaError(f"Couldn't rename the folder's directory: {err}") from err
            for item in members:
                path = str(item.get("relative_path") or "")
                if path.startswith(old_directory + "/"):
                    item["relative_path"] = folder["directory"] + path[len(old_directory):]
        try:
            with _moving(doc, members, (old_directory,) if renamed and not whole else ()):
                _write_doc(doc)
        except BaseException:
            if whole:
                try:
                    os.replace(new_path, old_path)
                except OSError as err:
                    print(f"[KRC Media] couldn't rename {new_path.name} back: {err}")
                for item in members:
                    item["relative_path"] = previous[item["id"]]
            raise
        if renamed and not whole:
            _remove_if_empty(side, old_directory)
        return dict(folder)


def delete_folder(folder_id, if_version=None):
    """Remove a folder; its items move to Unsorted, their files loose into KRC-Media/, and
    the emptied directory goes. -> how many moved (None: no such folder)."""
    folder_id = valid_id(folder_id)
    with locked():
        doc = _read_doc()
        folder = next((entry for entry in doc["folders"] if entry["id"] == folder_id), None)
        if folder is None:
            return None
        _check_version(folder, if_version, folder_version, dict(folder), "folder")
        doc["folders"] = [entry for entry in doc["folders"] if entry["id"] != folder_id]
        members = [item for item in doc["items"] if item.get("folder") == folder_id]
        for item in members:
            item["folder"] = ""
        with _moving(doc, members, (folder["directory"],)):
            _write_doc(doc)
    _remove_if_empty(folder_side(folder), folder["directory"])
    return len(members)


def purge_folder(folder_id, if_version=None):
    """Delete a folder AND every item in it (records, media files, thumbnails), protected
    or not, in presets or not: the explicit, armed "PURGE". -> {"removed", "bytes"}, or None
    when there's no such folder."""
    folder_id = valid_id(folder_id)
    with locked():
        doc = _read_doc()
        if not any(entry["id"] == folder_id for entry in doc["folders"]):
            return None
        folder = next(entry for entry in doc["folders"] if entry["id"] == folder_id)
        _check_version(folder, if_version, folder_version, dict(folder), "folder")
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
    _remove_if_empty(folder_side(folder), folder["directory"])
    return {"removed": len(doomed), "bytes": freed}


def delete(item_id, if_version=None):
    """Remove one item: its record, media file and thumbnail. -> whether it existed."""
    item_id = valid_id(item_id)
    with locked():
        current = _read()
        record = next((item for item in current if item["id"] == item_id), None)
        if record is None:
            return False
        _check_version(record, if_version, item_version, dict(record), "item")
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
                       if operation == "delete" else "Moves the files into the folder's directory (KRC-Media/<folder>; Unsorted = loose in KRC-Media). IDs and names stay, so preset references remain valid.")
            return {"ok": True, "count": len(ids), "referenced": len(referenced),
                    "message": message, "destinations": [{"value": "", "label": "Unsorted"}] +
                    [{"value": folder["id"], "label": folder["name"]} for folder in doc["folders"]]}
        if operation == "move":
            destination = payload.get("destination")
            if not isinstance(destination, str):
                raise MediaError("That destination folder no longer exists.")
            _check_destination(doc, doomed, destination)
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
            with _moving(doc, doomed if operation == "move" else []):
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


def file_missing(item, available):
    """Whether ``item``'s file is confirmed gone: its storage root is reachable and the file
    isn't there. An unreachable root (an offline drive), an access error, a changed root or
    an invalid record is NOT missing. ``available`` caches each root's check across calls.
    Read-only; reconcile_missing (the node's list) and the external API share this rule."""
    storage = item.get("storage") or "media"
    try:
        base = root() if storage == "media" else media_paths.configured_root(storage)
        if storage not in available:
            available[storage] = media_paths.storage_available(base)
        if not available[storage]:
            return False
        media_path(item).stat()
    except FileNotFoundError:
        return True
    except (OSError, ImportError, MediaError, media_paths.MediaPathError):
        # Access errors, changed roots, no ComfyUI and invalid records are not deletion.
        return False
    return False


def reconcile_missing():
    """Remove confirmed-missing records/cached thumbs on refresh; never heal filenames."""
    with locked():
        doc = _read_doc()
        available = {}
        absent = [item["id"] for item in doc["items"] if file_missing(item, available)]
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
