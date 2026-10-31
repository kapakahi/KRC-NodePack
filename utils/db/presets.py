"""Preset records in krc.db, shared by every KRC preset store (KRC_SQLITE_GAMEPLAN.md
stage 2).

The stores (LoRA Loadout, Config Switcher, Word Bank, each Loadout Kit) keep their own
load / save / upsert / rename / delete code and normalization. Underneath, their whole
"file" is the rows of one ``kind`` in the ``presets`` table: ``load_records`` returns them
and ``save_records`` stores a whole list, writing only the presets that changed (by id),
in one transaction.
"""

import json

from . import connection as db

LORA_LOADOUT = "ll"
CONFIG_SWITCHER = "cs"
WORD_BANK = "wb"


def kit_kind(kit_id):
    return f"kit:{kit_id}"


def change_store(kind):
    """The ``changes`` store name for one preset kind."""
    return f"presets:{kind}"


def load_records(kind):
    """The stored preset records of one kind, in the order they were first saved."""
    conn = db.connection()
    rows = conn.execute("SELECT record FROM presets WHERE kind = ? ORDER BY rowid", (kind,)).fetchall()
    out = []
    for (record,) in rows:
        try:
            value = json.loads(record)
        except ValueError:
            continue
        if isinstance(value, dict):
            out.append(value)
    return out


def save_records(kind, records, source=""):
    """Store `records` as the whole set for `kind`: presets whose id is gone are deleted,
    new or changed ones written, unchanged ones left alone. Records without an id are
    skipped (the stores always assign one). -> rows changed."""
    wanted = {}
    for record in records or []:
        if isinstance(record, dict) and str(record.get("id") or "").strip():
            wanted[str(record["id"])] = json.dumps(record, ensure_ascii=False)
    with db.write() as conn:
        current = dict(conn.execute("SELECT id, record FROM presets WHERE kind = ?", (kind,)).fetchall())
        changed = 0
        for preset_id in current.keys() - wanted.keys():
            conn.execute("DELETE FROM presets WHERE kind = ? AND id = ?", (kind, preset_id))
            db.note_change(conn, change_store(kind), preset_id, "delete", source)
            changed += 1
        for preset_id, record in wanted.items():
            if current.get(preset_id) == record:
                continue
            conn.execute(
                "INSERT INTO presets (kind, id, record) VALUES (?, ?, ?) "
                "ON CONFLICT (kind, id) DO UPDATE SET record = excluded.record",
                (kind, preset_id, record),
            )
            db.note_change(conn, change_store(kind), preset_id, "save", source)
            changed += 1
    return changed


def count_records(kind):
    row = db.connection().execute("SELECT COUNT(*) FROM presets WHERE kind = ?", (kind,)).fetchone()
    return int(row[0] or 0)


# ---- folder colours + pins -----------------------------------------------------------------

def _folder_modified_key(lineage):
    return f"folder_colors.{lineage}.modified"


def folder_colors_saved(lineage):
    """Whether this lineage's folder colours were ever saved (vs. first-run defaults)."""
    return db.get_setting(db.connection(), _folder_modified_key(lineage)) is not None


def load_folder_colors(lineage):
    """-> {"folders": {folder: color}, "pinned": [folder, ...], "modified": int}."""
    conn = db.connection()
    folders = {}
    pinned = []
    for folder, color, pin_order in conn.execute(
        "SELECT folder, color, pin_order FROM folder_colors WHERE lineage = ? ORDER BY rowid", (lineage,)
    ):
        if color:
            folders[folder] = color
        if pin_order is not None:
            pinned.append((pin_order, folder))
    return {
        "folders": folders,
        "pinned": [folder for _order, folder in sorted(pinned)],
        "modified": int(db.get_setting(conn, _folder_modified_key(lineage), 0) or 0),
    }


def save_folder_colors(lineage, payload, source=""):
    """Store a whole {"folders", "pinned", "modified"} payload for `lineage`."""
    folders = payload.get("folders") if isinstance(payload.get("folders"), dict) else {}
    pinned = [str(folder) for folder in payload.get("pinned") or [] if folder]
    rows = {}
    for folder, color in folders.items():
        rows[str(folder)] = [str(color), None]
    for order, folder in enumerate(pinned):
        rows.setdefault(folder, [None, None])[1] = order
    with db.write() as conn:
        conn.execute("DELETE FROM folder_colors WHERE lineage = ?", (lineage,))
        conn.executemany(
            "INSERT INTO folder_colors (lineage, folder, color, pin_order) VALUES (?, ?, ?, ?)",
            [(lineage, folder, color, order) for folder, (color, order) in rows.items()],
        )
        db.set_setting(conn, _folder_modified_key(lineage), int(payload.get("modified") or 0))
        db.note_change(conn, "folder_colors", lineage, "save", source)
    return payload
