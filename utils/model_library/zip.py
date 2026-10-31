"""Model Library's KRC bundle sections (UNIFIED_BUNDLE_GAMEPLAN.md): "model_library"
(generic model records the user wrote, thumbnails, usage; never LoRAs, which are LoRA
Loadout's, schema doc S8) and "collections" (the shared Collections store: models AND LoRAs).

Export writes into a section folder; import is a two-phase plan (utils/bundle/sections.py).
A bundle only ever updates models this machine's scan found.
"""

import json
from pathlib import Path

from ..archive_guard import ArchiveGuardError, read_json_entry
from ..bundle.sections import ImportPlan, Section, plan_summary
from ..db import library as library_db
from ..library.collections import SCHEMA_VERSION as COLLECTIONS_SCHEMA_VERSION, CollectionStore
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
from .library_index import ModelLibraryIndex
from .metadata import normalize_model_metadata, read_model_metadata, write_model_metadata
from .thumbnails import (
    ANIMATED_THUMBNAIL_EXTENSION,
    THUMBNAIL_EXTENSION,
    _iter_thumbnail_paths,
    find_model_thumbnail_paths,
    get_model_animated_thumbnail_path,
    get_model_thumbnail_path,
)

COLLECTIONS_ARCHIVE_NAME = "collections.json"


def _is_generic_model_record(data):
    if not isinstance(data, dict):
        return False
    if data.get("krcRecordKind") not in (None, "model"):
        return False
    if str(data.get("modelType") or "").strip().lower() == "lora":
        return False
    return True


def _iter_persisted_records():
    """Yield (library_id, normalized_record) for every sidecar the user has actually
    written. The scanner's in-memory defaults for un-annotated models are not persisted
    and are intentionally NOT exported."""
    for _type_dir, item_id, data in library_db.metadata_iter(library_db.MODELS):
        if not _is_generic_model_record(data):
            continue
        library_id = data.get("libraryId") or item_id
        path = data.get("path") or data.get("file") or library_id
        yield library_id, normalize_model_metadata(Path(path), library_id, data)


def write_library_section(archive, selection=None):
    """Model Library records the user wrote (never LoRAs) + their thumbnails + usage into
    ``archive`` (a zip or a bundle's SectionArchive). -> {"counts", "links"}."""
    records = []
    library_ids = []
    for library_id, record in _iter_persisted_records():
        records.append(record)
        library_ids.append(library_id)
        # Pack every variant that exists: static webp poster -> thumbnails/,
        # animated webm loop -> animated_thumbnails/ (parity with LoRA Loadout).
        for thumb in find_model_thumbnail_paths(library_id, record.get("modelType")):
            suffix = Path(thumb).suffix.lower()
            archive.write(thumb, f"{thumbnail_archive_dir(suffix)}/{library_id}{suffix}")
    archive.writestr(METADATA_ARCHIVE_NAME, json.dumps(records, indent=2, ensure_ascii=False))
    write_usage(archive, "models", library_ids)
    return {"counts": {"models": len(records)}, "links": {}}


def write_collections_section(archive, selection=None):
    """Every Collection (models and LoRAs) into ``archive``. -> {"counts", "links"}."""
    store = CollectionStore()
    write_collections(archive, store)
    return {"counts": {"collections": len(store.ordered())}, "links": {}}


def write_collections(archive, store):
    """Pack the whole Collections store (every collection, LoRA-only ones included)."""
    payload = {"schemaVersion": COLLECTIONS_SCHEMA_VERSION, "collections": store.ordered()}
    archive.writestr(COLLECTIONS_ARCHIVE_NAME, json.dumps(payload, indent=2, ensure_ascii=False))


def plan_library_section(archive, mode, options, stager):
    """Plan a "model_library" import. merge fills only empty fields and keeps a model's
    own thumbnail; overwrite takes the bundle's. The model's id, type and path stay this
    machine's; a model's bundle thumbnails replace every copy it has (an old loop can't
    outrank a new poster)."""
    overwrite = mode == "overwrite"
    keep_history = options.get("history", True)
    index = ModelLibraryIndex()
    index.refresh()
    metadata = read_json_entry(archive, METADATA_ARCHIVE_NAME) if METADATA_ARCHIVE_NAME in archive.namelist() else []
    if not isinstance(metadata, list):
        raise ArchiveGuardError("model_library/metadata.json is invalid")
    names = set(archive.namelist())
    writes, usage_pairs = [], []
    updated = unchanged = missing = not_model = invalid = 0
    for entry in metadata:
        if not isinstance(entry, dict):
            invalid += 1
            continue
        if not _is_generic_model_record(entry):  # never a LoRA into the Model Library
            not_model += 1
            continue
        bundle_id = entry.get("libraryId") or entry.get("sha256")
        local = index.get(bundle_id) if bundle_id else None
        if not local:
            missing += 1
            continue
        library_id = local["library_id"]
        model_type = local.get("modelType")
        existing = read_model_metadata(library_id, model_type)
        merged = import_record(existing, entry, overwrite)
        merged["modelType"] = model_type
        dates = imported_dates(existing, entry, merged, overwrite) if keep_history else None
        changed = content_changed(existing, merged) or bool(dates and dates != (existing.get("krcFirstSeen"), existing.get("modified")))
        if changed:
            record = {"library_id": library_id, "modelType": model_type, "relative_path": local.get("relative_path"),
                      "filename": local.get("filename"), "path": local["path"]}
            writes.append((record, normalize_model_metadata(Path(local["path"]), library_id, merged), dates))
        usage_pairs.append((bundle_id, library_id))

        thumbs = [(name, target) for name, extension, target in (
            (f"{THUMBNAILS_ARCHIVE_DIR}/{bundle_id}{THUMBNAIL_EXTENSION}", THUMBNAIL_EXTENSION,
             get_model_thumbnail_path(library_id, model_type)),
            (f"{ANIMATED_THUMBNAILS_ARCHIVE_DIR}/{bundle_id}{ANIMATED_THUMBNAIL_EXTENSION}", ANIMATED_THUMBNAIL_EXTENSION,
             get_model_animated_thumbnail_path(library_id, model_type)),
        ) if name in names and thumbnail_member_ok(archive, name, extension)]
        existing_thumbs = find_model_thumbnail_paths(library_id, model_type)
        if thumbs and (overwrite or not existing_thumbs):
            for path in _iter_thumbnail_paths(library_id):
                stager.remove(path)
            for name, target in thumbs:
                stager.stage(archive, name, target)
            changed = True
        if changed:
            updated += 1
        else:
            unchanged += 1

    bundle_usage = read_usage(archive) if keep_history else None

    def apply():
        for record, normalized, dates in writes:
            write_model_metadata(record, normalized, dates=dates)
        return {"models": updated,
                "usage": import_usage("models", bundle_usage, usage_pairs, overwrite) if keep_history else 0}

    summary = plan_summary(updated=updated, unchanged=unchanged, skipped={
        "not on this machine": missing, "not a model": not_model, "invalid": invalid})
    return ImportPlan(summary, apply, _refresh_index)


def plan_collections_section(archive, mode, options, stager):
    """Plan a "collections" import (CollectionStore.import_records: merge adds new ones
    and new members, overwrite replaces same-id collections; local-only ones are kept)."""
    payload = None
    if COLLECTIONS_ARCHIVE_NAME in archive.namelist():
        payload = read_json_entry(archive, COLLECTIONS_ARCHIVE_NAME)
    records = payload.get("collections") if isinstance(payload, dict) else None
    if isinstance(records, dict):
        records = list(records.values())
    records = [record for record in records or [] if isinstance(record, dict) and record.get("id")]
    store = CollectionStore()
    local_ids = {str(collection.get("id")) for collection in store.ordered()}
    added = sum(1 for record in records if str(record["id"]) not in local_ids)

    def apply():
        return {"collections": store.import_records(records, mode="overwrite" if mode == "overwrite" else "merge")}

    return ImportPlan(plan_summary(added=added, updated=len(records) - added), apply)


def bundle_sections():
    """This node's KRC bundle sections (registered by routes.py)."""
    return [
        Section("model_library", "Model Library", lambda: sum(1 for _ in _iter_persisted_records()),
                write_library_section, plan_library_section,
                slices=(("item_metadata", "lineage = 'models'"), ("usage", "domain = 'models'")),
                stores=(("metadata:models", None), ("usage", "models")), refresh=_refresh_index),
        Section("collections", "Collections", lambda: len(CollectionStore().ordered()), write_collections_section,
                plan_collections_section, slices=(("collections", None),), stores=(("collections", None),)),
    ]


def _refresh_index():
    ModelLibraryIndex._cache = {}  # the next read picks the (imported / restored) records up
