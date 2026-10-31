"""Generic KRC model metadata record: normalizer, defaults, migration, read/write.

Mirrors the conventions of utils/lora_loadout/metadata.py deliberately (dicts -> {},
lists -> [], strings -> "", bools -> False, millis timestamps, local-<hex> ids,
`modified` bumped only on real content change) so a single normalizer style serves both
record kinds. Field names, shapes, and version constants follow
KRC_MODEL_METADATA_SCHEMA.md (the source of truth).
"""

import re
from pathlib import Path

from ..db import library as library_db
from ..krc_paths import get_krc_node_dir
from ..library.metadata import (  # noqa: F401  (re-exported for call sites)
    apply_imported_dates,
    apply_modified_write_rule,
    as_int,
    coerce_fields,
    coerce_verification,
    current_millis,
    file_birth_or_mtime,
    is_local_library_id,
    make_library_id as make_model_library_id,
    normalize_primary_file,
    safe_id,
    stamp_versions,
    VERIFICATION_DEFAULT,
)
# Pure, node-agnostic text helpers (shared source_import base, B6) so tag
# normalization stays identical across both record kinds.
from ..library.nsfw import nsfw_rating
from ..library.source_import import normalize_tags
from ..custom_badge import normalize_custom_badge


KRC_MODEL_DIR_NAME = "model_library"

# Model Library lineage. Distinct from the LoRA Loadout lineage (which lives at its own
# constants in utils/lora_loadout/metadata.py); both stamp the SAME record keys, told
# apart by krcRecordKind. Bump SCHEMA whenever a field is added/renamed/removed or its
# normalized shape changes.
KRC_MODEL_METADATA_VERSION = "1.0"
# 1.2: add bool ``identityPending`` — marks a seed record materialized for an
#      unstabilized (local-id, no-SHA) file so "Date Added" (krcFirstSeen, now
#      seeded from file birth/mtime) is stable before stabilization. Cleared on
#      promotion to the content SHA. Additive/default-false; no UI exposure.
# 1.3: ``modelType`` vocabulary changed to the FOLDER NAME (open vocabulary). It is
#      no longer a fixed lowercase enum ("diffusion"/"upscaler"/…): the scanner types
#      each model by its own ``models/<folder>`` name ("diffusion_models",
#      "upscale_models", "clip_vision", "SEEDVR2", …), and any sanitized folder name is
#      valid. Unknowns are NO LONGER collapsed to "other". Legacy semantic values still
#      resolve to the same on-disk dir (metadata_dir_name_for_model_type). See §5.
# 1.4: Add ``verification.scannedAt`` (Civitai's own file scan date, ISO-8601). Additive,
#      default-filled (""); shared VERIFICATION_DEFAULT so both lineages gain it together.
KRC_MODEL_METADATA_SCHEMA_VERSION = "1.4"
# Bundle format (export/import system), versioned apart from the record schema above:
# 1.1: the Model Library bundle carries the shared Collections store as an optional
#      ``collections.json`` ({schemaVersion, collections: [record…]}). Import applies it
#      with the bundle's mode, keyed by collection id — merge adds new ids and unions
#      members (local name/pin/color kept), overwrite replaces same-id collections;
#      local-only collections are never removed. A 1.0 bundle (no entry) still imports.
#      Record fields are unchanged. See IMPORT_EXPORT_PAGE_GAMEPLAN.md §4.
KRC_MODEL_METADATA_EXPORT_VERSION = "1.1"
KRC_MODEL_METADATA_IMPORT_VERSION = "1.1"
KRC_MODEL_METADATA_VERSION_FIELDS = {
    "krcMetadataVersion": KRC_MODEL_METADATA_VERSION,
    "krcMetadataSchemaVersion": KRC_MODEL_METADATA_SCHEMA_VERSION,
    "krcMetadataExportVersion": KRC_MODEL_METADATA_EXPORT_VERSION,
    "krcMetadataImportVersion": KRC_MODEL_METADATA_IMPORT_VERSION,
}

KRC_RECORD_KIND = "model"

MODEL_TYPE_METADATA_DIRS = {
    "checkpoint": "checkpoints",
    "diffusion": "diffusion_models",
    "unet": "unet",
    "vae": "vae",
    "clip": "clip",
    "text_encoder": "text_encoders",
    "controlnet": "controlnet",
    "upscaler": "upscale_models",
    "embedding": "embeddings",
    "other": "other",
}

# Fields a model record no longer carries, dropped on every normalize and write (no
# migration): the old sidecar path and the remote-only thumbnail flag.
RETIRED_KEYS = ("krcMetadataPath", "thumbnailRemoteOnly")

# Object fields coerced to {} when the stored value is the wrong type.
_OBJECT_FIELDS = (
    "creator",
    "organization",
    "source",
    "sourceImport",
    "sourceMetadata",
    "primaryFile",
    "nameGeneratedFrom",
)
# List fields coerced to [] when the stored value is the wrong type.
_LIST_FIELDS = ("images", "previewImages")
# Plain string fields defaulted to "".
_STRING_FIELDS = (
    "sha256",
    "originalName",
    "name",
    "format",
    "family",
    "baseModel",
    "architecture",
    "variant",
    "role",
    "parameterCount",
    "quantization",
    "precision",
    "version",
    "releaseDate",
    "baseModelReleaseDate",
    "license",
    "description",
    "notes",
    "cardColor",
    "customBadge",
    "thumbnailSourcePath",
    "thumbnailSourceType",
)
# Boolean fields defaulted to False.
_BOOL_FIELDS = (
    "favorite",
    "pinned",
    "nsfw",
    "thumbnailNeedsPoster",
    "thumbnailPosterExtracted",
    "thumbnailRemoved",
    "identityPending",
)

def stamp_krc_model_metadata_versions(metadata):
    return stamp_versions(metadata, KRC_MODEL_METADATA_VERSION_FIELDS)


def get_krc_model_base_dir():
    fallback = Path(__file__).resolve().parents[2] / ".krc_user" / "default"
    return get_krc_node_dir(KRC_MODEL_DIR_NAME, fallback=fallback)


_MODEL_TYPE_SANITIZE_RE = re.compile(r"[^A-Za-z0-9_.\-]+")


def _sanitize_model_type(value):
    """Filesystem-safe model-type token (it names a metadata/thumbnail dir). Folder names
    scanned from disk are already valid dir names; this is defense-in-depth against path
    traversal and stray separators. Case is preserved so the type mirrors the folder."""
    text = _MODEL_TYPE_SANITIZE_RE.sub("_", str(value or "").strip()).strip("._")
    return text


def metadata_dir_name_for_model_type(model_type):
    text = _sanitize_model_type(model_type)
    if not text or text.lower() == "lora":
        # ML never stores a lora record (read-through supplies that view).
        return "other"
    # Already a folder-name dir (new-style folder-name value, or a legacy folder-named one).
    if text in MODEL_TYPE_METADATA_DIRS.values():
        return text
    # Legacy semantic key (e.g. "diffusion") → its folder-name dir ("diffusion_models"),
    # so existing sidecars/thumbnails written under the old scheme still resolve.
    if text in MODEL_TYPE_METADATA_DIRS:
        return MODEL_TYPE_METADATA_DIRS[text]
    # Open vocabulary: any other folder name is its own metadata/thumbnail dir.
    return text


def get_krc_model_metadata_dir(model_type=None):
    """The pre-database sidecar folder (per type below it): read once by the stage-3
    import, renamed ``metadata.migrated`` afterwards. Records now live in krc.db."""
    base = get_krc_model_base_dir() / "metadata"
    if model_type is None:
        return base
    return base / metadata_dir_name_for_model_type(model_type)


def model_type_dirs():
    """Every per-type dir a model record or thumbnail can live in: the ones holding
    records in krc.db, plus thumbnail folders on disk (a type whose records are gone can
    still have thumbnails). Never ``lora`` (Model Library doesn't store LoRA records)."""
    dirs = set(library_db.metadata_type_dirs(library_db.MODELS))
    base = get_krc_model_base_dir()
    for folder in (base / "thumbnails", base / "animated_thumbnails"):
        try:
            dirs.update(child.name for child in folder.iterdir() if child.is_dir())
        except OSError:
            pass
    dirs.discard("lora")
    return sorted(dirs)


def iter_model_metadata_paths(library_id):
    # Open vocabulary: type dirs are no longer a fixed set, so enumerate the known ones
    # (used to locate a record or thumbnail whose type is unknown, and to clean every
    # variant). Paths are the old sidecar paths; use their parent's name as the type dir.
    fname = f"{safe_id(library_id)}.json"
    base = get_krc_model_metadata_dir()
    for type_dir in model_type_dirs():
        yield base / type_dir / fname


def model_metadata_exists(library_id, model_type):
    return library_db.metadata_exists(
        library_db.MODELS, metadata_dir_name_for_model_type(model_type), safe_id(library_id))


def _coerce_model_type(value):
    # Open vocabulary: the model type is the folder name, so any sanitized non-empty
    # token is valid and gets its own metadata/thumbnail dir. Only `lora` is special —
    # Model Library never persists a lora record; read-through supplies that view.
    text = _sanitize_model_type(value)
    if text.lower() == "lora":
        return "other"
    return text or "other"


def normalize_model_metadata(path, library_id, metadata):
    """Bring a generic model record to the current schema: default-fill missing fields,
    coerce shapes, stamp versions. This IS the migration for schema 1.0 (first version)."""
    path = Path(path)
    normalized = stamp_krc_model_metadata_versions(metadata)
    for key in RETIRED_KEYS:
        normalized.pop(key, None)

    normalized["krcRecordKind"] = KRC_RECORD_KIND
    normalized["file"] = normalized.get("file") or path.name
    normalized["path"] = str(path)
    normalized["modelType"] = _coerce_model_type(normalized.get("modelType"))
    normalized["libraryId"] = library_id
    normalized["metadataSource"] = normalized.get("metadataSource") or "default"

    coerce_fields(
        normalized,
        strings=_STRING_FIELDS,
        bools=_BOOL_FIELDS,
        objects=_OBJECT_FIELDS,
        lists=_LIST_FIELDS,
    )

    normalized["tags"] = normalize_tags(normalized.get("tags"))
    custom_badge = normalize_custom_badge(normalized.get("customBadge", ""))
    normalized["customBadge"] = custom_badge if custom_badge is not None else ""
    normalized["nsfwLevel"] = nsfw_rating(normalized.get("nsfwLevel"))
    normalized["rating"] = as_int(normalized.get("rating"), 0)
    normalized["primaryFile"] = normalize_primary_file(normalized.get("primaryFile"))
    normalized["verification"] = coerce_verification(normalized.get("verification"))

    normalized["modified"] = as_int(normalized.get("modified"), 0) or current_millis()
    normalized["krcFirstSeen"] = as_int(normalized.get("krcFirstSeen"), 0) or normalized["modified"]

    return normalized


def default_model_metadata(path, library_id):
    path = Path(path)
    # Seed the date from the file's own timestamp (not "now") so an unstabilized,
    # never-edited model keeps a stable Date Added across rescans/restarts. An
    # id that is still local (no content SHA) is identity-pending.
    seen = file_birth_or_mtime(path) or current_millis()
    record = {
        "krcRecordKind": KRC_RECORD_KIND,
        "file": path.name,
        "path": str(path),
        "libraryId": library_id,
        "modelType": "other",
        "nsfwLevel": 0,
        "rating": 0,
        "tags": [],
        "verification": dict(VERIFICATION_DEFAULT),
        "metadataSource": "default",
        "modified": seen,
        "krcFirstSeen": seen,
        "identityPending": is_local_library_id(library_id),
        **KRC_MODEL_METADATA_VERSION_FIELDS,
    }
    for field in _STRING_FIELDS:
        record.setdefault(field, "")
    for field in _BOOL_FIELDS:
        record.setdefault(field, False)
    for field in _OBJECT_FIELDS:
        record.setdefault(field, {})
    for field in _LIST_FIELDS:
        record.setdefault(field, [])
    record["modelType"] = _coerce_model_type(record.get("modelType"))
    return record


def read_model_metadata(library_id, model_type=None):
    """The stored record ({} when none): in the type's dir, or, with no type, the first
    type dir (sorted) that holds one."""
    item_id = safe_id(library_id)
    if model_type is not None:
        type_dirs = [metadata_dir_name_for_model_type(model_type)]
    else:
        type_dirs = [d for d in library_db.metadata_type_dirs(library_db.MODELS, item_id) if d != "lora"]
    for type_dir in type_dirs:
        record = library_db.metadata_get(library_db.MODELS, type_dir, item_id)
        if record is not None:
            return record
    return {}


def _record_model_type(record, metadata):
    return _coerce_model_type(
        (record or {}).get("modelType")
        or (record or {}).get("model_type")
        or (metadata or {}).get("modelType")
    )


def _remove_stale_metadata_copies(library_id, keep_type_dir):
    library_db.metadata_delete(library_db.MODELS, safe_id(library_id), keep_type_dir=keep_type_dir)


def write_model_metadata(record, metadata, seed=False, dates=None):
    """Persist a normalized record. `record` carries identity/location facts
    (library_id, relative_path/filename, path). `modified` bumps only when meaningful
    content changed, mirroring the LoRA Loadout write rule so rescans don't churn sort.

    `seed=True` writes a placeholder for an unstabilized file: `modified` is pinned
    to the seeded `krcFirstSeen` (file birth/mtime) instead of the write moment, so a
    never-edited seed shows Date Modified == Date Added rather than "just now".
    `dates` as in write_krc_metadata (a history-keeping bundle import)."""
    library_id = record["library_id"]
    model_type = _record_model_type(record, metadata)
    existing = read_model_metadata(library_id, model_type)

    payload = stamp_krc_model_metadata_versions(metadata)
    for key in RETIRED_KEYS:
        payload.pop(key, None)
    payload["krcRecordKind"] = KRC_RECORD_KIND
    payload["libraryId"] = library_id
    payload["modelType"] = model_type
    payload["file"] = record.get("relative_path") or record.get("filename") or payload.get("file")
    payload["path"] = record.get("path") or payload.get("path")
    payload["rating"] = as_int(payload.get("rating"), 0)
    payload["primaryFile"] = normalize_primary_file(payload.get("primaryFile"))

    apply_modified_write_rule(payload, existing)
    if seed and not existing:
        payload["modified"] = payload.get("krcFirstSeen") or payload["modified"]
    apply_imported_dates(payload, dates)

    type_dir = metadata_dir_name_for_model_type(model_type)
    with library_db.db.write():  # the record and the removal of other-type copies together
        library_db.metadata_put(library_db.MODELS, type_dir, safe_id(library_id), payload)
        _remove_stale_metadata_copies(library_id, type_dir)
