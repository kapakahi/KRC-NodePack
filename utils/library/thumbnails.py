"""Shared thumbnail primitives for KRC library nodes.

The thumbnail *stores* themselves are genuinely divergent between LoRA Loadout
(flat dir) and Model Library (model-type-partitioned dirs), so their path/find/save machinery stays node-local by design — folding
it into a parameterized base would be lift-then-rename, not real sharing.

What *is* identical is the pure format vocabulary and the image/classification
primitives below. Each node re-exports these so existing call sites are
unchanged; Model Library stops reaching into LoRA Loadout for ``crop_to_ratio``.
"""

import contextvars
import os
from contextlib import contextmanager
from pathlib import Path


# Format vocabulary — identical across nodes.
THUMBNAIL_EXTENSION = ".webp"
ANIMATED_THUMBNAIL_EXTENSION = ".webm"
KRC_THUMBNAIL_EXTENSIONS = (THUMBNAIL_EXTENSION, ANIMATED_THUMBNAIL_EXTENSION)
THUMBNAIL_WEBP_QUALITY = 82
STATIC_THUMBNAIL_EXTENSIONS = (".webp", ".png", ".jpg", ".jpeg")


# Maximum bounding box, never an output aspect ratio. Small sources are not enlarged.
THUMBNAIL_SIZE = (300, 300)


def prepare_thumbnail(image, size=THUMBNAIL_SIZE):
    """Normalize orientation and downscale, keeping the full image without padding."""
    from PIL import Image, ImageOps
    thumb = ImageOps.exif_transpose(image)
    thumb = thumb.convert("RGBA" if "A" in thumb.getbands() or "transparency" in thumb.info else "RGB")
    thumb.thumbnail(size, Image.Resampling.LANCZOS)
    return thumb


def thumbnail_scale_filter():
    """Fit the full display aspect ratio inside the limit; even sizes for VP9.

    Account for non-square source pixels before resetting SAR. The only rounding
    is down to encoder-compatible even dimensions; no crop or pad filter is used.
    """
    width, height = THUMBNAIL_SIZE
    factor = f"min(1,min({width}/(iw*sar),{height}/ih))"
    return (f"scale=w='max(2,trunc({factor}*iw*sar/2)*2)':"
            f"h='max(2,trunc({factor}*ih/2)*2)',setsar=1")


def crop_to_ratio(image, ratio):
    image = image.convert("RGB")
    width, height = image.size
    current_ratio = width / height if height else ratio
    if current_ratio > ratio:
        new_width = int(height * ratio)
        left = max(0, (width - new_width) // 2)
        return image.crop((left, 0, left + new_width, height))
    new_height = int(width / ratio)
    top = max(0, (height - new_height) // 2)
    return image.crop((0, top, width, top + new_height))


def thumbnail_kind(thumbnail_path):
    return "video" if thumbnail_path and Path(thumbnail_path).suffix.lower() == ANIMATED_THUMBNAIL_EXTENSION else "image"


# Existence checks inside a listing scope (a whole-library request or a scan) list each
# thumbnail directory once and answer from that listing, instead of a stat per item per
# variant. Outside a scope every check hits the disk, as before.
_listing_scope = contextvars.ContextVar("krc_thumbnail_listing", default=None)


@contextmanager
def thumbnail_listing_scope():
    if _listing_scope.get() is not None:
        yield
        return
    token = _listing_scope.set({})
    try:
        yield
    finally:
        _listing_scope.reset(token)


def thumbnail_file_exists(path):
    path = Path(path)
    listings = _listing_scope.get()
    if listings is None:
        return path.is_file()
    directory = str(path.parent)
    names = listings.get(directory)
    if names is None:
        try:
            names = frozenset(os.listdir(directory))
        except OSError:
            names = frozenset()
        listings[directory] = names
    return path.name in names


def thumbnail_version(*paths):
    """One item's thumbnail cache version: the newest mtime (ms) among its thumbnail files,
    0 when it has none. Stable while the files are unchanged, so an image URL built from it
    stays cacheable, and a change to one item's thumbnail busts only that item's URL."""
    newest = 0
    for path in paths:
        if not path:
            continue
        try:
            newest = max(newest, Path(path).stat().st_mtime_ns // 1_000_000)
        except OSError:
            continue
    return int(newest)


def thumbnail_cache_headers(query):
    """Cache headers for serving a thumbnail. A URL carrying ?v= names one exact image
    (the version changes with the file), so it can be cached for good; without one the
    browser revalidates every time."""
    if query.get("v"):
        return {"Cache-Control": "public, max-age=31536000, immutable"}
    return {"Cache-Control": "no-cache"}
