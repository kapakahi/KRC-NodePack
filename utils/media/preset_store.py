"""Media presets (GAMEPLAN.md section 4): global stacks of exactly 6 slots that KRC Media
Loader nodes read. Stored in krc.db's presets table as kind "media" (like every KRC preset
store; MEDIA_INTO_NODEPACK_GAMEPLAN.md stage 2).

A preset is id-primary like every KRC preset:

    {"id", "group", "name", "created", "auto", "payload": {"slots": [{"name", "id"}] x 6}}

``id`` in a slot is a Media item ("" = empty); a slot's ``name`` is always "Slot n" (slots
aren't renamed; a stored name is reset). There are no Modified states: every change
is written right away. ``auto`` marks a preset a new node created ("Untitled n"); it's
cleared by the first change, and an untouched auto preset is pruned at startup.

Writes run inside the Media store's ``locked()`` (its lock and one krc.db transaction), so
Flush and Purge (which spare what presets use) see the presets and the items at one moment.

``version(preset)`` is a short hash of what a client sees (group, name, slot ids). A write
given ``if_version`` (the external API's, a Media Loader's Upload) is refused with PresetConflict when the preset
changed since the client read it, checked under the same lock as the write.
"""

import hashlib
import json
import re
import time
import uuid

from ..db import presets as preset_rows
from . import media_store as store

KIND = "media"
SLOT_COUNT = 6
NAME_MAX = 60
ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
AUTO_NAME = re.compile(r"^Untitled( \d+)?$")


class PresetError(ValueError):
    """A request the presets refuse; the message is shown to the user."""


class PresetConflict(PresetError):
    """The preset changed since the client read it (``if_version`` didn't match);
    ``current`` is the preset as it is now."""

    def __init__(self, current):
        super().__init__("That preset changed since you read it. Read it again, then retry.")
        self.current = current


def version(record):
    """A short hash of the preset's group, name and slot ids: changes whenever any does."""
    seen = {"group": record.get("group") or "", "name": record.get("name") or "",
            "slots": [slot.get("id") or "" for slot in (record.get("payload") or {}).get("slots") or []]}
    return hashlib.sha1(json.dumps(seen, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def _default_slots():
    return [{"name": f"Slot {index + 1}", "id": ""} for index in range(SLOT_COUNT)]


def _clean_slots(raw):
    """Exactly SLOT_COUNT {name, id}: junk dropped, missing ones filled, names "Slot n"."""
    slots = _default_slots()
    for index, slot in enumerate(raw[:SLOT_COUNT] if isinstance(raw, list) else []):
        if not isinstance(slot, dict):
            continue
        item_id = str(slot.get("id") or "")
        slots[index]["id"] = item_id if store.ID_PATTERN.match(item_id) else ""
    return slots


def _clean(record):
    return {
        "id": record["id"],
        "group": store.clean_name(record.get("group"))[:NAME_MAX],
        "name": store.clean_name(record.get("name"))[:NAME_MAX] or "Untitled",
        "created": int(record.get("created") or 0),
        "auto": bool(record.get("auto")),
        "payload": {"slots": _clean_slots((record.get("payload") or {}).get("slots"))},
    }


def _read():
    return [_clean(item) for item in preset_rows.load_records(KIND) if ID_PATTERN.match(str(item.get("id") or ""))]


def _write(presets):
    preset_rows.save_records(KIND, presets)


def valid_id(preset_id):
    preset_id = str(preset_id or "")
    if not ID_PATTERN.match(preset_id):
        raise PresetError("Unknown preset.")
    return preset_id


def presets():
    """Every preset, oldest first (creation order)."""
    with store._lock:
        return sorted(_read(), key=lambda item: item["created"])


def get(preset_id):
    preset_id = valid_id(preset_id)
    with store._lock:
        return next((item for item in _read() if item["id"] == preset_id), None)


def resolve(value):
    """The preset a Follow input names: an id, else a name (case-insensitive; "group/name"
    too). None when nothing matches."""
    text = store.clean_name(value)
    if not text:
        return None
    with store._lock:
        current = _read()
    if ID_PATTERN.match(text):
        found = next((item for item in current if item["id"] == text), None)
        if found:
            return found
    lowered = text.lower()
    for item in current:
        if item["name"].lower() == lowered or (item["group"] and f"{item['group']}/{item['name']}".lower() == lowered):
            return item
    return None


def _free_name(current, base="Untitled"):
    taken = {item["name"].lower() for item in current}
    if base.lower() not in taken:
        return base
    number = 2
    while f"{base} {number}".lower() in taken:
        number += 1
    return f"{base} {number}"


def _numbered_name(current, base="Preset"):
    """"Preset 1", else the first free "Preset n"."""
    taken = {item["name"].lower() for item in current}
    number = 1
    while f"{base} {number}".lower() in taken:
        number += 1
    return f"{base} {number}"


def create(name="", auto=False, numbered=False):
    """A new preset with 6 empty slots. With no name: "Preset n" when ``numbered`` (an upload
    that found no preset), else "Untitled n" (a new node's). -> the preset."""
    with store.locked():
        current = _read()
        clean = store.clean_name(name)[:NAME_MAX]
        record = _clean({
            "id": uuid.uuid4().hex,
            "name": clean if clean else _numbered_name(current) if numbered else _free_name(current),
            "created": int(time.time() * 1000),
            "auto": auto and not clean,
            "payload": {"slots": _default_slots()},
        })
        current.append(record)
        _write(current)
        return record


def _change(preset_id, mutate, if_version=None):
    preset_id = valid_id(preset_id)
    with store.locked():
        current = _read()
        record = next((item for item in current if item["id"] == preset_id), None)
        if record is None:
            raise PresetError("That preset no longer exists.")
        if if_version is not None and version(record) != if_version:
            raise PresetConflict(dict(record))
        mutate(record, current)
        record["auto"] = False
        _write(current)
        return dict(record)


def rename(preset_id, name, if_version=None):
    clean = store.clean_name(name)[:NAME_MAX]
    if not clean:
        raise PresetError("A preset name can't be empty.")

    def mutate(record, current):
        if any(item["id"] != record["id"] and item["name"].lower() == clean.lower() for item in current):
            raise PresetError(f'Another preset is already called "{clean}".')
        record["name"] = clean

    return _change(preset_id, mutate, if_version)


def set_slot(preset_id, index, *, item_id=None, if_version=None):
    """Fill / empty slot ``index`` (0-5; ``item_id`` "" empties it). With ``if_version``
    (a Media Loader's multi-file Upload, the external API) a changed preset is refused."""
    try:
        index = int(index)
    except (TypeError, ValueError):
        index = -1
    if not 0 <= index < SLOT_COUNT:
        raise PresetError("A preset has slots 1 to 6.")
    if item_id is not None:
        item_id = str(item_id or "")
        if item_id:
            store.valid_id(item_id)
    def mutate(record, _current):
        slots = record["payload"]["slots"]
        if item_id is not None:
            slots[index]["id"] = item_id

    return _change(preset_id, mutate, if_version)


def set_slots(preset_id, ids, *, start=None, if_version=None):
    """Atomically replace six references, or patch 1–6 slots with wraparound."""
    if not isinstance(ids, list) or any(not isinstance(item_id, str) for item_id in ids):
        raise PresetError("Supply media references as a list.")
    if start is None:
        if len(ids) != SLOT_COUNT:
            raise PresetError("Supply exactly six media references.")
        start = 0
    elif type(start) is not int or not 0 <= start < SLOT_COUNT or not 1 <= len(ids) <= SLOT_COUNT:
        raise PresetError("Drop one to six media items onto a slot from 1 to 6.")
    for item_id in ids:
        if item_id:
            store.valid_id(item_id)

    def mutate(record, _current):
        # Only incoming references are checked: untouched slots may intentionally
        # retain missing media. Validate and patch under the same store lock.
        if any(item_id and store.get(item_id) is None for item_id in ids):
            raise PresetError("One or more media items no longer exist.")
        slots = record["payload"]["slots"]
        for offset, item_id in enumerate(ids):
            slots[(start + offset) % SLOT_COUNT]["id"] = item_id

    return _change(preset_id, mutate, if_version)


def delete(preset_id, if_version=None):
    preset_id = valid_id(preset_id)
    with store.locked():
        current = _read()
        record = next((item for item in current if item["id"] == preset_id), None)
        if record is None:
            return False
        if if_version is not None and version(record) != if_version:
            raise PresetConflict(dict(record))
        _write([item for item in current if item["id"] != preset_id])
        return True


def used_ids():
    """Every Media item a preset uses (Flush spares them)."""
    with store._lock:
        return {slot["id"] for item in _read() for slot in item["payload"]["slots"] if slot["id"]}


def untouched(record):
    """An auto preset nobody changed: still auto, no media."""
    return record["auto"] and not any(slot["id"] for slot in record["payload"]["slots"])


def prune_untouched():
    """At startup: drop auto presets nobody changed (a node that finds its preset gone shows
    "Missing preset", and nothing of value was in it). -> how many."""
    with store.locked():
        current = _read()
        kept = [item for item in current if not untouched(item)]
        if len(kept) != len(current):
            _write(kept)
        return len(current) - len(kept)


def flush_media(everything=False):
    """The Media's Flush, sparing every item a preset uses (one lock for both files)."""
    with store.locked():
        return store.flush(everything, protected=used_ids())
