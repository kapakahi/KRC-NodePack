"""The krc.db connection: one per thread, WAL, foreign keys on.

ComfyUI touches storage from its aiohttp loop thread and its node-execution thread, so
every thread gets its own connection (``threading.local``). Writes go through
``write()`` (``BEGIN IMMEDIATE`` ... commit / rollback), which also records a row in
``changes`` via ``note_change``. Reads that need a consistent view use ``read()``.

The first connection to a database file runs the schema migrations and the one-time
JSON importers (``importers.run_pending``) before anything else can use it.
"""

import functools
import json
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path

from .. import krc_paths
from . import schema

DB_FILENAME = "krc.db"
BUSY_TIMEOUT_MS = 5000
CHANGES_KEEP = 5000

_local = threading.local()
_lock = threading.RLock()
_ready_paths = set()
_override_path = None
_generation = 0
_writes_since_prune = 0


def db_path():
    """Where krc.db lives: the KRC user folder (``.../user/default/krc_nodes``)."""
    if _override_path is not None:
        return Path(_override_path)
    return Path(krc_paths.get_krc_nodes_dir()) / DB_FILENAME


def use_database(path):
    """Point every thread at another database file (tests, restore). None = the default.
    Open connections are dropped; the next use opens (and prepares) the new file."""
    global _override_path, _generation
    with _lock:
        _override_path = str(path) if path is not None else None
        _generation += 1
        _ready_paths.discard(str(db_path()))
    close_thread_connection()


def generation():
    """Bumped whenever the database file is switched (use_database), for caches."""
    return _generation


def close_thread_connection():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:  # noqa: BLE001
            pass
    _local.conn = None
    _local.path = None


def _open(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=BUSY_TIMEOUT_MS / 1000, isolation_level=None,
                           check_same_thread=True)
    conn.execute(f"PRAGMA busy_timeout = {BUSY_TIMEOUT_MS}")
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    return conn


def connection():
    """This thread's connection to krc.db, opened (and the file prepared) on first use."""
    path = db_path()
    key = str(path)
    conn = getattr(_local, "conn", None)
    if conn is not None and getattr(_local, "path", None) == key and getattr(_local, "generation", None) == _generation:
        return conn
    close_thread_connection()
    with _lock:
        conn = _open(path)
        # Installed before preparing, so an importer on this thread can use the normal
        # store code (connection() / write()) and gets this same connection back.
        _local.conn = conn
        _local.path = key
        _local.generation = _generation
        if key not in _ready_paths:
            try:
                _prepare(conn)
            except Exception:
                close_thread_connection()
                raise
            _ready_paths.add(key)
    return conn


def _prepare(conn):
    """Once per process per file: schema migrations, then pending JSON imports."""
    applied = schema.migrate(conn)
    if applied:
        print(f"[KRC DB] schema version {schema.SCHEMA_VERSION} ({db_path()})")
    from . import importers

    importers.run_pending(conn)


@contextmanager
def write():
    """A write transaction (``BEGIN IMMEDIATE``). Nested use joins the outer transaction."""
    global _writes_since_prune
    conn = connection()
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
        conn.execute("COMMIT")
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    _writes_since_prune += 1
    if _writes_since_prune >= 500:
        _writes_since_prune = 0
        _prune_changes(conn)
    from . import backup

    backup.maybe_snapshot_later()


def atomic(method):
    """Run ``method`` (a store's read-modify-save: load, change, save) as one write
    transaction, so a write from another thread (a bundle import, run-time healing)
    can't land between its read and its save and be lost. Joins an outer transaction."""
    @functools.wraps(method)
    def run(*args, **kwargs):
        with write():
            return method(*args, **kwargs)
    return run


@contextmanager
def read():
    """A consistent read (one snapshot for every statement inside)."""
    conn = connection()
    if conn.in_transaction:
        yield conn
        return
    conn.execute("BEGIN")
    try:
        yield conn
    finally:
        conn.execute("COMMIT")


def now_ms():
    return int(time.time() * 1000)


def note_change(conn, store, item_id="", op="", source=""):
    """Record one write in ``changes`` (call inside the write's transaction)."""
    conn.execute(
        "INSERT INTO changes (store, item_id, op, source, at_ms) VALUES (?, ?, ?, ?, ?)",
        (store, str(item_id or ""), op, source or "", now_ms()),
    )


def revision(store, conn=None):
    """The store's newest change number (0 when it never changed)."""
    conn = conn or connection()
    row = conn.execute("SELECT MAX(rev) FROM changes WHERE store = ?", (store,)).fetchone()
    return int(row[0] or 0)


def _prune_changes(conn):
    """Keep the newest CHANGES_KEEP rows, plus each store's newest one (its revision)."""
    try:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute(
            "DELETE FROM changes WHERE rev <= (SELECT MAX(rev) FROM changes) - ? "
            "AND rev NOT IN (SELECT MAX(rev) FROM changes GROUP BY store)",
            (CHANGES_KEEP,),
        )
        conn.execute("COMMIT")
    except Exception:  # noqa: BLE001 - pruning is housekeeping, never fatal
        if conn.in_transaction:
            conn.execute("ROLLBACK")


def get_setting(conn, key, default=None):
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    if row is None or row[0] is None:
        return default
    try:
        return json.loads(row[0])
    except ValueError:
        return default


def set_setting(conn, key, value):
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value, ensure_ascii=False)),
    )
