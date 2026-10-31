"""Library data in krc.db (KRC_SQLITE_GAMEPLAN.md stage 3): per-item metadata, identity,
Collections, transfer history, the Civitai cache, usage for LoRAs / models, and small
"documents" (a whole JSON value under one settings key).

The stores (``utils/lora_loadout/metadata.py``, ``utils/model_library/metadata.py``,
``utils/library/identity.py``, ``collections.py``, ``transfer_history.py``,
``civitai_cache.py``, ``usage_stats.py``, ...) keep their APIs; these helpers replace
their file reads and writes. Records are stored verbatim (the JSON the file held).
"""

import json

from . import connection as db

LORAS = "loras"
MODELS = "models"


def _loads(text, default=None):
    try:
        value = json.loads(text)
    except (TypeError, ValueError):
        return default
    return value


def _dumps(value):
    return json.dumps(value, ensure_ascii=False)


# ---- per-item metadata ---------------------------------------------------------------------

def metadata_get(lineage, type_dir, item_id):
    """The stored record (a dict), or None."""
    row = db.connection().execute(
        "SELECT record FROM item_metadata WHERE lineage = ? AND type_dir = ? AND id = ?",
        (lineage, type_dir, item_id),
    ).fetchone()
    if row is None:
        return None
    value = _loads(row[0])
    return value if isinstance(value, dict) else {}


def metadata_exists(lineage, type_dir, item_id):
    return db.connection().execute(
        "SELECT 1 FROM item_metadata WHERE lineage = ? AND type_dir = ? AND id = ?",
        (lineage, type_dir, item_id),
    ).fetchone() is not None


def metadata_put(lineage, type_dir, item_id, record, source=""):
    text = _dumps(record)
    with db.write() as conn:
        row = conn.execute(
            "SELECT record FROM item_metadata WHERE lineage = ? AND type_dir = ? AND id = ?",
            (lineage, type_dir, item_id),
        ).fetchone()
        if row is not None and row[0] == text:
            return
        conn.execute(
            "INSERT INTO item_metadata (lineage, type_dir, id, record) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (lineage, type_dir, id) DO UPDATE SET record = excluded.record",
            (lineage, type_dir, item_id, text),
        )
        db.note_change(conn, f"metadata:{lineage}", item_id, "save", source)


def metadata_delete(lineage, item_id, type_dir=None, keep_type_dir=None):
    """Delete an item's record: in one type dir, in every one (type_dir None), or in every
    one but `keep_type_dir`. -> rows deleted."""
    sql = "DELETE FROM item_metadata WHERE lineage = ? AND id = ?"
    params = [lineage, item_id]
    if type_dir is not None:
        sql += " AND type_dir = ?"
        params.append(type_dir)
    if keep_type_dir is not None:
        sql += " AND type_dir != ?"
        params.append(keep_type_dir)
    with db.write() as conn:
        deleted = conn.execute(sql, params).rowcount
        if deleted:
            db.note_change(conn, f"metadata:{lineage}", item_id, "delete")
    return deleted


def metadata_copy(lineage, type_dir, old_id, new_id):
    """Copy old_id's record to new_id when new_id has none (identity adoption)."""
    with db.write() as conn:
        if conn.execute(
            "SELECT 1 FROM item_metadata WHERE lineage = ? AND type_dir = ? AND id = ?",
            (lineage, type_dir, new_id),
        ).fetchone():
            return False
        copied = conn.execute(
            "INSERT INTO item_metadata (lineage, type_dir, id, record) "
            "SELECT lineage, type_dir, ?, record FROM item_metadata WHERE lineage = ? AND type_dir = ? AND id = ?",
            (new_id, lineage, type_dir, old_id),
        ).rowcount
        if copied:
            db.note_change(conn, f"metadata:{lineage}", new_id, "copy")
    return bool(copied)


def metadata_type_dirs(lineage, item_id=None):
    """Type dirs holding records (all, or one item's), sorted."""
    if item_id is None:
        rows = db.connection().execute(
            "SELECT DISTINCT type_dir FROM item_metadata WHERE lineage = ? ORDER BY type_dir", (lineage,))
    else:
        rows = db.connection().execute(
            "SELECT type_dir FROM item_metadata WHERE lineage = ? AND id = ? ORDER BY type_dir", (lineage, item_id))
    return [row[0] for row in rows]


def metadata_ids(lineage):
    return {row[0] for row in db.connection().execute(
        "SELECT DISTINCT id FROM item_metadata WHERE lineage = ?", (lineage,))}


def metadata_iter(lineage):
    """(type_dir, id, record) for every stored record, sorted like the old file walk."""
    rows = db.connection().execute(
        "SELECT type_dir, id, record FROM item_metadata WHERE lineage = ? ORDER BY type_dir, id", (lineage,)
    ).fetchall()
    for type_dir, item_id, record in rows:
        value = _loads(record)
        if isinstance(value, dict):
            yield type_dir, item_id, value


# ---- identity -------------------------------------------------------------------------------

def identity_load(lineage):
    """-> (aliases {legacy: canonical}, files {relativePath: entry})."""
    with db.read() as conn:
        aliases = dict(conn.execute(
            "SELECT legacy_id, canonical_id FROM identity_aliases WHERE lineage = ? ORDER BY rowid", (lineage,)))
        files = {}
        for relative_path, entry in conn.execute(
            "SELECT relative_path, entry FROM identity_files WHERE lineage = ? ORDER BY rowid", (lineage,)
        ):
            value = _loads(entry)
            if isinstance(value, dict):
                files[relative_path] = value
    return aliases, files


def identity_apply(lineage, alias_sets, alias_deletes, file_sets, file_deletes, source=""):
    """Write identity changes (only what changed) in one transaction."""
    if not (alias_sets or alias_deletes or file_sets or file_deletes):
        return
    with db.write() as conn:
        conn.executemany("DELETE FROM identity_aliases WHERE lineage = ? AND legacy_id = ?",
                         [(lineage, key) for key in alias_deletes])
        conn.executemany(
            "INSERT INTO identity_aliases (lineage, legacy_id, canonical_id) VALUES (?, ?, ?) "
            "ON CONFLICT (lineage, legacy_id) DO UPDATE SET canonical_id = excluded.canonical_id",
            [(lineage, key, value) for key, value in alias_sets.items()])
        conn.executemany("DELETE FROM identity_files WHERE lineage = ? AND relative_path = ?",
                         [(lineage, key) for key in file_deletes])
        conn.executemany(
            "INSERT INTO identity_files (lineage, relative_path, entry) VALUES (?, ?, ?) "
            "ON CONFLICT (lineage, relative_path) DO UPDATE SET entry = excluded.entry",
            [(lineage, key, _dumps(value)) for key, value in file_sets.items()])
        db.note_change(conn, f"identity:{lineage}", "", "save", source)


def diff_maps(base, current):
    """-> (sets, deletes) turning `base` into `current` (values compared as JSON)."""
    sets = {key: value for key, value in current.items()
            if key not in base or _dumps(base[key]) != _dumps(value)}
    deletes = [key for key in base if key not in current]
    return sets, deletes


# ---- collections ----------------------------------------------------------------------------

def collections_load():
    rows = db.connection().execute("SELECT id, record FROM collections ORDER BY rowid").fetchall()
    out = {}
    for collection_id, record in rows:
        value = _loads(record)
        if isinstance(value, dict):
            out[collection_id] = value
    return out


def collections_apply(sets, deletes, source=""):
    if not (sets or deletes):
        return
    with db.write() as conn:
        conn.executemany("DELETE FROM collections WHERE id = ?", [(key,) for key in deletes])
        conn.executemany(
            "INSERT INTO collections (id, record) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET record = excluded.record",
            [(key, _dumps(value)) for key, value in sets.items()])
        # One change per collection, so the change log says which ones (stage 15).
        for key in deletes:
            db.note_change(conn, "collections", key, "delete", source)
        for key in sets:
            db.note_change(conn, "collections", key, "save", source)


# ---- transfer history -----------------------------------------------------------------------

def history_load():
    out = {}
    for key, entry in db.connection().execute("SELECT key, entry FROM transfer_history ORDER BY rowid"):
        value = _loads(entry)
        if isinstance(value, dict):
            out[key] = value
    return out


def history_put(key, entry):
    with db.write() as conn:
        conn.execute(
            "INSERT INTO transfer_history (key, entry) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET entry = excluded.entry",
            (key, _dumps(entry)))
        db.note_change(conn, "transfer_history", key, "save")


# ---- Civitai cache --------------------------------------------------------------------------

def civitai_get(sha256):
    row = db.connection().execute("SELECT envelope FROM civitai_cache WHERE sha256 = ?", (sha256,)).fetchone()
    value = _loads(row[0]) if row else None
    return value if isinstance(value, dict) else None


def civitai_put(sha256, envelope):
    with db.write() as conn:
        conn.execute(
            "INSERT INTO civitai_cache (sha256, status, fetched_ms, envelope) VALUES (?, ?, ?, ?) "
            "ON CONFLICT (sha256) DO UPDATE SET status = excluded.status, fetched_ms = excluded.fetched_ms, "
            "envelope = excluded.envelope",
            (sha256, str(envelope.get("status") or ""), int(envelope.get("fetchedAt") or 0), _dumps(envelope)))
        db.note_change(conn, "civitai_cache", sha256, "save")


def civitai_ids():
    return {row[0] for row in db.connection().execute("SELECT sha256 FROM civitai_cache")}


def civitai_not_found():
    """{sha: fetchedAt ms} for every not_found sentinel."""
    return {sha: int(fetched or 0) for sha, fetched in db.connection().execute(
        "SELECT sha256, fetched_ms FROM civitai_cache WHERE status = 'not_found'")}


def civitai_not_found_at(sha256):
    row = db.connection().execute(
        "SELECT fetched_ms FROM civitai_cache WHERE sha256 = ? AND status = 'not_found'", (sha256,)).fetchone()
    return int(row[0] or 0) if row else 0


# ---- usage (LoRAs / models: keyed by library id) ---------------------------------------------

def usage_load(domain):
    return {item_id: {"count": count, "lastUsedMs": last} for item_id, count, last in db.connection().execute(
        "SELECT item_id, count, last_used_ms FROM usage WHERE domain = ? ORDER BY rowid", (domain,))}


def usage_bump(domain, ids, now):
    out = {}
    with db.write() as conn:
        for item_id in ids:
            conn.execute(
                "INSERT INTO usage (domain, item_id, count, last_used_ms) VALUES (?, ?, 1, ?) "
                "ON CONFLICT (domain, item_id) DO UPDATE SET count = count + 1, last_used_ms = excluded.last_used_ms",
                (domain, item_id, now))
            count, last = conn.execute(
                "SELECT count, last_used_ms FROM usage WHERE domain = ? AND item_id = ?", (domain, item_id)).fetchone()
            out[item_id] = {"count": count, "lastUsedMs": last}
        if out:
            db.note_change(conn, "usage", domain, "bump", "run")
    return out


def usage_set(domain, entries):
    """{id: {"count", "lastUsedMs"}} sets; {id: None} or zeros removes. -> entries set."""
    written = 0
    with db.write() as conn:
        for item_id, entry in entries.items():
            item_id = str(item_id or "").strip()
            if not item_id:
                continue
            if entry is not None and not isinstance(entry, dict):
                continue
            count = max(0, int((entry or {}).get("count") or 0))
            last = max(0, int((entry or {}).get("lastUsedMs") or 0))
            if not count and not last:
                conn.execute("DELETE FROM usage WHERE domain = ? AND item_id = ?", (domain, item_id))
                continue
            conn.execute(
                "INSERT INTO usage (domain, item_id, count, last_used_ms) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (domain, item_id) DO UPDATE SET count = excluded.count, last_used_ms = excluded.last_used_ms",
                (domain, item_id, count, last))
            written += 1
        if entries:
            db.note_change(conn, "usage", domain, "set", "import")
    return written


# ---- documents (one JSON value per settings key) ----------------------------------------------

def document_get(key, default=None):
    return db.get_setting(db.connection(), key, default)


def document_put(key, value):
    with db.write() as conn:
        db.set_setting(conn, key, value)
