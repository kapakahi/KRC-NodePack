from pathlib import Path

from ..db import library as library_db
from ..krc_paths import get_krc_node_dir
from ..library.metadata import (  # noqa: F401  (re-exported for call sites)
    apply_imported_dates,
    apply_modified_write_rule,
    coerce_fields,
    coerce_verification,
    current_millis,
    deferred_detail_flags,
    file_birth_or_mtime,
    is_local_library_id,
    make_library_id,
    normalize_primary_file,
    safe_id,
    stamp_versions,
    as_int,
    VERIFICATION_DEFAULT,
)
from ..custom_badge import normalize_custom_badge
from ..library.nsfw import nsfw_rating
from .source_import import (
    normalize_prompts,
    normalize_tags,
    normalize_words,
)


KRC_DIR_NAME = "lora_loadout"
KRC_METADATA_VERSION = "0.5"
# 0.6: originalName (the source-provided name)
# 0.7: Model Library catalog parity fields + krcRecordKind (see KRC_MODEL_METADATA_SCHEMA.md
#      S7). Additive/default-filled only; no UI exposure. Lets Model Library read LoRA
#      records through the same vocabulary as generic model records.
# 0.8: Pairing Simplification — pair records replace metadataSourceSha source-election +
#      inherit-merge (KRC_MODEL_METADATA_SCHEMA.md §8a). Shared metadata lives once in a
#      pairId-keyed store; legacy pairs are dissolved to standalone records on first read.
# 0.9: Add rating and canonicalize primaryFile.sizeBytes.
# 1.0: Add bool ``identityPending`` (Model Library parity, schema 1.2) — marks a seed
#      record for an unstabilized (local-id, no-SHA) file so Date Added (krcFirstSeen,
#      seeded from file birth/mtime) is stable before stabilization; cleared on promotion.
# 1.1: Add the inert ``verification`` object (Model Library parity, schema doc §3) so a
#      LoRA carries the identical shape as a generic model. Additive/default-filled; still
#      never UI-exposed until KRC ships a real verify feature.
# 1.2: Add ``verification.scannedAt`` (Civitai's own file scan date, ISO-8601). Additive,
#      default-filled (""); shared VERIFICATION_DEFAULT so both lineages gain it together.
# 1.3: Pairing REMOVED. The pair-record model (§8a: pairId/pairRole shared-metadata store) and
#      the ancient metadataSourceSha inherit model are both gone, dissolved to standalone
#      records on first load, and replaced by the external Collections store (no per-file field;
#      COLLECTIONS_GAMEPLAN.md). pairId/pairRole/metadataSourceSha are no longer part of a record.
KRC_METADATA_SCHEMA_VERSION = "1.3"
KRC_METADATA_EXPORT_VERSION = "0.5"
KRC_METADATA_IMPORT_VERSION = "0.5"
KRC_METADATA_VERSION_FIELDS = {
    "krcMetadataVersion": KRC_METADATA_VERSION,
    "krcMetadataSchemaVersion": KRC_METADATA_SCHEMA_VERSION,
    "krcMetadataExportVersion": KRC_METADATA_EXPORT_VERSION,
    "krcMetadataImportVersion": KRC_METADATA_IMPORT_VERSION,
}

# Schema 0.7 Model Library catalog parity: string-valued fields default-filled to "".
# organization / nameGeneratedFrom are objects and handled separately.
KRC_LORA_PARITY_STRING_FIELDS = (
    "family",
    "architecture",
    "variant",
    "releaseDate",
    "baseModelReleaseDate",
    "quantization",
    "precision",
    "format",
    "parameterCount",
    "role",
)


# Fields a LoRA record no longer carries, dropped on every normalize and write so stored
# records clean themselves (no migration): the old sidecar path, the type key (now
# krcRecordKind), the old NSFW breakdown, a second Civitai blob, origin-URL aliases and
# the remote-only flag.
RETIRED_KEYS = (
    "categoryColor", "krcMetadataPath", "type", "civitai", "nsfwSources", "nsfwLevelReasons",
    "links", "sourceUrl", "url", "thumbnailRemoteOnly",
)


# The plain (non-nested, non-identity) metadata fields the save route accepts from a payload
# and writes straight to a LoRA's own sidecar. Formerly ``SHARED_PLAIN_KEYS`` in the removed
# pairing module (where these were routed to a pair's shared blob); with pairing gone every
# field is per-file. name/verification/customBadge/rating are handled specially by the caller
# and deliberately excluded here. Nested objects (creator/usage) and nsfwLevel are applied by
# ``_apply_inherited_metadata_edits``.
PLAIN_METADATA_KEYS = (
    "baseModel",
    "description",
    "category",
    "favorite",
    "pinned",
    "rating",
    "nsfw",
    "version",
    "trainedWords",
    "examplePrompts",
    "tags",
    "notes",
    "images",
    "originUrl",
    "cardColor",
    "customBadge",
    "thumbnailNeedsPoster",
    "thumbnailPosterExtracted",
    "thumbnailSourcePath",
    "thumbnailSourceType",
)


def stamp_krc_metadata_versions(metadata):
    return stamp_versions(metadata, KRC_METADATA_VERSION_FIELDS)


def get_krc_base_dir():
    fallback = Path(__file__).resolve().parents[2] / ".krc_user" / "default"
    return get_krc_node_dir(KRC_DIR_NAME, fallback=fallback)


def get_krc_metadata_dir():
    """The pre-database sidecar folder: read once by the stage-3 import, renamed
    ``metadata.migrated`` afterwards. Records now live in krc.db (item_metadata)."""
    return get_krc_base_dir() / "metadata"


def krc_metadata_exists(library_id):
    return library_db.metadata_exists(library_db.LORAS, "", safe_id(library_id))


def write_metadata_record(path, library_id, metadata):
    return write_krc_metadata(
        {
            "library_id": library_id,
            "relative_path": metadata.get("file") or Path(path).name,
            "filename": Path(path).name,
            "path": str(path),
        },
        metadata,
    )


def read_lora_metadata(path, library_id=None):
    path = Path(path)
    library_id = library_id or make_library_id(path)
    existing = read_krc_metadata(library_id)
    if existing:
        metadata = normalize_krc_metadata(path, library_id, existing)
    else:
        metadata = default_metadata(path, library_id)
        write_metadata_record(path, library_id, metadata)
        metadata = normalize_krc_metadata(path, library_id, read_krc_metadata(library_id))

    return metadata


def read_krc_metadata(library_id):
    """The stored LoRA record, {} when there is none."""
    return library_db.metadata_get(library_db.LORAS, "", safe_id(library_id)) or {}


def normalize_krc_metadata(path, library_id, metadata):
    normalized = stamp_krc_metadata_versions(metadata)
    for key in RETIRED_KEYS:
        normalized.pop(key, None)
    normalized["file"] = normalized.get("file") or path.name
    normalized["path"] = str(path)
    normalized["libraryId"] = library_id
    normalized["metadataSource"] = normalized.get("metadataSource") or "krc"
    normalized["trainedWords"] = normalize_words(normalized.get("trainedWords"))
    normalized["examplePrompts"] = normalize_prompts(normalized.get("examplePrompts"))
    normalized["tags"] = normalize_tags(normalized.get("tags"))
    normalized["images"] = normalized.get("images") if isinstance(normalized.get("images"), list) else []
    normalized["sourceMetadata"] = normalized.get("sourceMetadata") if isinstance(normalized.get("sourceMetadata"), dict) else {}
    normalized["sourceImport"] = normalized.get("sourceImport") if isinstance(normalized.get("sourceImport"), dict) else {}
    normalized["source"] = normalized.get("source") if isinstance(normalized.get("source"), dict) else {}
    normalized["nsfwLevel"] = nsfw_rating(normalized.get("nsfwLevel"))
    normalized["creator"] = normalized.get("creator") if isinstance(normalized.get("creator"), dict) else {}
    normalized["usage"] = normalized.get("usage") if isinstance(normalized.get("usage"), dict) else {}
    normalized["primaryFile"] = normalize_primary_file(normalized.get("primaryFile"))
    # Schema 1.1: inert verification object (Model Library parity, schema doc §3). Merges
    # onto the shared default; default-fills for legacy records. Not UI-exposed yet.
    normalized["verification"] = coerce_verification(normalized.get("verification"))
    normalized["previewImages"] = normalized.get("previewImages") if isinstance(normalized.get("previewImages"), list) else []
    normalized["modified"] = normalized.get("modified") or current_millis()
    normalized["krcFirstSeen"] = normalized.get("krcFirstSeen") or normalized.get("modified")
    # The immutable source-provided name (Civitai / HF).
    normalized["originalName"] = normalized.get("originalName", "")
    normalized["version"] = normalized.get("version", "")
    normalized["notes"] = normalized.get("notes", "")
    normalized["thumbnailSourcePath"] = normalized.get("thumbnailSourcePath", "")
    normalized["thumbnailSourceType"] = normalized.get("thumbnailSourceType", "")
    normalized["thumbnailNeedsPoster"] = bool(normalized.get("thumbnailNeedsPoster", False))
    normalized["thumbnailPosterExtracted"] = bool(normalized.get("thumbnailPosterExtracted", False))
    normalized["thumbnailRemoved"] = bool(normalized.get("thumbnailRemoved", False))
    # A deliberate user blank-slate reset; the Civitai batch fill skips it. Cleared by a
    # Civitai fetch or HuggingFace import.
    normalized["userBlanked"] = bool(normalized.get("userBlanked", False))
    # A mature Civitai model whose preview the public/anonymous fetch couldn't see, so
    # the card can show the empty-NSFW placeholder rather than a broken image.
    normalized["previewWithheld"] = bool(normalized.get("previewWithheld", False))
    # Seed marker: a placeholder record for an unstabilized (local-id, no-SHA) file.
    # Cleared on promotion to the content SHA. Legacy records default to False (not a seed).
    normalized["identityPending"] = bool(normalized.get("identityPending", False))
    normalized["rating"] = as_int(normalized.get("rating"), 0)
    custom_badge = normalize_custom_badge(normalized.get("customBadge", ""))
    normalized["customBadge"] = custom_badge if custom_badge is not None else ""
    # Schema 0.7: Model Library catalog parity (KRC_MODEL_METADATA_SCHEMA.md S7). Shared
    # vocabulary so Model Library can read LoRA records through without a competing record.
    # Additive defaults only; not yet surfaced in the LoRA Loadout UI.
    normalized["krcRecordKind"] = "lora"
    coerce_fields(normalized, strings=KRC_LORA_PARITY_STRING_FIELDS)
    normalized["organization"] = normalized.get("organization") if isinstance(normalized.get("organization"), dict) else {}
    normalized["nameGeneratedFrom"] = normalized.get("nameGeneratedFrom") if isinstance(normalized.get("nameGeneratedFrom"), dict) else {}
    return normalized


def default_metadata(path, library_id):
    # Seed the date from the file's own timestamp (not "now") so an unstabilized,
    # never-edited LoRA keeps a stable Date Added across rescans/restarts. A still-
    # local id (no content SHA) is identity-pending.
    seen = file_birth_or_mtime(path) or current_millis()
    return {
        "file": path.name,
        "path": str(path),
        "libraryId": library_id,
        "sha256": "",
        "name": "",
        "originalName": "",
        "version": "",
        "baseModel": "",
        "description": "",
        "category": "",
        "cardColor": "",
        "customBadge": "",
        "favorite": False,
        "pinned": False,
        "rating": 0,
        "trainedWords": [],
        "examplePrompts": [],
        "tags": [],
        "notes": "",
        "images": [],
        "source": {},
        "nsfw": False,
        "nsfwLevel": 0,
        "creator": {},
        "usage": {},
        "primaryFile": {},
        # Schema 1.1: inert verification object (Model Library parity, schema doc §3).
        "verification": dict(VERIFICATION_DEFAULT),
        "previewImages": [],
        "modified": seen,
        "krcFirstSeen": seen,
        "metadataSource": "default",
        "identityPending": is_local_library_id(library_id),
        "userBlanked": False,
        "previewWithheld": False,
        # Schema 0.7 Model Library catalog parity (see KRC_MODEL_METADATA_SCHEMA.md S7).
        "krcRecordKind": "lora",
        "family": "",
        "architecture": "",
        "variant": "",
        "releaseDate": "",
        "baseModelReleaseDate": "",
        "quantization": "",
        "precision": "",
        "format": "",
        "parameterCount": "",
        "role": "",
        "organization": {},
        "nameGeneratedFrom": {},
        **KRC_METADATA_VERSION_FIELDS,
        "thumbnailSourcePath": "",
        "thumbnailSourceType": "",
        "thumbnailNeedsPoster": False,
        "thumbnailPosterExtracted": False,
        "thumbnailRemoved": False,
    }


def write_krc_metadata(record, metadata, seed=False, dates=None):
    """Persist a normalized LoRA record. `seed=True` writes a placeholder for an
    unstabilized file: `modified` is pinned to the seeded `krcFirstSeen` (file
    birth/mtime) instead of the write moment, so a never-edited seed shows Date
    Modified == Date Added rather than "just now". `dates` = (krcFirstSeen, modified)
    from a bundle import that keeps history; a None in it leaves the write rule's value."""
    library_id = record["library_id"]
    existing = read_krc_metadata(library_id)
    payload = stamp_krc_metadata_versions(metadata)
    for key in RETIRED_KEYS:
        payload.pop(key, None)
    payload["libraryId"] = library_id
    payload["file"] = record.get("relative_path") or record.get("filename")
    payload["path"] = record.get("path")
    payload["rating"] = as_int(payload.get("rating"), 0)
    payload["primaryFile"] = normalize_primary_file(payload.get("primaryFile"))
    apply_modified_write_rule(payload, existing)
    if seed and not existing:
        payload["modified"] = payload.get("krcFirstSeen") or payload["modified"]
    apply_imported_dates(payload, dates)
    library_db.metadata_put(library_db.LORAS, "", safe_id(library_id), payload)
