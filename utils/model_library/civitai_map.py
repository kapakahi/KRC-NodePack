"""
KRC Model Library — map a Civitai by-hash response into a GENERIC model record.

The LoRA Loadout path (utils/lora_loadout/civitai_map.py) folds a Civitai blob into
the LoRA record via its own LoRA mapper. Generic models don't use that mapper
(no trained words / stack / LoRA lineage), so this maps the (grafted) by-hash response
directly into the generic model schema (utils/model_library/metadata.py).

Shared with LoRA Loadout, reused not forked: the egress client (`civitai_client`), the
hash-keyed cache (`civitai_cache`), `graft_model_into_version`, `first_preview` /
`preview_video_ext`, and the pure `clean_html` / `normalize_tags` helpers. Only the
field mapping is Model-Library-specific.

Preserved across a fetch (never Civitai-owned): identity, favorite, notes,
cardColor, customBadge, and the record's own `modelType` (derived from the actual
ComfyUI folder — more trustworthy than Civitai's classification). A
user-customized `name` is kept; an untouched one is refreshed from the source name.
"""
from pathlib import Path

from ..library.civitai_map import civitai_scanned_at, civitai_verification
from ..library.metadata import primary_file_size_bytes
from ..library.nsfw import civitai_nsfw
from ..library.source_import import clean_html, normalize_tags


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _map_images(images):
    """Normalize a Civitai `images[]` list to the compact shape the record stores."""
    out = []
    if isinstance(images, list):
        for img in images:
            if not isinstance(img, dict) or not img.get("url"):
                continue
            out.append({
                "url": str(img.get("url") or ""),
                "nsfwLevel": _as_int(img.get("nsfwLevel"), 0),
                "type": str(img.get("type") or "image"),
                "width": _as_int(img.get("width"), 0),
                "height": _as_int(img.get("height"), 0),
            })
    return out


def _primary_file(files):
    """The primary file entry from a Civitai `files[]` list, mapped to `primaryFile`."""
    if not isinstance(files, list):
        return {}
    chosen = None
    for entry in files:
        if isinstance(entry, dict) and entry.get("primary"):
            chosen = entry
            break
    if chosen is None:
        chosen = next((entry for entry in files if isinstance(entry, dict)), None)
    if not isinstance(chosen, dict):
        return {}
    meta = chosen.get("metadata") if isinstance(chosen.get("metadata"), dict) else {}
    hashes = chosen.get("hashes") if isinstance(chosen.get("hashes"), dict) else {}
    fmt = str(meta.get("format") or "").strip()
    return {
        "name": str(chosen.get("name") or ""),
        "sizeBytes": primary_file_size_bytes({"sizeKB": chosen.get("sizeKB")}),
        "format": fmt,
        "hashes": {str(k): str(v) for k, v in hashes.items()} if hashes else {},
    }


def _license_from_allows(model):
    """Fold Civitai's `allow*` permission flags into a compact license string. Civitai
    has no named-license field — only these booleans/lists — so this is a summary, and
    the raw flags are also kept under sourceMetadata.civitai for anyone who needs them."""
    if not isinstance(model, dict):
        return ""
    parts = []
    commercial = model.get("allowCommercialUse")
    if isinstance(commercial, list) and commercial:
        parts.append("Commercial: " + ", ".join(str(item) for item in commercial))
    elif commercial in (True, "Sell", "Rent", "Image"):
        parts.append("Commercial use allowed")
    elif commercial in (False, "None", []):
        parts.append("No commercial use")
    parts.append("No credit required" if model.get("allowNoCredit") else "Credit required")
    if model.get("allowDerivatives") is False:
        parts.append("No derivatives")
    if model.get("allowDifferentLicense") is False:
        parts.append("Keep same license")
    return "; ".join(parts)


def _format_from_metadata(primary_file):
    fmt = str((primary_file or {}).get("format") or "").strip().lower()
    if fmt in ("safetensor", "safetensors"):
        return "safetensors"
    if fmt in ("pickletensor", "ckpt", "pickle"):
        return "ckpt"
    return fmt


def merge_civitai_into_model_record(path, library_id, existing, response, model_type=None):
    """Overlay a (grafted) Civitai by-hash response onto a generic model record; write
    and return the normalized record. `response` should already have model-level fields
    grafted in via `graft_model_into_version` (creator/description/tags/allow*)."""
    from .metadata import (
        current_millis,
        normalize_model_metadata,
        read_model_metadata,
        write_model_metadata,
    )

    path = Path(path)
    existing = existing if isinstance(existing, dict) else {}
    response = response if isinstance(response, dict) else {}
    model = response.get("model") if isinstance(response.get("model"), dict) else {}
    now = current_millis()

    record_type = model_type or existing.get("modelType") or "other"
    model_name = str(model.get("name") or "").strip()
    version_name = str(response.get("name") or "").strip()
    model_id = response.get("modelId")
    version_id = response.get("id")

    merged = dict(existing)

    # Source-provided name, and a non-destructive fill of the editable name: only seed
    # `name` when the user hasn't customized it (blank, or still equal to the old
    # source name).
    if model_name:
        old_name = str(existing.get("name") or "").strip()
        old_original = str(existing.get("originalName") or "").strip()
        merged["originalName"] = model_name
        if not old_name or old_name == old_original:
            merged["name"] = model_name

    merged["version"] = version_name
    merged["baseModel"] = str(response.get("baseModel") or "")
    merged["description"] = clean_html(model.get("description") or response.get("description") or "")
    merged["tags"] = normalize_tags(model.get("tags"))

    images = _map_images(response.get("images"))
    # The shared NSFW rating (utils/library/nsfw.py): the same rule as a LoRA fetch.
    merged["nsfwLevel"], merged["nsfw"] = civitai_nsfw(response, model, images)
    merged["images"] = images
    merged["previewImages"] = list(images)

    creator = response.get("creator") if isinstance(response.get("creator"), dict) else {}
    if not creator and isinstance(model.get("creator"), dict):
        creator = model.get("creator")
    merged["creator"] = {
        "name": str(creator.get("username") or ""),
        "username": str(creator.get("username") or ""),
        "avatarUrl": str(creator.get("image") or ""),
    } if creator else {}

    primary_file = _primary_file(response.get("files"))
    merged["primaryFile"] = primary_file
    fmt = _format_from_metadata(primary_file)
    if fmt:
        merged["format"] = fmt

    merged["license"] = _license_from_allows(model)

    published = response.get("publishedAt") or ""
    merged["releaseDate"] = published[:10] if isinstance(published, str) else ""

    merged["source"] = {
        "name": "Civitai",
        "url": f"https://civitai.com/models/{model_id}" if model_id else "",
        "modelId": model_id,
        "versionId": version_id,
    }
    merged["metadataSource"] = "civitai"
    merged["sourceImport"] = {
        "type": "civitai",
        "modelId": model_id,
        "versionId": version_id,
        "fetchedAt": now,
    }
    merged["sourceMetadata"] = {
        "civitai": {
            "modelId": model_id,
            "versionId": version_id,
            "baseModel": str(response.get("baseModel") or ""),
            "baseModelType": str(response.get("baseModelType") or ""),
            "air": str(response.get("air") or ""),
            "downloadUrl": str(response.get("downloadUrl") or ""),
            "modelType": str(model.get("type") or ""),
            "nsfwLevel": _as_int(response.get("nsfwLevel"), 0),
            "allowCommercialUse": model.get("allowCommercialUse"),
            "allowNoCredit": model.get("allowNoCredit"),
            "allowDerivatives": model.get("allowDerivatives"),
            "allowDifferentLicense": model.get("allowDifferentLicense"),
        }
    }

    # Never Civitai-owned — carry the user's own values through a refresh untouched.
    for key in ("favorite", "pinned", "rating", "notes", "cardColor", "customBadge"):
        if key in existing:
            merged[key] = existing[key]

    merged["modelType"] = record_type
    merged["libraryId"] = library_id
    merged["sha256"] = existing.get("sha256") or str(library_id or "")
    # A by-hash HIT means Civitai confirmed this exact file hash → verified by Civitai.
    merged["verification"] = civitai_verification(
        merged["sha256"], model_id, version_id, now, civitai_scanned_at(response),
    )

    write_model_metadata(
        {
            "library_id": library_id,
            "relative_path": existing.get("file") or path.name,
            "filename": path.name,
            "path": str(path),
        },
        merged,
    )
    return normalize_model_metadata(path, library_id, read_model_metadata(library_id, record_type))


async def apply_civitai_model_thumbnail(library_id, model_type, response, *, overwrite=True):
    """Download the Civitai preview and produce a KRC model thumbnail. Video preview →
    the shared Tier-3 transcode (webp poster + optional webm loop, honoring the shared
    video settings); static image → downloaded and converted to a webp. Guarded/offline-
    safe. `overwrite=False` skips when a thumbnail already exists (a gentle fill)."""
    from urllib.parse import urlparse

    from ..library.civitai_client import download_media
    from ..library.civitai_map import civitai_media_dir, first_preview, preview_video_ext
    from ..krc_video_settings import load_settings
    from .thumbnails import (
        find_model_thumbnail,
        save_model_thumbnail_bytes,
        transcode_model_video,
    )

    preview = first_preview(response)
    url = preview.get("url") if preview else ""
    if not url:
        return False
    if not overwrite and find_model_thumbnail(library_id, model_type) is not None:
        return False

    video_ext = preview_video_ext(preview)
    if video_ext:
        # No poster / loop possible on this server (no ffmpeg or webp encoder, animated
        # off or no VP9) → a still from Civitai instead, same as LoRAs
        # (library/civitai_still.py). Final; falls through to the video path if none.
        from .. import krc_video

        settings = load_settings()
        animated_possible = settings.get("videoImportMode") == "animated" and krc_video.WEBM_SUPPORT
        if not krc_video.POSTER_SUPPORT and not animated_possible:
            from ..library.civitai_still import fetch_video_still

            still = await fetch_video_still(preview, response, library_id)
            if still and save_model_thumbnail_bytes(library_id, still[0], model_type) is not None:
                return True
    media_dir = civitai_media_dir()
    dest = media_dir / f"{library_id}{video_ext or (Path(urlparse(url).path).suffix.lower() or '.jpg')}"
    if not await download_media(url, dest):
        return False

    if video_ext:
        settings = load_settings()
        result = transcode_model_video(
            dest, library_id, model_type,
            want_animated=(settings.get("videoImportMode") == "animated"),
            frame=settings.get("posterFrame", "first"),
            crf=settings.get("webmCrf"),
        )
        return bool(result.get("poster") or result.get("animated"))

    try:
        data = dest.read_bytes()
    except OSError:
        return False
    return save_model_thumbnail_bytes(library_id, data, model_type) is not None
