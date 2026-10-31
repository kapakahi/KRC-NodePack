"""The Stats page's "Your KRC" section: what krc.db holds, at a glance. Read-only counts
(GET /krc/db/summary), no record content.
"""

from . import backup
from . import connection as db

KIND_LABELS = {"ll": "LoRA Loadout", "cs": "Config Switcher", "wb": "Word Bank"}


def _kit_labels():
    try:
        from ..loadout_kit.kit import all_kits
    except Exception:  # noqa: BLE001 - kits not loaded (static checks)
        return {}
    return {f"kit:{kit_id}": kit.label or kit_id for kit_id, kit in all_kits().items()}


def _count(conn, sql, params=()):
    row = conn.execute(sql, params).fetchone()
    return int(row[0] or 0) if row else 0


def database_bytes():
    """krc.db plus its -wal file (recent writes live there until a checkpoint)."""
    total = 0
    path = db.db_path()
    for candidate in (path, path.with_name(path.name + "-wal")):
        try:
            total += candidate.stat().st_size
        except OSError:
            pass
    return total


def summary():
    """-> {"prompts", "promptCategories", "presets": [{"kind", "label", "count"}],
    "wordBanks", "collections", "databaseBytes", "backups": {...snapshot_info, "intervalHours", "keep"}}."""
    labels = {**KIND_LABELS, **_kit_labels()}
    with db.read() as conn:
        presets = [
            {"kind": kind, "label": labels.get(kind, kind.split(":", 1)[-1]), "count": int(count)}
            for kind, count in conn.execute("SELECT kind, COUNT(*) FROM presets GROUP BY kind ORDER BY kind")
        ]
        out = {
            "prompts": _count(conn, "SELECT COUNT(*) FROM prompts"),
            "promptProfiles": _count(conn, "SELECT COUNT(*) FROM prompt_profiles"),
            "promptCategories": _count(conn, "SELECT COUNT(*) FROM prompt_categories"),
            "presets": presets,
            "wordBanks": _count(conn, "SELECT COUNT(*) FROM word_banks"),
            "collections": _count(conn, "SELECT COUNT(*) FROM collections"),
        }
    order = list(KIND_LABELS)
    out["presets"].sort(key=lambda row: (order.index(row["kind"]) if row["kind"] in order else len(order), row["label"].lower()))
    out["databaseBytes"] = database_bytes()
    out["backups"] = {**backup.snapshot_info(), **backup.settings()}
    return out
