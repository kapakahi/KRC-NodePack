"""Shared vocabulary for the KRC bundle's library sections (UNIFIED_BUNDLE_GAMEPLAN.md):
the LoRA library (lora_loadout/zip.py) and the Model Library (model_library/zip.py).

Their bodies differ (record source, store, companion files), so each keeps its own section
writer and import plan; what's shared lives here: the folder layout inside a section,
import_record (a bundle never brings this machine's MACHINE_FIELDS), the empty-field merge,
the thumbnail signature check.

History (dates + usage counts) is shared too: both bundles carry an optional
``usage.json`` ({library id: {count, lastUsedMs}}), and an import can keep or ignore the
bundle's dates and usage (``imported_dates`` / ``import_usage``).
"""

import json

from ..archive_guard import read_json_entry
from .metadata import DEFAULT_VOLATILE_FIELDS, QUICK_META_FIELDS
from .usage_stats import load_usage_section, set_usage

METADATA_ARCHIVE_NAME = "metadata.json"
THUMBNAILS_ARCHIVE_DIR = "thumbnails"
ANIMATED_THUMBNAILS_ARCHIVE_DIR = "animated_thumbnails"
ANIMATED_THUMBNAIL_ARCHIVE_SUFFIX = ".webm"


def thumbnail_member_ok(archive, name, extension):
    """Whether a bundle's thumbnail file really is what its name says: a WebP image
    (RIFF....WEBP) or a WebM loop (EBML). Anything else (a renamed page, script or
    archive) is skipped, and the record keeps the thumbnail it has."""
    try:
        with archive.open(name) as handle:
            head = handle.read(12)
    except (KeyError, OSError, RuntimeError, ValueError):
        return False
    extension = str(extension or "").lower()
    if extension == ".webp":
        return head[:4] == b"RIFF" and head[8:12] == b"WEBP"
    if extension == ANIMATED_THUMBNAIL_ARCHIVE_SUFFIX:
        return head[:4] == b"\x1a\x45\xdf\xa3"
    return False


def thumbnail_archive_dir(suffix):
    """The archive subdir for a thumbnail with this file suffix: the animated dir for
    a webm loop, the poster dir otherwise. Case-insensitive on the suffix."""
    if str(suffix or "").lower() == ANIMATED_THUMBNAIL_ARCHIVE_SUFFIX:
        return ANIMATED_THUMBNAILS_ARCHIVE_DIR
    return THUMBNAILS_ARCHIVE_DIR


# Facts about THIS machine's files: where the model and its thumbnail source live, and the
# thumbnail pipeline's state for that source. Only a local scan sets them; a bundle (a
# zip someone shared) never does, or it could point "Refresh thumbnail" / poster
# extraction at any file on the disk. Imports keep the local values (or none).
MACHINE_FIELDS = (
    "path", "file", "relative_path", "relativePath",
    "thumbnailSourcePath", "thumbnailSourceType", "thumbnailPosterSourcePath",
    "thumbnailNeedsPoster", "thumbnailPosterExtracted",
    "thumbnailPosterExtractedAt",
)


def import_record(local, incoming, overwrite):
    """The record an import writes: the bundle's portable fields (all of them on
    overwrite, only the empty local ones on merge) with this machine's MACHINE_FIELDS
    kept exactly as they are locally."""
    local = dict(local or {})
    portable = {key: value for key, value in (incoming or {}).items() if key not in MACHINE_FIELDS}
    merged = dict(portable) if overwrite else merge_empty_fields(local, portable)
    for key in MACHINE_FIELDS:
        if key in local:
            merged[key] = local[key]
        else:
            merged.pop(key, None)
    return merged


def merge_empty_fields(local, incoming):
    """Merge mode: fill only fields that are absent or empty locally, so a merge
    import never overwrites a user's existing edits. Returns a new dict."""
    merged = dict(local)
    for key, value in incoming.items():
        if key not in merged or merged[key] in ("", None, [], {}):
            merged[key] = value
    return merged


# ---- history: dates + usage counts ---------------------------------------------------------

# Optional bundle entry (not in requiredFiles): an older bundle without it imports fine.
USAGE_ARCHIVE_NAME = "usage.json"
_DATE_FIELDS = ("modified", "krcFirstSeen")


def _as_ms(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def write_usage(archive, section, ids):
    """Pack the usage ledger's entries for these ids (one ledger section) as usage.json."""
    ledger = load_usage_section(section)
    usage = {}
    for library_id in ids:
        entry = ledger.get(library_id)
        if isinstance(entry, dict) and (_as_ms(entry.get("count")) or _as_ms(entry.get("lastUsedMs"))):
            usage[library_id] = {"count": _as_ms(entry.get("count")), "lastUsedMs": _as_ms(entry.get("lastUsedMs"))}
    archive.writestr(USAGE_ARCHIVE_NAME, json.dumps(usage, indent=2, ensure_ascii=False))


def read_usage(archive):
    """The bundle's usage.json as {id: entry}, or None when it has none or it's unreadable."""
    if USAGE_ARCHIVE_NAME not in archive.namelist():
        return None
    try:
        raw = read_json_entry(archive, USAGE_ARCHIVE_NAME)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    return {str(key): entry for key, entry in raw.items() if isinstance(entry, dict)}


def import_usage(section, bundle_usage, pairs, overwrite):
    """Apply a bundle's usage to the ledger. `pairs` is [(bundle id, local ledger key)] for
    the records the import wrote. Overwrite: the bundle's entry replaces the local one (none
    in the bundle clears it). Merge: the larger count and the later last-used win, and a
    record the bundle has no usage for keeps its own. No usage.json: nothing changes.
    -> entries written."""
    if bundle_usage is None or not pairs:
        return 0
    ledger = load_usage_section(section)
    writes = {}
    for bundle_id, key in pairs:
        incoming = bundle_usage.get(bundle_id)
        if overwrite:
            writes[key] = incoming or None
        elif incoming:
            local = ledger.get(key) if isinstance(ledger.get(key), dict) else {}
            writes[key] = {
                "count": max(_as_ms(local.get("count")), _as_ms(incoming.get("count"))),
                "lastUsedMs": max(_as_ms(local.get("lastUsedMs")), _as_ms(incoming.get("lastUsedMs"))),
            }
    set_usage(section, writes)
    return sum(1 for entry in writes.values() if entry)


def content_changed(local, merged):
    """Whether an import changes a record's content (dates and quick toggles aside)."""
    return _content(merged) != _content(local)


def _content(record):
    excluded = set(DEFAULT_VOLATILE_FIELDS) | set(QUICK_META_FIELDS) | set(_DATE_FIELDS)
    return {key: value for key, value in (record or {}).items() if key not in excluded}


def imported_dates(local, incoming, merged, overwrite):
    """(krcFirstSeen, modified) an imported record keeps when history is kept; None for
    either leaves the normal write rule in charge (local first-seen, modified = now on a
    content change).
      overwrite: the bundle's own dates.
      merge:     the earlier first-seen of the two sides; modified moves only if the merge
                 filled something in, and then to the later of the two sides' dates, never
                 to "now"."""
    local = local or {}
    first_local, first_incoming = _as_ms(local.get("krcFirstSeen")), _as_ms(incoming.get("krcFirstSeen"))
    modified_local, modified_incoming = _as_ms(local.get("modified")), _as_ms(incoming.get("modified"))
    if overwrite:
        return first_incoming or None, modified_incoming or None
    firsts = [value for value in (first_local, first_incoming) if value]
    first = min(firsts) if firsts else None
    if _content(merged) == _content(local):
        return first, modified_local or None
    return first, max(modified_local, modified_incoming) or None
