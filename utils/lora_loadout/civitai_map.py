"""
KRC LoRA Loadout — map a Civitai by-hash response into a KRC record (layer 2).

source_import.build_civitai_fields maps the response to KRC fields; this module then
overlays ONLY those civitai-derived fields onto the existing record.

Preserved across a fetch (never civitai-sourced): identity, favorite, notes,
cardColor, customBadge and category (only the user sets a category).

Two merge modes for the civitai-derived fields:
  overwrite (default; Force Refresh + the single-LoRA Fetch today): every derived
            field is replaced — name, trained words, images, base model,
            description, tags, provenance.
  fill      (the batch fetch): the fields a user can set by hand
            (CIVITAI_USER_FIELD_KEYS) are written only where the record's value is
            empty, so a custom name/description survives; provenance, NSFW and
            media are always written. Either way the record becomes
            metadataSource "civitai" (a mixed record is upgraded, by decision).
Thumbnails are left untouched here — civitai previews are remote URLs; turning one into
a local thumbnail is a separate step.
"""
from pathlib import Path

from ..library.civitai_map import (  # noqa: F401  (re-exported for call sites)
    civitai_media_dir,
    civitai_scanned_at,
    civitai_verification,
    first_preview,
    graft_model_into_version,
    preview_video_ext,
)


# Fields the fetch overlays from Civitai. Excludes identity, thumbnail state, and the
# user-only fields (favorite/notes/cardColor/customBadge/category) which are preserved.
CIVITAI_DERIVED_KEYS = (
    "name", "originalName", "version", "baseModel", "description",
    "trainedWords", "tags", "images", "previewImages", "originUrl",
    "sourceMetadata", "source", "nsfw", "nsfwLevel",
    "creator", "usage", "primaryFile",
)

# The derived fields a user can set by hand. A FILL merge only writes these where the
# record's value is empty. The rest of CIVITAI_DERIVED_KEYS is Civitai's own data —
# provenance blobs, NSFW (whose False/0 defaults are not user intent), and the media
# that drives the thumbnail — so it is always written.
CIVITAI_USER_FIELD_KEYS = (
    "name", "originalName", "version", "baseModel", "description", "trainedWords", "tags",
)

MERGE_MODES = ("overwrite", "fill")


def _is_empty(value):
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict)):
        return not value
    return False


def overlay_civitai_fields(existing, built, *, mode="overwrite"):
    """Pure overlay of the mapped Civitai fields (`built`) onto `existing` — no I/O.

    Returns the merged dict (source/verification stamping is the caller's job)."""
    if mode not in MERGE_MODES:
        raise ValueError(f"unknown Civitai merge mode: {mode!r}")
    merged = dict(existing)
    for key in CIVITAI_DERIVED_KEYS:
        if mode == "fill" and key in CIVITAI_USER_FIELD_KEYS and not _is_empty(existing.get(key)):
            continue
        merged[key] = built.get(key)

    # Preview withheld: a mature model/version whose images the public (anonymous)
    # fetch couldn't see. Distinct from "no preview anywhere" — the card can show the
    # empty-NSFW placeholder and note it's hidden on public fetch.
    images = merged.get("previewImages") or merged.get("images") or []
    merged["previewWithheld"] = bool(merged.get("nsfw") and not images)
    return merged


def fill_report(existing, built, *, mode="overwrite"):
    """Which user-facing fields a merge fills vs keeps — pure, for the fetch message.

    filled: empty before, Civitai has a value. kept: fill mode left the user's value
    where Civitai had a DIFFERENT one (an identical value isn't worth mentioning).
    Overwrite mode keeps nothing."""
    filled, kept = [], []
    for key in CIVITAI_USER_FIELD_KEYS:
        theirs = built.get(key)
        if _is_empty(theirs):
            continue
        mine = existing.get(key)
        if _is_empty(mine):
            filled.append(key)
        elif mode == "fill" and mine != theirs:
            kept.append(key)
    return {"filled": filled, "kept": kept}


def merge_civitai_into_record(path, library_id, existing, response, *, mode="overwrite", report=None):
    """Overlay a Civitai by-hash response onto an existing record; write + return it.

    `mode` is "overwrite" (replace every derived field) or "fill" (keep the user-set
    fields that already have a value) — see the module docstring. Pass a dict as
    `report` to receive fill_report()'s {filled, kept}."""
    from .metadata import (
        current_millis,
        normalize_krc_metadata,
        read_krc_metadata,
        write_krc_metadata,
    )
    from .source_import import build_civitai_fields

    path = Path(path)
    existing = existing if isinstance(existing, dict) else {}
    response = response if isinstance(response, dict) else {}
    now = current_millis()
    sha = (existing.get("sha256") or str(library_id or "")).strip().lower()
    built = build_civitai_fields(path, response)

    merged = overlay_civitai_fields(existing, built, mode=mode)
    if report is not None:
        report.update(fill_report(existing, built, mode=mode))

    merged["metadataSource"] = "civitai"
    merged["sourceImport"] = {
        "type": "civitai",
        "modelId": response.get("modelId"),
        "versionId": response.get("id"),
        "fetchedAt": now,
    }
    merged["userBlanked"] = False  # a Civitai fetch un-blanks the record
    merged["libraryId"] = library_id
    merged["sha256"] = existing.get("sha256") or sha
    # A by-hash HIT means Civitai confirmed this exact file hash → verified by Civitai.
    merged["verification"] = civitai_verification(
        merged["sha256"], response.get("modelId"), response.get("id"), now,
        civitai_scanned_at(response),
    )

    write_krc_metadata(
        {
            "library_id": library_id,
            "relative_path": existing.get("file") or path.name,
            "filename": path.name,
            "path": str(path),
        },
        merged,
    )
    return normalize_krc_metadata(path, library_id, read_krc_metadata(library_id))
