"""
KRC NodePack persistent data paths.

All node-owned metadata lives under ComfyUI's user/default/krc_nodes directory
so KRC does not scatter files and folders across the user's default profile.
"""
import re
from pathlib import Path


KRC_NODES_DIR_NAME = "krc_nodes"

# The pin cap lives in one place: web/js/shared/pinning.js (where every frontend
# consumer imports it). The server derives its value from that file so the two
# can never drift. Falls back to the documented default if the file is missing
# or the assignment shape changes.
_PINNING_JS = Path(__file__).resolve().parents[1] / "web" / "js" / "shared" / "pinning.js"
_MAX_PINNED_FALLBACK = 50


def read_max_pinned():
    """Read MAX_PINNED from web/js/shared/pinning.js (the single source of truth)."""
    try:
        match = re.search(r"MAX_PINNED\s*=\s*(\d+)", _PINNING_JS.read_text(encoding="utf-8"))
        if match:
            return int(match.group(1))
    except OSError:
        pass
    return _MAX_PINNED_FALLBACK


def get_default_user_dir(fallback=None):
    """Return ComfyUI's user/default directory as a Path."""
    fallback_root = Path(fallback) if fallback else Path(__file__).resolve().parents[1] / ".krc_user" / "default"
    try:
        import folder_paths
    except ImportError:
        return fallback_root

    user_directory = getattr(folder_paths, "get_user_directory", None)
    if callable(user_directory):
        user_root = Path(user_directory())
        return user_root if user_root.name == "default" else user_root / "default"

    base_path = getattr(folder_paths, "base_path", None)
    if base_path:
        return Path(base_path) / "user" / "default"

    return fallback_root


def has_real_user_dir():
    """True only if ComfyUI's real user directory is resolvable.

    get_default_user_dir() always returns *some* path (it falls back to an
    in-repo .krc_user/default when folder_paths is unavailable). A node that
    needs genuine server-side storage can call this to refuse the fallback
    instead of silently writing inside the pack.
    """
    try:
        import folder_paths
    except ImportError:
        return False
    if callable(getattr(folder_paths, "get_user_directory", None)):
        return True
    return bool(getattr(folder_paths, "base_path", None))


def get_krc_nodes_dir(fallback=None):
    return get_default_user_dir(fallback) / KRC_NODES_DIR_NAME


def get_krc_node_dir(node_dir_name, fallback=None):
    return get_krc_nodes_dir(fallback) / node_dir_name
