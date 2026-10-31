import base64
import os
import shutil
from contextlib import contextmanager
from io import BytesIO

from .krc_paths import get_krc_node_dir


from .library.thumbnails import THUMBNAIL_SIZE as THUMB_SIZE, prepare_thumbnail, crop_to_ratio, thumbnail_file_exists

THUMB_EXTENSION = ".webp"
THUMB_ANIMATED_EXTENSION = ".webm"
THUMB_EXTENSIONS = (THUMB_EXTENSION, THUMB_ANIMATED_EXTENSION)
THUMB_WEBP_QUALITY = 82


try:
    from PIL import Image
    IMAGE_SUPPORT = True
except ImportError:
    IMAGE_SUPPORT = False
    print("[KRC Prompt Vault] Warning: PIL not available, thumbnail saving disabled")


def get_prompts_path():
    return os.path.join(str(get_krc_node_dir("prompt_vault")), "prompt_vault_data.json")


def get_thumbnails_dir():
    return os.path.join(os.path.dirname(get_prompts_path()), "thumbnails")


def get_animated_thumbnails_dir():
    return os.path.join(os.path.dirname(get_prompts_path()), "animated_thumbnails")


def safe_record_id(record_id):
    """Filesystem-safe form of a record id."""
    return "".join(
        char for char in str(record_id or "")
        if char.isalnum() or char in ("-", "_")
    )


def get_thumbnail_path(record_id, extension=THUMB_EXTENSION):
    """Canonical path for a record's thumbnail ('<id>.webp' by default)."""
    base_dir = get_animated_thumbnails_dir() if extension == THUMB_ANIMATED_EXTENSION else get_thumbnails_dir()
    return os.path.join(base_dir, f"{safe_record_id(record_id)}{extension}")


def find_thumbnail_path(record_id, prefer_animated=False):
    """The record's on-disk thumbnail path if it exists, else None."""
    safe_id = safe_record_id(record_id)
    if not safe_id:
        return None
    extensions = (
        (THUMB_ANIMATED_EXTENSION, THUMB_EXTENSION)
        if prefer_animated
        else THUMB_EXTENSIONS
    )
    for extension in extensions:
        path = get_thumbnail_path(safe_id, extension)
        if thumbnail_file_exists(path):
            return path
    return None


def find_thumbnail_variant(record_id, kind="default"):
    safe_id = safe_record_id(record_id)
    if not safe_id:
        return None
    if kind == "animated":
        path = get_thumbnail_path(safe_id, THUMB_ANIMATED_EXTENSION)
        return path if thumbnail_file_exists(path) else None
    if kind == "poster":
        path = get_thumbnail_path(safe_id, THUMB_EXTENSION)
        return path if thumbnail_file_exists(path) else None
    return find_thumbnail_path(safe_id, prefer_animated=True)


def find_thumbnail_paths(record_id):
    safe_id = safe_record_id(record_id)
    if not safe_id:
        return []
    paths = []
    for extension in THUMB_EXTENSIONS:
        path = get_thumbnail_path(safe_id, extension)
        if thumbnail_file_exists(path):
            paths.append(path)
    return paths


@contextmanager
def copied_thumbnail_files(source_id, target_id):
    """Copy both variants byte-for-byte to a fresh id; undo our files on failure.

    Enter while holding db.write(), and keep this context outside that transaction
    so a commit failure also removes the new files. Existing files are never replaced.
    """
    created = []
    try:
        for source in find_thumbnail_paths(source_id) if source_id else []:
            target = get_thumbnail_path(target_id, os.path.splitext(source)[1])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(source, "rb") as reader, open(target, "xb") as writer:
                created.append(target)
                shutil.copyfileobj(reader, writer)
        yield created
    except BaseException:
        for target in created:
            try:
                os.unlink(target)
            except FileNotFoundError:
                pass
        raise


def save_thumbnail_bytes(record_id, data):
    """Downscale raw image bytes within 300x300, without cropping, to WebP at <id>.webp."""
    if not safe_record_id(record_id) or not data or not IMAGE_SUPPORT:
        return None
    try:
        with Image.open(BytesIO(data)) as image:
            image.load()
            thumb = prepare_thumbnail(image)
        delete_thumbnail(record_id)
        path = get_thumbnail_path(record_id)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        thumb.save(path, "WEBP", quality=THUMB_WEBP_QUALITY, method=6)
        return path
    except Exception as e:
        print(f"[KRC Prompt Vault] save_thumbnail failed: {e}")
        return None


def delete_thumbnail(record_id):
    safe_id = safe_record_id(record_id)
    if not safe_id:
        return
    try:
        for extension in THUMB_EXTENSIONS:
            path = get_thumbnail_path(safe_id, extension)
            if os.path.exists(path):
                os.remove(path)
    except Exception:
        pass


def decode_data_url(data_url):
    """Return raw bytes from a 'data:image/...;base64,...' URL (or None)."""
    if not isinstance(data_url, str) or "base64," not in data_url:
        return None
    try:
        return base64.b64decode(data_url.split("base64,", 1)[1])
    except Exception:
        return None


def gc_orphan_thumbnails(data):
    """Delete thumbnail files no prompt record's id references anymore."""
    # Thumbnail storage is shared; a scoped library is never the whole reference set.
    from .db import connection as db
    referenced = set()
    for (record_id,) in db.connection().execute("SELECT DISTINCT id FROM prompts"):
        safe_id = safe_record_id(record_id)
        referenced.update(f"{safe_id}{extension}" for extension in THUMB_EXTENSIONS)
    for cat_data in (data or {}).values():
        if not isinstance(cat_data, dict):
            continue
        for name, entry in cat_data.items():
            if name == "__meta__" or not isinstance(entry, dict):
                continue
            rid = entry.get("id")
            if rid:
                safe_id = safe_record_id(rid)
                if safe_id:
                    for extension in THUMB_EXTENSIONS:
                        referenced.add(f"{safe_id}{extension}")
    try:
        for thumb_dir in (get_thumbnails_dir(), get_animated_thumbnails_dir()):
            if not os.path.isdir(thumb_dir):
                continue
            for fname in os.listdir(thumb_dir):
                if fname not in referenced:
                    try:
                        os.remove(os.path.join(thumb_dir, fname))
                    except Exception:
                        pass
    except Exception as e:
        print(f"[KRC Prompt Vault] Error during thumbnail GC: {e}")
