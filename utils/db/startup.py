"""KRC database startup: run from the pack's __init__ before any node or route loads.

``initialize()`` opens krc.db (schema migrations + one-time JSON imports happen there),
checks its integrity, warns about risky locations, takes the daily snapshot, and logs
one status line. Any failure prints a clear ASCII block and raises KrcDatabaseError, so
ComfyUI reports the pack as failed to load instead of running it half-working.
"""

import sqlite3

from . import backup, schema
from . import connection as db
from .check import KrcDatabaseError, has_fts5, location_warning, print_error_block

_STATUS = {}


def initialize():
    global _STATUS
    path = db.db_path()
    try:
        conn = db.connection()
        result = conn.execute("PRAGMA quick_check").fetchone()
        if not result or result[0] != "ok":
            raise KrcDatabaseError(
                f"krc.db failed its integrity check ({result[0] if result else 'no result'}). "
                + backup.restore_hint())
    except KrcDatabaseError as exc:
        print_error_block([f"ERROR: {exc}", f"Database: {path}", "KRC NodePack did not load."])
        raise
    except sqlite3.Error as exc:
        print_error_block([
            f"ERROR: krc.db could not be opened: {exc}",
            f"Database: {path}",
            backup.restore_hint(),
            "KRC NodePack did not load.",
        ])
        raise KrcDatabaseError(f"krc.db could not be opened: {exc}") from exc

    fts5 = has_fts5(conn)
    warning = location_warning(path.parent)
    if warning:
        print(f"[KRC DB] WARNING: {warning}")
    if not fts5:
        print("[KRC DB] note: this SQLite has no full-text search (FTS5); searches will use plain matching.")
    from . import importers

    if importers.migrated_this_start:
        backup.take_snapshot("after moving data into krc.db")
    else:
        backup.snapshot_if_due("startup")
    _STATUS = {
        "path": str(path),
        "sqliteVersion": sqlite3.sqlite_version,
        "schemaVersion": schema.current_version(conn),
        "fts5": fts5,
        "warning": warning,
    }
    print(f"[KRC DB] ready: {path.name}, SQLite {sqlite3.sqlite_version}, schema {_STATUS['schemaVersion']}"
          f", FTS5 {'yes' if fts5 else 'no'}")
    return dict(_STATUS)


def status():
    """What the Options page shows: the database, SQLite, migrations, snapshots."""
    out = dict(_STATUS) if _STATUS else {"path": str(db.db_path()), "sqliteVersion": sqlite3.sqlite_version}
    try:
        conn = db.connection()
        rows = conn.execute("SELECT key, value FROM settings WHERE key LIKE 'migrated.%'").fetchall()
        out["migrated"] = {key.split(".", 1)[1]: db.get_setting(conn, key) for key, _value in rows}
    except Exception as exc:  # noqa: BLE001
        out["error"] = str(exc)
    out["snapshots"] = backup.snapshot_info()
    return out


_ROUTES_REGISTERED = False


def register_db_routes():
    """GET /krc/db/status, GET /krc/db/snapshots, POST /krc/db/restore {snapshot, area}."""
    global _ROUTES_REGISTERED
    try:
        from server import PromptServer
    except Exception:  # noqa: BLE001 - outside ComfyUI
        return
    if _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True
    from aiohttp import web

    @PromptServer.instance.routes.get("/krc/db/status")
    async def _krc_db_status(_request):
        return web.json_response(status())

    @PromptServer.instance.routes.get("/krc/db/summary")
    async def _krc_db_summary(_request):
        """The Stats page's "Your KRC" counts (utils/db/summary.py)."""
        from . import summary as db_summary

        try:
            return web.json_response(db_summary.summary(), headers={"Cache-Control": "no-store"})
        except Exception as exc:  # noqa: BLE001
            print(f"[KRC DB] summary failed: {exc}")
            return web.json_response({"error": str(exc)}, status=500)

    @PromptServer.instance.routes.get("/krc/db/snapshots")
    async def _krc_db_snapshots(_request):
        snapshots = []
        for path in backup.list_snapshots():
            try:
                stat = path.stat()
            except OSError:
                continue
            snapshots.append({"name": path.name, "sizeBytes": stat.st_size, "mtimeMs": int(stat.st_mtime * 1000)})
        return web.json_response({"snapshots": snapshots, "areas": ["all", *backup.RESTORE_AREAS]})

    def _backup_settings_answer():
        return {**backup.settings(), "intervalChoices": list(backup.INTERVAL_HOURS_CHOICES),
                "keepChoices": list(backup.KEEP_CHOICES)}

    @PromptServer.instance.routes.get("/krc/db/backup-settings")
    async def _krc_db_backup_settings(_request):
        return web.json_response(_backup_settings_answer(), headers={"Cache-Control": "no-store"})

    @PromptServer.instance.routes.post("/krc/db/backup-settings")
    async def _krc_db_set_backup_settings(request):
        """{intervalHours?, keep?}: either or both; a value outside its choices is 400."""
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        payload = payload if isinstance(payload, dict) else {}
        try:
            backup.set_settings(payload.get("intervalHours"), payload.get("keep"))
        except ValueError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        return web.json_response({"ok": True, **_backup_settings_answer()})

    @PromptServer.instance.routes.post("/krc/db/backup-now")
    async def _krc_db_backup_now(_request):
        """Options ▸ Support ▸ Back up now: a snapshot right away (old ones pruned to keep)."""
        path = backup.take_snapshot("manual")
        if path is None:
            return web.json_response({"ok": False, "error": "The backup failed; the ComfyUI log says why."}, status=500)
        return web.json_response({"ok": True, "name": path.name})

    @PromptServer.instance.routes.post("/krc/db/restore")
    async def _krc_db_restore(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            payload = {}
        try:
            result = backup.restore(str(payload.get("snapshot") or ""), str(payload.get("area") or ""))
        except backup.RestoreError as exc:
            return web.json_response({"ok": False, "error": str(exc)}, status=400)
        except Exception as exc:  # noqa: BLE001
            print(f"[KRC DB] restore failed: {exc}")
            return web.json_response({"ok": False, "error": f"Restore failed: {exc}"}, status=500)
        return web.json_response({"ok": True, **result})
