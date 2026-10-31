"""LoRA records for the browser: the record -> JSON serializer (shared with Model Library's
LoRA read-through) and the Date Added seed for unstabilized files."""

from .identity import is_local_library_id
from ..library.nsfw import nsfw_rating
from ..library.thumbnails import thumbnail_version
from .metadata import (
    KRC_METADATA_EXPORT_VERSION,
    KRC_METADATA_IMPORT_VERSION,
    KRC_METADATA_SCHEMA_VERSION,
    KRC_METADATA_VERSION,
    as_int,
    deferred_detail_flags,
    read_krc_metadata,
    write_krc_metadata,
)
from .civitai_cache import not_found_at, not_found_entries
from .thumbnails import find_thumbnail_variant, thumbnail_kind


def seed_unstabilized_lora(record):
    """Freeze the Date Added of an unstabilized LoRA by persisting a seed sidecar the
    first time it is opened (identityPending, date = file birth/mtime, empty sha256).
    No hashing — the SHA still lands only on explicit/point-of-need stabilization.

    This is LoRA Loadout's ONE LoRA writer, shared by LL's native detail route and the
    Model Library read-through (schema §8: ML never writes LoRA records itself — it
    delegates the write here). Best-effort and idempotent: a file write failure or an
    already-persisted sidecar leaves the passed record untouched. Returns the record,
    with refreshed sidecar_data when a seed was written."""
    library_id = record.get("library_id")
    if not is_local_library_id(library_id) or read_krc_metadata(library_id):
        return record
    try:
        write_krc_metadata(record, record.get("sidecar_data") or {}, seed=True)
        refreshed = read_krc_metadata(library_id)
    except OSError:
        return record
    return {**record, "sidecar_data": refreshed} if refreshed else record


def _join_civitai_not_found(items):
    """Set civitaiNotFoundAt on each browse row from ONE scan of the Civitai cache's
    not_found sentinels (the civitai:none search + the batch skip)."""
    not_found = not_found_entries()
    for item in items:
        item["civitaiNotFoundAt"] = not_found.get(str(item.get("sha256") or "").lower(), 0)


def _serialize_lora(record, sidecar, folder_colors=None, include_heavy_text=True, include_detail_fields=True):
    trained_words = sidecar.get("trainedWords") or []
    example_prompts = sidecar.get("examplePrompts") or []
    source_metadata = sidecar.get("sourceMetadata") if isinstance(sidecar.get("sourceMetadata"), dict) else {}
    civitai = source_metadata.get("civitai") if isinstance(source_metadata.get("civitai"), dict) else {}
    thumbnail_id = record.get("library_id", "") if record else ""
    thumbnail_path = find_thumbnail_variant(thumbnail_id) if thumbnail_id else None
    poster_path = find_thumbnail_variant(thumbnail_id, "poster") if thumbnail_id else None
    animated_path = find_thumbnail_variant(thumbnail_id, "animated") if thumbnail_id else None
    has_thumbnail = bool(thumbnail_path)
    thumbnail_needs_poster = bool(sidecar.get("thumbnailNeedsPoster", False)) and not has_thumbnail
    origin_url = sidecar.get("originUrl") or civitai.get("downloadUrl") or ""
    folder = record.get("folder", "")
    folder_colors = folder_colors or {}
    creator = sidecar.get("creator") if isinstance(sidecar.get("creator"), dict) else {}
    usage = sidecar.get("usage") if isinstance(sidecar.get("usage"), dict) else {}
    creator_username = creator.get("username", "")
    usage_payload = {
        "license": usage.get("license", ""),
        "allowNoCredit": usage.get("allowNoCredit"),
        "allowCommercialUse": usage.get("allowCommercialUse"),
        "allowDerivatives": usage.get("allowDerivatives"),
        "allowDifferentLicense": usage.get("allowDifferentLicense"),
        "uploadType": usage.get("uploadType", ""),
        "credit": usage.get("credit", ""),
    }
    trained_word_list = [
        item.get("word", "") if isinstance(item, dict) else str(item)
        for item in trained_words
        if item
    ]
    description = sidecar.get("description", "")
    serialized_example_prompts = [
        item.get("text", "") if isinstance(item, dict) else str(item)
        for item in example_prompts
        if item
    ]
    actual_sha256 = record.get("sha256", "")
    duplicate_paths = record.get("duplicate_paths") or []
    relative_path = record.get("relative_path", "")
    metadata_source = sidecar.get("metadataSource", "")
    sidecar_source_import = sidecar.get("sourceImport") if isinstance(sidecar.get("sourceImport"), dict) else {}
    source_import_type = sidecar_source_import.get("type", "")
    source_fetched_at = sidecar_source_import.get("fetchedAt") or 0
    preview_withheld = bool(sidecar.get("previewWithheld", False))
    thumbnail_source_path = sidecar.get("thumbnailSourcePath", "")
    thumbnail_source_type = sidecar.get("thumbnailSourceType", "")
    detail_deferred = (
        not include_detail_fields
        and bool(
            duplicate_paths
            or relative_path
            or origin_url
            or metadata_source
            or any(value not in ("", None) for value in usage_payload.values())
            or thumbnail_source_path
            or thumbnail_source_type
        )
    )
    return {
        "sha256": record.get("library_id") or record.get("sha256", ""),
        "actualSha256": actual_sha256,
        "path": record.get("path", "") if include_detail_fields else "",
        # All physical copies of this LoRA, oldest (canonical/loaded) first. Empty
        # or single-entry means no duplicates. See LoraLibraryIndex._collapse_duplicates.
        "duplicatePaths": duplicate_paths if include_detail_fields else [],
        "duplicateCount": len(record.get("duplicate_paths") or []),
        "relative_path": relative_path if include_detail_fields else "",
        # On an offline root (kept, not moved): a run can't load it, so slots show it missing.
        "unavailable": bool(record.get("unavailable")),
        "folder": folder,
        "filename": record.get("filename", ""),
        # Display falls back to the source-provided original name before the filename,
        # so clearing a custom Name reveals the original rather than the raw filename.
        "display_name": sidecar.get("name") or sidecar.get("originalName") or record.get("display_name") or record.get("filename", ""),
        "hasName": bool(sidecar.get("name")),
        "originalName": sidecar.get("originalName", ""),
        "version": sidecar.get("version", ""),
        "dateAdded": record.get("date_added", 0),
        "dateModified": record.get("date_modified", 0),
        "baseModel": sidecar.get("baseModel", ""),
        "category": sidecar.get("category", ""),
        "cardColor": sidecar.get("cardColor", ""),
        "customBadge": sidecar.get("customBadge", ""),
        "folderColor": folder_colors.get(folder, ""),
        "favorite": bool(sidecar.get("favorite", False)),
        "pinned": bool(sidecar.get("pinned", False)),
        "rating": as_int(sidecar.get("rating"), 0),
        "nsfw": bool(sidecar.get("nsfw", False)),
        # The shared NSFW rating (utils/library/nsfw.py): 0 or one content flag.
        "nsfwLevel": nsfw_rating(sidecar.get("nsfwLevel")),
        "description": description if include_heavy_text else "",
        "descriptionLength": len(description),
        "tags": sidecar.get("tags") if isinstance(sidecar.get("tags"), list) else [],
        "notes": sidecar.get("notes", ""),
        # Verification object drives the KRC ID shield. Always emitted (small, and the
        # shield shows in the browse-list-fed panel before a detail fetch resolves).
        "verification": sidecar.get("verification") or {},
        "originUrl": origin_url if include_detail_fields else "",
        # A video-preview LoRA with no real poster serves no file — the frontend
        # renders a themed "missing video" glyph, keyed off thumbnailNeedsPoster.
        "thumbnail": has_thumbnail,
        "thumbnailSha": thumbnail_id,
        "thumbnailType": thumbnail_kind(thumbnail_path) if thumbnail_path else "image",
        "thumbnailHasPoster": bool(poster_path),
        "thumbnailHasAnimation": bool(animated_path),
        # Per-item image cache version (newest thumbnail file mtime): the browser's ?v=.
        "thumbnailVersion": thumbnail_version(poster_path, animated_path),
        "metadataSource": metadata_source if include_detail_fields else "",
        "sourceImportType": source_import_type if include_detail_fields else "",
        "sourceFetchedAt": source_fetched_at if include_detail_fields else 0,
        # Exposed in light mode too — the browser card renders the empty-NSFW
        # placeholder from it (a mature LoRA whose preview the public fetch couldn't see).
        "previewWithheld": preview_withheld,
        # "Checked, not on Civitai": the cached not_found sentinel's date (ms), else 0.
        # Derived from the Civitai cache, never stored on the record — Force Refresh or
        # a later match clears it. The browse list joins it for every row in one pass
        # (_join_civitai_not_found); the detail read looks up this one LoRA.
        "civitaiNotFoundAt": not_found_at(record.get("library_id") or "") if include_detail_fields else 0,
        "creator": {
            "username": creator_username,
        },
        "usage": usage_payload if include_detail_fields else {},
        "krcMetadataVersion": sidecar.get("krcMetadataVersion") or KRC_METADATA_VERSION,
        "krcMetadataSchemaVersion": sidecar.get("krcMetadataSchemaVersion") or KRC_METADATA_SCHEMA_VERSION,
        "krcMetadataExportVersion": sidecar.get("krcMetadataExportVersion") or KRC_METADATA_EXPORT_VERSION,
        "krcMetadataImportVersion": sidecar.get("krcMetadataImportVersion") or KRC_METADATA_IMPORT_VERSION,
        "thumbnailNeedsPoster": thumbnail_needs_poster,
        "thumbnailSourceType": thumbnail_source_type if include_detail_fields else "",
        "thumbnailSourcePath": thumbnail_source_path if include_detail_fields else "",
        "trainedWords": trained_word_list,
        "examplePrompts": serialized_example_prompts if include_heavy_text else [],
        "examplePromptsLength": sum(len(text) for text in serialized_example_prompts),
        # Deferred-detail flags built through the shared contract helper (all three keys,
        # canonical names) — see INFO_PANEL_RECORD_CONTRACT_GAMEPLAN.md step 2.
        **deferred_detail_flags(
            description_deferred=bool(description) and not include_heavy_text,
            example_prompts_deferred=bool(serialized_example_prompts) and not include_heavy_text,
            detail_fields_deferred=detail_deferred,
        ),
    }
