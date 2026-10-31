"""Smaller copies of thumbnails for outside apps (KRC_EXTERNAL_API_GAMEPLAN.md stage 7).

The Prompt Vault, LoRA Loadout and Model Library thumbnail routes take ``?w=<px>`` from a
fixed set (SIZES), so the disk can't fill with arbitrary sizes. A sized request always
serves the static image (an animated thumbnail's poster), scaled down to that width, as
WebP. The node UI never asks for ``w``, so its traffic is unchanged.

The copies are a cache, kept apart from the thumbnails themselves
(``krc_nodes/thumbnail_sizes/<w>/``), so nothing that lists, exports or cleans thumbnails
ever sees them. A copy is named after its source's path and carries the source's
modification time; a copy whose time no longer matches is made again, so a replaced
thumbnail is never served stale. A deleted thumbnail's copy is never served either (the
route finds no source first) and is dropped with the rest when the cache outgrows
MAX_FILES_PER_SIZE. Made with Pillow (which ComfyUI ships); without it, or when an image
can't be read, the original is served.
"""

import asyncio
import hashlib
import itertools
import os
import shutil
import threading
import uuid
from pathlib import Path

from ..krc_paths import get_krc_nodes_dir
from .thumbnails import THUMBNAIL_WEBP_QUALITY

SIZES = (120, 200, 300)
CACHE_DIR_NAME = "thumbnail_sizes"
MAX_FILES_PER_SIZE = 20000
PRUNE_EVERY = 100   # writes between cap checks
_writes = itertools.count(1)
_FALLBACK_USER_DIR = Path(__file__).resolve().parents[2] / ".krc_user" / "default"

_warned = set()
_warn_lock = threading.Lock()


def _warn_once(key, message):
    with _warn_lock:
        if key in _warned:
            return
        _warned.add(key)
    print(f"[KRC Thumbnails] {message}")


def parse_width(query):
    """``?w=`` -> one of SIZES, or None when absent. Raises ValueError for any other value."""
    raw = str(query.get("w", "") or "").strip()
    if not raw:
        return None
    try:
        width = int(raw)
    except ValueError:
        width = 0
    if width not in SIZES:
        raise ValueError(f"w must be one of {', '.join(str(size) for size in SIZES)}")
    return width


def cache_dir(width):
    return get_krc_nodes_dir(fallback=_FALLBACK_USER_DIR) / CACHE_DIR_NAME / str(int(width))


def cached_path(source, width):
    """Where ``source``'s copy at ``width`` lives (whether or not it exists yet)."""
    key = hashlib.sha1(str(Path(source).resolve()).encode("utf-8")).hexdigest()[:32]
    return cache_dir(width) / f"{key}.webp"


def _resize(source, target, width):
    from PIL import Image  # ComfyUI ships Pillow; imported here so the module loads without it

    with Image.open(source) as image:
        image.load()
        if image.mode not in ("RGB", "RGBA"):
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
        if image.width > width:
            height = max(1, round(image.height * width / image.width))
            image = image.resize((width, height), Image.LANCZOS)
        temp = target.with_name(f"{target.stem}.{uuid.uuid4().hex}.tmp")
        try:
            image.save(temp, "WEBP", quality=THUMBNAIL_WEBP_QUALITY, method=4)
            os.replace(temp, target)
        finally:
            if temp.exists():
                temp.unlink()


def _prune(directory):
    """Drop the whole size folder when it grew past the cap (it's a cache: copies are
    made again on demand). Cheap: one listing, only when a new copy was just written."""
    try:
        count = sum(1 for _ in os.scandir(directory))
    except OSError:
        return
    if count > MAX_FILES_PER_SIZE:
        shutil.rmtree(directory, ignore_errors=True)
        print(f"[KRC Thumbnails] cleared {directory.name}px copies ({count} files over the cap)")


def sized_thumbnail(source, width):
    """The path to serve for ``source`` at ``width``: the cached copy (made now if it's
    missing or out of date), or ``source`` itself when no copy can be made. Blocking (it
    may resize): call it off the event loop."""
    source = Path(source)
    try:
        source_mtime = source.stat().st_mtime_ns
    except OSError:
        return source
    target = cached_path(source, width)
    try:
        if target.stat().st_mtime_ns == source_mtime:
            return target
    except OSError:
        pass
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        _resize(source, target, width)
        os.utime(target, ns=(source_mtime, source_mtime))
    except ImportError:
        _warn_once("pil", "Pillow isn't available, so sized thumbnails serve the original image.")
        return source
    except Exception as exc:  # noqa: BLE001 - an unreadable image serves the original
        _warn_once(f"fail:{source}", f"couldn't make a {width}px copy of {source.name}: {exc}")
        return source
    if next(_writes) % PRUNE_EVERY == 0:
        _prune(target.parent)
    return target


async def thumbnail_to_serve(source, query):
    """For a thumbnail route: ``source`` itself without ``?w=``, else its sized copy (made
    on a worker thread). The caller already looked up the static poster for a sized
    request. Raises ValueError for a ``w`` outside SIZES."""
    width = parse_width(query)
    if width is None or source is None:
        return source
    return await asyncio.get_running_loop().run_in_executor(None, sized_thumbnail, source, width)
