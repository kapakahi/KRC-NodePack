"""Startup checks for KRC's database (KRC_SQLITE_GAMEPLAN.md, "Startup").

This module must not import sqlite3 at load time: ``require_sqlite`` is what tells the
user, clearly, that their Python has no sqlite3. Everything here is ASCII-only console
output with the ``[KRC DB]`` prefix.
"""

import os
import sys
from pathlib import Path

MIN_SQLITE = (3, 24, 0)  # UPSERT (INSERT ... ON CONFLICT DO UPDATE)

# Folder names that mean "synced by a cloud client": SQLite's locking isn't safe there.
_CLOUD_FOLDER_MARKERS = (
    "dropbox",
    "onedrive",
    "google drive",
    "googledrive",
    "my drive",
    "mobile documents",  # iCloud Drive on macOS (~/Library/Mobile Documents)
    "icloud drive",
    "icloudrive",
    "pcloud",
    "box sync",
    "nextcloud",
    "owncloud",
    "syncthing",
)
_NETWORK_FS_TYPES = {"nfs", "nfs4", "cifs", "smb", "smbfs", "smb3", "afpfs", "sshfs", "fuse.sshfs", "9p", "davfs", "fuse.rclone"}


class KrcDatabaseError(RuntimeError):
    """KRC can't use its database. The message is shown to the user as-is."""


def print_error_block(lines):
    """One clearly framed ASCII error block in the ComfyUI log."""
    bar = "[KRC DB] " + "=" * 70
    print(bar, file=sys.stderr)
    for line in lines:
        print(f"[KRC DB] {line}", file=sys.stderr)
    print(bar, file=sys.stderr)


def require_sqlite():
    """Fail clearly when this Python has no usable sqlite3 (decision D3: no fallback).
    Raises KrcDatabaseError after printing the explanation."""
    try:
        import sqlite3  # noqa: F401
    except ImportError as exc:
        lines = [
            "ERROR: this Python has no sqlite3 module.",
            "KRC NodePack keeps its data in a SQLite database and can't load without it.",
            f"Python: {sys.executable} ({sys.version.split()[0]})",
            "Fix: run ComfyUI with a Python that includes sqlite3 (the official python.org",
            "builds, ComfyUI's portable/embedded Python, conda and most Linux packages do).",
            "A self-built Python needs the SQLite development headers before building.",
            f"Details: {exc}",
        ]
        print_error_block(lines)
        raise KrcDatabaseError("This Python has no sqlite3 module; KRC NodePack can't load.") from exc
    if sqlite3.sqlite_version_info < MIN_SQLITE:
        need = ".".join(str(part) for part in MIN_SQLITE)
        lines = [
            f"ERROR: SQLite {sqlite3.sqlite_version} is too old; KRC NodePack needs {need} or newer.",
            f"Python: {sys.executable} ({sys.version.split()[0]})",
            "Fix: run ComfyUI with a newer Python (3.9 or later ships a recent SQLite).",
        ]
        print_error_block(lines)
        raise KrcDatabaseError(f"SQLite {sqlite3.sqlite_version} is too old (needs {need}).")


def has_fts5(conn):
    """Whether this SQLite build can do full-text search (FTS5)."""
    try:
        row = conn.execute("SELECT sqlite_compileoption_used('ENABLE_FTS5')").fetchone()
        if row and row[0]:
            return True
        conn.execute("CREATE VIRTUAL TABLE temp.krc_fts5_probe USING fts5(x)")
        conn.execute("DROP TABLE temp.krc_fts5_probe")
        return True
    except Exception:  # noqa: BLE001 - any failure means "no FTS5"
        return False


def _cloud_folder(path):
    lowered = [part.lower() for part in Path(path).parts]
    for part in lowered:
        for marker in _CLOUD_FOLDER_MARKERS:
            if marker in part:
                return part
    return ""


def _linux_mount_type(path):
    """The filesystem type of the mount holding `path` (Linux /proc/mounts), or ""."""
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as handle:
            mounts = [line.split()[:3] for line in handle if len(line.split()) >= 3]
    except OSError:
        return ""
    target = os.path.realpath(path)
    best, best_type = "", ""
    for _device, mount_point, fs_type in mounts:
        mount_point = mount_point.replace("\\040", " ")
        if (target == mount_point or target.startswith(mount_point.rstrip("/") + "/")) and len(mount_point) > len(best):
            best, best_type = mount_point, fs_type
    return best_type


def _windows_remote_drive(path):
    path = str(path)
    if path.startswith("\\\\"):
        return True
    try:
        import ctypes

        drive = os.path.splitdrive(os.path.abspath(path))[0]
        if not drive:
            return False
        DRIVE_REMOTE = 4
        return ctypes.windll.kernel32.GetDriveTypeW(drive + "\\") == DRIVE_REMOTE
    except Exception:  # noqa: BLE001
        return False


def location_warning(folder):
    """A one-line warning when `folder` (where krc.db lives) is on a network share or in a
    cloud-synced folder, where SQLite's file locking isn't reliable. "" when it looks local."""
    cloud = _cloud_folder(folder)
    if cloud:
        return (f"KRC's database is inside a cloud-synced folder ('{cloud}'). Syncing can lock or "
                "corrupt it; keep ComfyUI's user folder on a local disk.")
    if os.name == "nt":
        if _windows_remote_drive(folder):
            return ("KRC's database is on a network drive. SQLite's locking isn't reliable there; "
                    "keep ComfyUI's user folder on a local disk.")
        return ""
    fs_type = _linux_mount_type(folder) if sys.platform.startswith("linux") else ""
    if fs_type.lower() in _NETWORK_FS_TYPES:
        return (f"KRC's database is on a network filesystem ({fs_type}). SQLite's locking isn't "
                "reliable there; keep ComfyUI's user folder on a local disk.")
    return ""
