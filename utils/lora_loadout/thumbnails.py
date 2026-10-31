import io
from pathlib import Path

from ..krc_paths import get_krc_node_dir
from ..library.thumbnails import (  # noqa: F401  (re-exported for call sites)
    ANIMATED_THUMBNAIL_EXTENSION,
    KRC_THUMBNAIL_EXTENSIONS,
    STATIC_THUMBNAIL_EXTENSIONS,
    THUMBNAIL_EXTENSION,
    THUMBNAIL_WEBP_QUALITY,
    crop_to_ratio,
    prepare_thumbnail,
    THUMBNAIL_SIZE,
    thumbnail_file_exists,
    thumbnail_kind,
)


KRC_DIR_NAME = "lora_loadout"


def safe_id(value):
    return "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in str(value))


def get_krc_base_dir():
    fallback = Path(__file__).resolve().parents[2] / ".krc_user" / "default"
    return get_krc_node_dir(KRC_DIR_NAME, fallback=fallback)


def get_krc_thumbnail_dir():
    return get_krc_base_dir() / "thumbnails"


def get_krc_animated_thumbnail_dir():
    return get_krc_base_dir() / "animated_thumbnails"


def get_krc_thumbnail_path(library_id, extension=THUMBNAIL_EXTENSION):
    directory = get_krc_animated_thumbnail_dir() if extension == ANIMATED_THUMBNAIL_EXTENSION else get_krc_thumbnail_dir()
    return directory / f"{safe_id(library_id)}{extension}"


def find_thumbnail(_path, sha256, prefer_animated=False):
    if not sha256:
        return None
    extensions = (
        (ANIMATED_THUMBNAIL_EXTENSION, THUMBNAIL_EXTENSION)
        if prefer_animated
        else KRC_THUMBNAIL_EXTENSIONS
    )
    for extension in extensions:
        krc_thumbnail = get_krc_thumbnail_path(sha256, extension)
        if thumbnail_file_exists(krc_thumbnail):
            return krc_thumbnail
    return None


def find_thumbnail_variant(sha256, kind="default"):
    if not sha256:
        return None
    if kind == "animated":
        path = get_krc_thumbnail_path(sha256, ANIMATED_THUMBNAIL_EXTENSION)
        return path if thumbnail_file_exists(path) else None
    if kind == "poster":
        path = get_krc_thumbnail_path(sha256, THUMBNAIL_EXTENSION)
        return path if thumbnail_file_exists(path) else None
    return find_thumbnail(None, sha256, prefer_animated=True)


def find_thumbnail_paths(sha256):
    if not sha256:
        return []
    paths = []
    for extension in KRC_THUMBNAIL_EXTENSIONS:
        path = get_krc_thumbnail_path(sha256, extension)
        if path.exists():
            paths.append(path)
    return paths


def delete_thumbnails(record):
    deleted = False
    for extension in KRC_THUMBNAIL_EXTENSIONS:
        krc_thumbnail = get_krc_thumbnail_path(record["library_id"], extension)
        if krc_thumbnail.exists():
            krc_thumbnail.unlink()
            deleted = True
    return deleted


def save_thumbnail_bytes(record, data):
    try:
        from PIL import Image
    except ImportError:
        return None

    if not data:
        return None

    try:
        with Image.open(io.BytesIO(data)) as image:
            image.load()
            return save_thumbnail_image(record, image)
    except Exception:
        return None


def save_thumbnail_image(record, image):
    delete_thumbnails(record)
    thumb = prepare_thumbnail(image)
    path = get_krc_thumbnail_path(record["library_id"], THUMBNAIL_EXTENSION)
    path.parent.mkdir(parents=True, exist_ok=True)
    thumb.save(path, "WEBP", quality=THUMBNAIL_WEBP_QUALITY, method=6)
    return path
