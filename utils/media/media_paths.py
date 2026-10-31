"""Shared file resolution for managed media media and ComfyUI input/output media.

No directory is created here. Shared media is confined to KRC-Media/ under ComfyUI's
configured root; catalog paths never become arbitrary filesystem access.
"""
import os
from pathlib import Path, PurePosixPath

MANAGED_DIRECTORY = "KRC-Media"


class MediaPathError(ValueError):
    pass


def configured_root(storage):
    if storage not in ("input", "output"):
        raise MediaPathError("Unknown Media storage location.")
    import folder_paths
    getter = folder_paths.get_input_directory if storage == "input" else folder_paths.get_output_directory
    return Path(getter()).resolve()


def relative_path(value):
    text = str(value or "")
    path = PurePosixPath(text)
    if (not text or "\x00" in text or "\\" in text or path.is_absolute() or ".." in path.parts
            or not path.parts or path.parts[0] != MANAGED_DIRECTORY or len(path.parts) < 2):
        raise MediaPathError("Media path must be inside KRC-Media in the configured directory.")
    return path.as_posix()


def shared_path(storage, relative, expected_root=""):
    base = configured_root(storage)
    if expected_root and Path(expected_root).resolve() != base:
        raise MediaPathError("ComfyUI's media directory changed; the stored media location needs review.")
    managed = base / MANAGED_DIRECTORY
    candidate = (base / relative_path(relative)).resolve()
    # Also reject managed-directory or nested symlinks escaping the configured root.
    if base not in candidate.parents or managed.resolve() not in candidate.parents:
        raise MediaPathError("That Media path is outside its configured directory.")
    return candidate


def media_path(record, media_root):
    storage = record.get("storage") or "media"
    if storage == "media":
        base = Path(media_root).resolve()
        path = (base / "files" / f"{record['id']}{record.get('ext') or '.webp'}").resolve()
        if base not in path.parents:
            raise MediaPathError("That path is outside Media's folder.")
        return path
    if storage not in ("input", "output"):
        raise MediaPathError("Unknown Media storage location.")
    return shared_path(storage, record.get("relative_path"), record.get("storage_root", ""))


def storage_available(base):
    """A missing/inaccessible root is not proof that its individual files were deleted."""
    try:
        with os.scandir(base):
            return True
    except OSError:
        return False
