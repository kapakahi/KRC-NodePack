"""LoRA Loadout's KRC bundle sections (UNIFIED_BUNDLE_GAMEPLAN.md): "lora_library"
(metadata, thumbnails, folder colours, identity aliases, usage) and "lora_presets".

Export writes into a section folder; import is a two-phase plan (utils/bundle/sections.py):
everything slow (index scan, parsing, thumbnail checks + staging) in plan, only DB writes
in apply. A bundle only ever updates LoRAs this machine's scan found.
"""
import json
import re
from pathlib import Path

from ..archive_guard import ArchiveGuardError, read_json_entry
from ..bundle.presets_plan import incoming_presets, plan_presets
from ..bundle.sections import ImportPlan, Section, plan_summary
from ..library.archive import (
    ANIMATED_THUMBNAILS_ARCHIVE_DIR,
    METADATA_ARCHIVE_NAME,
    THUMBNAILS_ARCHIVE_DIR,
    content_changed,
    import_record,
    import_usage,
    imported_dates,
    read_usage,
    thumbnail_archive_dir,
    thumbnail_member_ok,
    write_usage,
)
from .identity import IdentityStore
from .library_index import LoraLibraryIndex
from .metadata import stamp_krc_metadata_versions, write_krc_metadata
from .presets import FolderColorStore, PresetStore, is_reserved_preset_name
from .thumbnails import KRC_THUMBNAIL_EXTENSIONS, find_thumbnail_paths, get_krc_thumbnail_path

PRESETS_ARCHIVE_NAME = "presets.json"
FOLDER_COLORS_ARCHIVE_NAME = "folder_colors.json"
IDENTITY_ARCHIVE_NAME = "identity.json"


def write_library_section(archive, selection=None):
    """The LoRA library into ``archive`` (a zip or a bundle's SectionArchive): every
    scanned LoRA's metadata + thumbnails, folder colours, identity aliases (never the file
    map: it's this machine's own) and usage. -> {"counts", "links"}."""
    records = LoraLibraryIndex().refresh()
    metadata = []
    library_ids = []
    for record in records.values():
        metadata.append(stamp_krc_metadata_versions(record.get("sidecar_data") or {}))
        sha256 = record.get("library_id")
        library_ids.append(sha256)
        for thumb in find_thumbnail_paths(sha256):
            archive_dir = thumbnail_archive_dir(Path(thumb).suffix)
            archive.write(thumb, f"{archive_dir}/{sha256}{Path(thumb).suffix}")
    archive.writestr(METADATA_ARCHIVE_NAME, json.dumps(metadata, indent=2, ensure_ascii=False))
    archive.writestr(FOLDER_COLORS_ARCHIVE_NAME, json.dumps(FolderColorStore().load(), indent=2, ensure_ascii=False))
    aliases = IdentityStore().load().get("aliases", {})
    archive.writestr(IDENTITY_ARCHIVE_NAME, json.dumps({"aliases": aliases}, indent=2, ensure_ascii=False))
    write_usage(archive, "loras", library_ids)
    return {"counts": {"loras": len(metadata)}, "links": {}}


def write_presets_section(archive, selection=None):
    """LoRA Loadout presets into ``archive``: all, or ``{"ids": [...]}`` (the presets an
    exported prompt links to). -> {"counts", "links"}."""
    presets = PresetStore().load().get("presets", [])
    wanted = (selection or {}).get("ids")
    if wanted is not None:
        wanted = {str(preset_id) for preset_id in wanted}
        presets = [preset for preset in presets if preset.get("id") in wanted]
    archive.writestr(PRESETS_ARCHIVE_NAME, json.dumps({"presets": presets}, indent=2, ensure_ascii=False))
    return {"counts": {"presets": len(presets)}, "links": {}}


def _optional_json(archive, name):
    """A section file's JSON, or None when it isn't there or isn't valid."""
    if name not in archive.namelist():
        return None
    try:
        return read_json_entry(archive, name)
    except (ValueError, UnicodeDecodeError):
        return None


def _bundle_thumbnails(archive, names, bundle_id):
    """The bundle's real (signature-checked) thumbnail files for one LoRA."""
    found = []
    for archive_dir in (THUMBNAILS_ARCHIVE_DIR, ANIMATED_THUMBNAILS_ARCHIVE_DIR):
        prefix = f"{archive_dir}/{bundle_id}."
        for name in names:
            suffix = Path(name).suffix.lower()
            if name.startswith(prefix) and suffix in KRC_THUMBNAIL_EXTENSIONS and thumbnail_member_ok(archive, name, suffix):
                found.append(name)
    return list(dict.fromkeys(found))


def plan_library_section(archive, mode, options, stager):
    """Plan a "lora_library" import. merge fills only empty fields and keeps a LoRA's own
    thumbnail; overwrite takes the bundle's metadata and thumbnails. Folder colours: merge
    adds folders that have none; identity: only safe new aliases (_restore_identity)."""
    overwrite = mode == "overwrite"
    keep_history = options.get("history", True)
    index = LoraLibraryIndex()
    index.refresh()
    metadata = read_json_entry(archive, METADATA_ARCHIVE_NAME) if METADATA_ARCHIVE_NAME in archive.namelist() else []
    if not isinstance(metadata, list):
        raise ArchiveGuardError("lora_library/metadata.json is invalid")
    names = archive.namelist()
    writes, usage_pairs = [], []
    updated = unchanged = missing = invalid = 0
    for entry in metadata:
        bundle_id = (entry.get("libraryId") or entry.get("sha256")) if isinstance(entry, dict) else None
        if not bundle_id:
            invalid += 1
            continue
        record = index.get(bundle_id)
        if not record:
            missing += 1
            continue
        local = dict(record.get("sidecar_data") or {})
        merged = import_record(local, entry, overwrite)
        dates = imported_dates(local, entry, merged, overwrite) if keep_history else None
        changed = content_changed(local, merged) or bool(dates and dates != (local.get("krcFirstSeen"), local.get("modified")))
        if changed:
            writes.append((record, merged, dates))
        usage_pairs.append((bundle_id, record["library_id"]))

        thumbs = _bundle_thumbnails(archive, names, bundle_id)
        existing = [Path(path) for path in find_thumbnail_paths(record["library_id"])]
        if thumbs and (overwrite or not existing):
            for path in existing:
                stager.remove(path)
            for name in thumbs:
                stager.stage(archive, name, get_krc_thumbnail_path(record["library_id"], Path(name).suffix.lower()))
            changed = True
        if changed:
            updated += 1
        else:
            unchanged += 1

    bundle_usage = read_usage(archive) if keep_history else None
    folder_colors = _optional_json(archive, FOLDER_COLORS_ARCHIVE_NAME)
    identity = _optional_json(archive, IDENTITY_ARCHIVE_NAME)

    def apply():
        for record, merged, dates in writes:
            write_krc_metadata(record, merged, dates=dates)
        return {
            "loras": updated,
            "usage": import_usage("loras", bundle_usage, usage_pairs, overwrite) if keep_history else 0,
            "folderColors": _restore_folder_colors(folder_colors, mode),
            "identity": _restore_identity(identity, index),
        }

    summary = plan_summary(updated=updated, unchanged=unchanged,
                           skipped={"not on this machine": missing, "invalid": invalid})
    return ImportPlan(summary, apply, _refresh_index)


def plan_presets_section(archive, mode, options, stager):
    """Plan a "lora_presets" import (merge adds new ids, overwrite replaces same ids)."""
    payload = _optional_json(archive, PRESETS_ARCHIVE_NAME)
    return plan_presets(PresetStore(), incoming_presets(payload), mode,
                        key=lambda preset: str(preset.get("id") or ""), required=("id", "name"),
                        reserved=is_reserved_preset_name)


def bundle_sections():
    """This node's KRC bundle sections (registered by routes.py)."""
    return [
        Section("lora_library", "LoRA library", lambda: len(LoraLibraryIndex().refresh()), write_library_section,
                plan_library_section,
                slices=(("item_metadata", "lineage = 'loras'"), ("identity_aliases", "lineage = 'loras'"),
                        ("folder_colors", "lineage = 'loras'"), ("usage", "domain = 'loras'")),
                stores=(("metadata:loras", None), ("identity:loras", None), ("folder_colors", "loras"), ("usage", "loras")), refresh=_refresh_index),
        Section("lora_presets", "LoRA Loadout presets", lambda: len(PresetStore().load().get("presets", [])),
                write_presets_section, plan_presets_section,
                slices=(("presets", "kind = 'll'"),), stores=(("presets:ll", None),)),
    ]


def _refresh_index():
    LoraLibraryIndex._cache = {}  # the next read picks the (imported / restored) records up


def _restore_folder_colors(payload, mode):
    """Apply the bundle's folder colours: overwrite sets every folder it has; merge only
    folders with no colour here. -> folders changed."""
    incoming = payload.get("folders") if isinstance(payload, dict) else None
    if not isinstance(incoming, dict):
        return 0
    store = FolderColorStore()
    local = store.load().get("folders", {})
    changed = 0
    for folder, color_id in incoming.items():
        if mode == "overwrite" or folder not in local:
            before = local.get(folder, "")
            local = store.save_folder(folder, color_id).get("folders", {})
            if local.get(folder, "") != before:
                changed += 1
    return changed


# An alias maps a LoRA's old path-derived id to its content hash (what it was renamed to
# once hashed), so a preset saved before then still finds it.
_LOCAL_ID_RE = re.compile(r"^local-[0-9a-f]{24}$")
_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")


def _restore_identity(payload, index):
    """Add the bundle's aliases. Only a well-formed pair (local-<24 hex> -> a 64-hex
    hash) whose LoRA is in this library, never one this machine already has (in either
    mode: a bundle can't redirect a local alias) and never for an id that's a LoRA here,
    so a bundle can't make one of your LoRAs load as another. The file map (which file
    on disk is which hash) is this machine's own cache and is never imported.
    -> aliases added."""
    aliases = payload.get("aliases") if isinstance(payload, dict) else None
    if not isinstance(aliases, dict):
        return 0
    store = IdentityStore()
    local = store.load().setdefault("aliases", {})
    added = 0
    for key, value in aliases.items():
        key, value = str(key), str(value)
        if not _LOCAL_ID_RE.match(key) or not _SHA256_RE.match(value):
            continue
        if key in local or index.get(key) or not index.get(value):
            continue
        local[key] = value
        added += 1
    if added:
        store.save()
    return added
