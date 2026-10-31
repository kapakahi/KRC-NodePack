"""Still images at upload (GAMEPLAN.md section 3): the stored file is final.

Pillow opens the upload; ``ImageOps.exif_transpose`` bakes the orientation into the pixels
(EXIF, including PNG eXIf, and XMP) and drops the tag; HEIC / AVIF open when pillow-heif is
installed; an optional max size scales the longest side down; the result is saved as WebP
(alpha kept) with a small WebP thumbnail for the card. An animated image keeps its first
frame here (animated GIF / WebP become WebM with video, stage 3).
"""

import math
from io import BytesIO

from PIL import Image, ImageOps

WEBP_QUALITY = 90
THUMB_QUALITY = 80
THUMB_MAX = 384                  # the card thumbnail's longest side
MAX_PIXELS = 100_000_000         # refuse decompression bombs (Pillow's own check, tighter)
MEGAPIXELS = (0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 2)   # the upload setting's buttons (0 = none)
CUSTOM_MEGAPIXELS = (0.1, 64.0)   # a custom value's range (inclusive)

_heif = None


def heif_available():
    """Whether HEIC / AVIF can be read (pillow-heif installed); registers its opener once."""
    global _heif
    if _heif is None:
        try:
            import pillow_heif

            pillow_heif.register_heif_opener()
            _heif = True
        except Exception:  # noqa: BLE001 - optional dependency
            _heif = False
    return _heif


class ImageProcessError(ValueError):
    """An upload that isn't a usable image; the message is shown to the user."""


def _normalize_mode(image):
    """RGB, or RGBA when the image has any transparency."""
    has_alpha = image.mode in ("RGBA", "LA", "PA") or (image.mode == "P" and "transparency" in image.info)
    return image.convert("RGBA" if has_alpha else "RGB")


def valid_megapixels(value):
    """A max-megapixels setting as a float: 0 (none) unless it's within CUSTOM_MEGAPIXELS."""
    try:
        target = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    low, high = CUSTOM_MEGAPIXELS
    return round(target, 3) if low <= target <= high else 0.0


def megapixel_size(width, height, megapixels, *, even=False):
    """(width, height) scaled down so width x height <= ``megapixels`` million, the aspect
    kept, rounded down (``even``: to even numbers, VP9 4:2:0); unchanged when already within
    it, for 0, or outside CUSTOM_MEGAPIXELS (the buttons and any custom value in range).
    Never scales up."""
    target = valid_megapixels(megapixels)
    if not target or not width or not height or width * height <= target * 1_000_000:
        return width, height
    factor = math.sqrt(target * 1_000_000 / (width * height))
    if even:
        return max(2, int(width * factor / 2) * 2), max(2, int(height * factor / 2) * 2)
    return max(1, int(width * factor)), max(1, int(height * factor))


def process(source, dest, thumb, *, max_megapixels=0, keep_alpha=True):
    """Convert ``source`` (an upload) to WebP at ``dest`` and a thumbnail at ``thumb``, scaled
    down to ``max_megapixels`` (0 = as is); ``keep_alpha`` False flattens transparency onto
    black. -> {"width", "height", "bytes", "alpha", "oriented"} (``oriented``: the upload
    carried a non-default orientation that was baked in)."""
    heif_available()
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    try:
        with Image.open(source) as opened:
            opened.seek(0)  # an animated image: its first frame (video is stage 3)
            orientation = opened.getexif().get(0x0112) or 1
            image = ImageOps.exif_transpose(opened)
            image.load()
    except Image.DecompressionBombError as err:
        raise ImageProcessError("That image is too large.") from err
    except (OSError, ValueError, SyntaxError) as err:
        raise ImageProcessError("That file isn't an image this server can read.") from err
    image = _normalize_mode(image)
    if image.mode == "RGBA" and not keep_alpha:
        flat = Image.new("RGB", image.size, (0, 0, 0))
        flat.paste(image, mask=image.getchannel("A"))
        image = flat
    size = megapixel_size(image.width, image.height, max_megapixels)
    if size != image.size:
        image = image.resize(size, Image.Resampling.LANCZOS)
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, "WEBP", quality=WEBP_QUALITY, method=4)
    small = image.copy()
    small.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
    thumb.parent.mkdir(parents=True, exist_ok=True)
    small.save(thumb, "WEBP", quality=THUMB_QUALITY, method=4)
    return {
        "width": image.width,
        "height": image.height,
        "bytes": dest.stat().st_size,
        "alpha": image.mode == "RGBA",
        "oriented": orientation not in (0, 1),
    }


def png_bytes(source):
    """Export the full stored image as PNG, preserving resolution and transparency."""
    try:
        with Image.open(source) as opened:
            image = _normalize_mode(ImageOps.exif_transpose(opened))
            buffer = BytesIO()
            image.save(buffer, "PNG")
            return buffer.getvalue()
    except (OSError, ValueError, SyntaxError, Image.DecompressionBombError) as err:
        raise ImageProcessError("Could not export that image as PNG.") from err
