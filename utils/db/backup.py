"""Snapshots of krc.db (KRC_SQLITE_GAMEPLAN.md, "Backups").

A snapshot is a complete copy made with SQLite's online backup API, so it's consistent
even while KRC is writing. One is taken at startup when the newest is older than the
backup interval, and the same check runs at most hourly after writes while ComfyUI is up.
The newest few are kept in ``krc_nodes/backups/``. Replaces Prompt Vault's weekly copy.

The interval (12 / 24 / 48 / 72 hours) and how many to keep (3 / 7 / 14) are the user's,
from Options ▸ Support (settings rows ``backup.interval_hours`` / ``backup.keep``); a
lower keep trims the extras at the next backup. "Back up now" is ``take_snapshot("manual")``.
"""

import sqlite3
import threading
import time
from pathlib import Path

from . import connection as db
from . import schema

SNAPSHOT_DIRNAME = "backups"
SNAPSHOT_PREFIX = "krc-"
SNAPSHOT_SUFFIX = ".db"
INTERVAL_HOURS_CHOICES = (12, 24, 48, 72)
KEEP_CHOICES = (3, 7, 14)
DEFAULT_INTERVAL_HOURS = 24
DEFAULT_KEEP = 7
INTERVAL_KEY = "backup.interval_hours"
KEEP_KEY = "backup.keep"
CHECK_INTERVAL_S = 60 * 60

_lock = threading.Lock()
# Startup takes its own snapshot; the after-write check starts an hour later.
_last_check = time.monotonic()


def _setting(key, choices, default):
    try:
        value = db.get_setting(db.connection(), key, default)
    except Exception:  # noqa: BLE001 - before the database is ready: the default
        return default
    return value if value in choices else default


def settings():
    """-> {"intervalHours", "keep"} (unknown or missing values read as the defaults)."""
    return {
        "intervalHours": _setting(INTERVAL_KEY, INTERVAL_HOURS_CHOICES, DEFAULT_INTERVAL_HOURS),
        "keep": _setting(KEEP_KEY, KEEP_CHOICES, DEFAULT_KEEP),
    }


def set_settings(interval_hours=None, keep=None):
    """Store either or both; a value outside its choices is refused (ValueError). -> settings()."""
    if interval_hours is not None and interval_hours not in INTERVAL_HOURS_CHOICES:
        raise ValueError(f"interval must be one of {INTERVAL_HOURS_CHOICES} hours")
    if keep is not None and keep not in KEEP_CHOICES:
        raise ValueError(f"keep must be one of {KEEP_CHOICES}")
    before = settings()
    with db.write() as conn:
        if interval_hours is not None:
            db.set_setting(conn, INTERVAL_KEY, interval_hours)
        if keep is not None:
            db.set_setting(conn, KEEP_KEY, keep)
    after = settings()
    if after != before:
        print(f"[KRC DB] backups: every {after['intervalHours']} h, keep {after['keep']}")
    return after


def interval_s():
    return settings()["intervalHours"] * 60 * 60


def snapshot_dir():
    return db.db_path().parent / SNAPSHOT_DIRNAME


def list_snapshots():
    """Snapshot files, newest first."""
    folder = snapshot_dir()
    if not folder.is_dir():
        return []
    files = [p for p in folder.glob(f"{SNAPSHOT_PREFIX}*{SNAPSHOT_SUFFIX}") if p.is_file()]
    return sorted(files, key=lambda p: p.name, reverse=True)


def _new_snapshot_path(folder):
    """krc-YYYYMMDD-HHMMSS-mmm.db, never an existing name (two snapshots in one
    millisecond, e.g. "before restore" right after another, get the next free one)."""
    now = time.time()
    millis = int(now * 1000) % 1000
    while True:
        stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime(now))
        target = folder / f"{SNAPSHOT_PREFIX}{stamp}-{millis:03d}{SNAPSHOT_SUFFIX}"
        if not target.exists():
            return target
        millis += 1
        if millis > 999:
            millis = 0
            now += 1


def take_snapshot(reason="", protect=""):
    """Write a new snapshot now and prune old ones (never the one named `protect`).
    -> its Path, or None on failure."""
    with _lock:
        folder = snapshot_dir()
        try:
            folder.mkdir(parents=True, exist_ok=True)
            target = _new_snapshot_path(folder)
            tmp = target.with_suffix(".tmp")
            source = db.connection()
            dest = sqlite3.connect(str(tmp))
            try:
                source.backup(dest)
            finally:
                dest.close()
            tmp.replace(target)
        except Exception as exc:  # noqa: BLE001 - a failed snapshot never breaks KRC
            print(f"[KRC DB] snapshot failed: {exc}")
            return None
        for old in list_snapshots()[settings()["keep"]:]:
            if old.name == protect:
                continue
            try:
                old.unlink()
            except OSError:
                pass
        suffix = f" ({reason})" if reason else ""
        print(f"[KRC DB] snapshot saved: {target.name}{suffix}")
        return target


def newest_snapshot_age_s():
    snapshots = list_snapshots()
    if not snapshots:
        return None
    try:
        return max(0.0, time.time() - snapshots[0].stat().st_mtime)
    except OSError:
        return None


def snapshot_if_due(reason="scheduled"):
    age = newest_snapshot_age_s()
    if age is None or age >= interval_s():
        return take_snapshot(reason)
    return None


def maybe_snapshot_later():
    """Called after each write: at most hourly, take the scheduled snapshot if it's due."""
    global _last_check
    now = time.monotonic()
    if now - _last_check < CHECK_INTERVAL_S:
        return
    _last_check = now
    snapshot_if_due()


def snapshot_info():
    snapshots = list_snapshots()
    newest = None
    if snapshots:
        try:
            newest = int(snapshots[0].stat().st_mtime * 1000)
        except OSError:
            newest = None
    return {"folder": str(snapshot_dir()), "count": len(snapshots), "newestMs": newest,
            "newest": snapshots[0].name if snapshots else ""}


def restore_hint():
    snapshots = list_snapshots()
    if not snapshots:
        return "No snapshot exists yet."
    path = Path(snapshots[0])
    return (f"The newest snapshot is {path}. To restore it: stop ComfyUI, move krc.db (and any "
            f"krc.db-wal / krc.db-shm next to it) aside, copy the snapshot to {db.db_path()}, "
            "then start ComfyUI.")


# ---- restore --------------------------------------------------------------------------------
#
# Restore copies tables back from a snapshot into the live krc.db (ATTACH, then one
# transaction), so ComfyUI keeps running. "all" restores every table; an area only its own
# rows. The current state is snapshotted first ("before restore"), so a restore can itself be
# undone. Open browser pages keep what they showed until they reload.

# area -> [(table, WHERE clause or None)]
RESTORE_AREAS = {
    "prompts": [
        ("prompt_profiles", None),
        ("prompt_categories", None),
        ("prompts", None),
        ("usage", "domain = 'prompts'"),
    ],
    "presets": [
        ("presets", None),
    ],
    "word_banks": [
        ("word_banks", None),
    ],
    "library": [
        ("item_metadata", None),
        ("identity_aliases", None),
        ("identity_files", None),
        ("collections", None),
        ("transfer_history", None),
        ("civitai_cache", None),
        ("usage", "domain IN ('loras', 'models')"),
        ("folder_colors", None),
        ("settings", "key LIKE 'folder_colors.%'"),
    ],
    # The Media catalog and media presets; the media files themselves stay on disk.
    "media": [
        ("media_items", None),
        ("media_folders", None),
        ("presets", "kind = 'media'"),
    ],
}
# "all": every table, settings included (the import markers, the network and video
# settings, the batch's last run). Needs a snapshot from the same schema version.
_ALL_TABLES = [
    "settings", "prompt_profiles", "prompt_categories", "prompts", "usage", "presets", "folder_colors", "item_metadata",
    "identity_aliases", "identity_files", "collections", "transfer_history", "civitai_cache", "word_banks",
    "media_items", "media_folders",
]
# The `changes` stores a restore touches, so caches keyed on a revision reload.
_AREA_STORES = {
    "prompts": ["prompt_profiles", "prompts", "usage"],
    "presets": ["presets:ll", "presets:cs", "presets:wb"],
    "word_banks": ["word_banks"],
    "library": ["metadata:loras", "metadata:models", "identity:loras", "identity:models", "collections",
                "transfer_history", "civitai_cache", "usage", "folder_colors"],
    "media": ["media", "presets:media"],
}


class RestoreError(ValueError):
    """A restore that can't run; the message is shown to the user."""


def _snapshot_path(name):
    for path in list_snapshots():
        if path.name == name:
            return path
    raise RestoreError("That snapshot doesn't exist any more.")


def restore(name, area):
    """Restore `area` ("all" / "prompts" / "presets" / "word_banks" / "library" / "media") from snapshot `name`.
    -> {"area", "snapshot", "rows", "safety"} (safety = the "before restore" snapshot)."""
    if area != "all" and area not in RESTORE_AREAS:
        raise RestoreError(f"Unknown area: {area}")
    source = _snapshot_path(name)
    tables = [(table, None) for table in _ALL_TABLES] if area == "all" else RESTORE_AREAS[area]
    conn = db.connection()
    if conn.in_transaction:
        raise RestoreError("A write is in progress; try again.")
    conn.execute("ATTACH DATABASE ? AS snap", (str(source),))
    try:
        version = conn.execute("PRAGMA snap.user_version").fetchone()[0]
        present = {row[0] for row in conn.execute("SELECT name FROM snap.sqlite_master WHERE type = 'table'")}
        if area == "all" and version != schema.SCHEMA_VERSION:
            raise RestoreError(
                f"This snapshot is from an older krc.db (schema {version}, now {schema.SCHEMA_VERSION}), so it "
                "can't restore everything at once. Restore an area instead, or restore the file by hand.")
        missing = sorted({table for table, _where in tables if table not in present})
        if missing:
            raise RestoreError(
                f"This snapshot is older than that data (it has no {', '.join(missing)}); pick a newer one.")
        for table, _where in tables:
            current = [tuple(row[1:3]) for row in conn.execute(f"PRAGMA main.table_info({table})")]
            saved = [tuple(row[1:3]) for row in conn.execute(f"PRAGMA snap.table_info({table})")]
            if current != saved:
                raise RestoreError(f"This snapshot uses an older schema for {table}; pick a newer one or restore the file by hand.")
        safety = take_snapshot("before restore", protect=name)
        if safety is None:
            raise RestoreError("Couldn't save the current state first, so nothing was restored.")
        rows = 0
        with db.write():
            # Remove children before parents, then restore parents before children.
            # The former interleaving could delete newly restored child rows through
            # cascades, and profiles add a parent shared by all prompt categories.
            for table, where in reversed(tables):
                clause = f" WHERE {where}" if where else ""
                conn.execute(f"DELETE FROM main.{table}{clause}")
            for table, where in tables:
                clause = f" WHERE {where}" if where else ""
                rows += conn.execute(f"INSERT INTO main.{table} SELECT * FROM snap.{table}{clause}").rowcount
            stores = sorted({store for stores in _AREA_STORES.values() for store in stores}) if area == "all" \
                else _AREA_STORES[area]
            for store in stores:
                db.note_change(conn, store, "", "restore", name)
            if area in ("all", "presets"):
                for (kind,) in conn.execute("SELECT DISTINCT kind FROM presets WHERE kind LIKE 'kit:%'").fetchall():
                    db.note_change(conn, f"presets:{kind}", "", "restore", name)
    finally:
        conn.execute("DETACH DATABASE snap")
    print(f"[KRC DB] restored {area} from {name} ({rows} rows); the previous state is in {safety.name}")
    return {"area": area, "snapshot": name, "rows": rows, "safety": safety.name}
