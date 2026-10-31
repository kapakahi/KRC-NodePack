"""Model Library thumbnail store.

A Model-Library-owned thumbnail dir (never LoRA Loadout's), so the two surfaces can't
collide. Two variants per model, mirroring LoRA Loadout / Prompt Vault:

- a static WebP poster in ``thumbnails/<type>/`` (the default every card shows), and
- an optional animated VP9 WebM loop in ``animated_thumbnails/<type>/`` (played on
  hover in the InfoPanel spotlight when webm thumbnails are enabled).

The WebM loop + its poster are produced by the shared Tier-3 transcode engine
(``utils/krc_video.py``), shared with LoRA Loadout and Prompt Vault. Static image
uploads retain their full composition within 384x384; video posters and loops
retain it within 300x300. Framing is display-only. Both are the same ``<id>.webp`` file, so
uploading one replaces the other cleanly.
"""

import io
from pathlib import Path

from ..library.thumbnails import (  # noqa: F401  (re-exported for call sites)
    ANIMATED_THUMBNAIL_EXTENSION,
    THUMBNAIL_EXTENSION,
    THUMBNAIL_WEBP_QUALITY,
    crop_to_ratio,
    prepare_thumbnail,
    thumbnail_file_exists,
)
from .metadata import get_krc_model_base_dir, iter_model_metadata_paths, metadata_dir_name_for_model_type, safe_id


# Preserve Model Library’s existing static poster resolution.
THUMBNAIL_SIZE = (384, 384)


def get_krc_model_thumbnail_dir(model_type=None):
    base = get_krc_model_base_dir() / "thumbnails"
    if model_type is None:
        return base
    return base / metadata_dir_name_for_model_type(model_type)


def get_krc_model_animated_thumbnail_dir(model_type=None):
    base = get_krc_model_base_dir() / "animated_thumbnails"
    if model_type is None:
        return base
    return base / metadata_dir_name_for_model_type(model_type)


def get_model_thumbnail_path(library_id, model_type=None):
    return get_krc_model_thumbnail_dir(model_type) / f"{safe_id(library_id)}{THUMBNAIL_EXTENSION}"


def get_model_animated_thumbnail_path(library_id, model_type=None):
    return get_krc_model_animated_thumbnail_dir(model_type) / f"{safe_id(library_id)}{ANIMATED_THUMBNAIL_EXTENSION}"


def _iter_thumbnail_paths(library_id):
    """Every possible thumbnail file (static poster + animated loop, in each of the
    model's metadata-type dirs) for an id. Used when the model_type is unknown — to
    find any variant, or to delete/clean all of them."""
    for metadata_path in iter_model_metadata_paths(library_id):
        type_dir = metadata_path.parent.name
        yield get_krc_model_thumbnail_dir(type_dir) / f"{safe_id(library_id)}{THUMBNAIL_EXTENSION}"
        yield get_krc_model_animated_thumbnail_dir(type_dir) / f"{safe_id(library_id)}{ANIMATED_THUMBNAIL_EXTENSION}"


def find_model_thumbnail(library_id, model_type=None):
    """The static webp poster for a model, or None. (Poster only — the default/static
    slot must never resolve to the animated webm, or a plain <img> renders empty.)"""
    if not library_id:
        return None
    if model_type is not None:
        path = get_model_thumbnail_path(library_id, model_type)
        return path if thumbnail_file_exists(path) else None
    for metadata_path in iter_model_metadata_paths(library_id):
        path = get_krc_model_thumbnail_dir(metadata_path.parent.name) / f"{safe_id(library_id)}{THUMBNAIL_EXTENSION}"
        if thumbnail_file_exists(path):
            return path
    return None


def find_model_animated_thumbnail(library_id, model_type=None):
    """The animated webm loop for a model, or None."""
    if not library_id:
        return None
    if model_type is not None:
        path = get_model_animated_thumbnail_path(library_id, model_type)
        return path if thumbnail_file_exists(path) else None
    for metadata_path in iter_model_metadata_paths(library_id):
        path = get_krc_model_animated_thumbnail_dir(metadata_path.parent.name) / f"{safe_id(library_id)}{ANIMATED_THUMBNAIL_EXTENSION}"
        if thumbnail_file_exists(path):
            return path
    return None


def find_model_thumbnail_variant(library_id, kind="default", model_type=None):
    """Pick the variant matching a serve request (mirrors LoRA Loadout):
      "animated" -> the webm loop (or None)
      "poster"   -> the static webp (or None)
      "" / "default" -> the static webp (the default/static slot; a plain <img>
                        must get the poster, never the webm)."""
    if not library_id:
        return None
    if kind == "animated":
        return find_model_animated_thumbnail(library_id, model_type)
    return find_model_thumbnail(library_id, model_type)


def find_model_thumbnail_paths(library_id, model_type=None):
    """Both existing variant files for an id (poster + animated), for bundling."""
    if not library_id:
        return []
    paths = []
    poster = find_model_thumbnail(library_id, model_type)
    if poster:
        paths.append(poster)
    animated = find_model_animated_thumbnail(library_id, model_type)
    if animated:
        paths.append(animated)
    return paths


def delete_model_thumbnail(library_id, model_type=None):
    if model_type is not None:
        paths = [get_model_thumbnail_path(library_id, model_type),
                 get_model_animated_thumbnail_path(library_id, model_type)]
    else:
        paths = list(_iter_thumbnail_paths(library_id))
    deleted = False
    for path in paths:
        if path.exists():
            path.unlink()
            deleted = True
    return deleted


def _remove_stale_thumbnail_copies(library_id, keep_paths):
    """Drop every thumbnail file for this id EXCEPT the ones we just wrote. Keeps a
    static image upload from leaving an old webm behind (image replaces video), and a
    re-typed model from keeping thumbnails under a stale model-type dir."""
    keep = {Path(p) for p in ([keep_paths] if isinstance(keep_paths, (str, Path)) else keep_paths)}
    for path in _iter_thumbnail_paths(library_id):
        if path in keep or not path.exists():
            continue
        try:
            path.unlink()
        except OSError:
            pass


def save_model_thumbnail_image(library_id, image, model_type=None):
    thumb = prepare_thumbnail(image, size=THUMBNAIL_SIZE)
    path = get_model_thumbnail_path(library_id, model_type or "other")
    path.parent.mkdir(parents=True, exist_ok=True)
    thumb.save(path, "WEBP", quality=THUMBNAIL_WEBP_QUALITY, method=6)
    # A static image is the whole thumbnail — clear any prior animated loop / stale
    # copies so the poster isn't shadowed by an old webm.
    _remove_stale_thumbnail_copies(library_id, path)
    return path


def save_model_thumbnail_bytes(library_id, data, model_type=None):
    if not data:
        return None
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return save_model_thumbnail_image(library_id, image, model_type)
    except Exception:  # noqa: BLE001
        return None


def transcode_model_video(src, library_id, model_type=None, *, want_animated=True,
                          frame="first", crf=None):
    """Transcode a user-uploaded video into the KRC constrained model thumbnail set
    (static webp poster + optional VP9 webm loop), via the shared Tier-3 engine. The
    upload is transient — the caller discards `src` afterwards. Returns the engine's
    {"poster": bool, "animated": bool, "reason": str}. Cleans stale copies in other
    model-type dirs so a re-typed model doesn't keep old thumbnails."""
    from .. import krc_video

    poster_path = get_model_thumbnail_path(library_id, model_type or "other")
    webm_path = get_model_animated_thumbnail_path(library_id, model_type or "other")
    result = krc_video.transcode_upload(
        src, poster_path, webm_path,
        want_animated=want_animated, frame=frame, crf=crf,
    )
    keep = []
    if result.get("poster"):
        keep.append(poster_path)
    if result.get("animated"):
        keep.append(webm_path)
    if keep:
        _remove_stale_thumbnail_copies(library_id, keep)
    return result
