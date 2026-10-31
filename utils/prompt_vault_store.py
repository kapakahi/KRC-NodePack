"""Prompt Vault's store: prompts and categories in krc.db (KRC_SQLITE_GAMEPLAN.md stage 1).

The API retains the JSON store's shape: ``load_prompts()`` returns Default's library as
``{category: {name: record, "__meta__": meta}}`` and ``save_prompts(data)`` stores a whole
library. Underneath, a save writes only the rows that changed, in one transaction, and a
load is served from an in-process cache that follows the database's ``prompts`` revision.
Records are kept exactly as the JSON store held them (every field, in order). Explicit
profile ids scope browsing/writes; stable-id reads span profiles unless constrained.
There is no process-global active profile. Ownership is stored in relational columns,
not injected into the raw record shape.

Prompt usage (the silent run counter) is keyed by the record id here, so renaming or
moving a prompt keeps its history. The callers still speak ``category/name`` keys
(``utils/library/usage_stats.py`` delegates the "prompts" section to this module).
"""

import json
import os
import re
import threading
import uuid

from .krc_paths import get_krc_node_dir
from .db import connection as db
from .db.check import KrcDatabaseError
from .prompt_profiles import DEFAULT_PROFILE_ID, require_profile


UNASSIGNED_CATEGORY = "Unassigned"
LEGACY_DEFAULT_CATEGORY = "Default"


def get_prompts_path():
    """The pre-database prompts JSON file. Only the one-time import reads it; it's renamed
    to ``*.migrated`` afterwards. Its folder still holds the thumbnails."""
    return os.path.join(str(get_krc_node_dir("prompt_vault")), "prompt_vault_data.json")


_KIT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
_KIT_TEXT_MAX = 200


def normalize_kit_presets(value):
    """A prompt's Loadout Kit preset links (PV_KIT_PRESETS_GAMEPLAN.md step 3):
    ``{kit_id: {"id", "label"}}``, stored as the record's ``kitPresets``. ``id`` is the kit
    preset id (or ``none:empty``), ``label`` its cached name for the missing state. A link
    to a kit that isn't installed is kept. Mirrors web/js/prompt_vault/kit_presets.js."""
    out = {}
    if not isinstance(value, dict):
        return out
    for kit_id, link in value.items():
        if not isinstance(kit_id, str) or not _KIT_ID_RE.match(kit_id) or not isinstance(link, dict):
            continue
        preset_id = str(link.get("id") or "").strip()[:_KIT_TEXT_MAX]
        if preset_id:
            out[kit_id] = {"id": preset_id, "label": str(link.get("label") or "").strip()[:_KIT_TEXT_MAX]}
    return out


def ensure_ids(data):
    """Assign a stable unique `id` to any prompt record missing one."""
    changed = False
    for category, cat_data in (data or {}).items():
        if not isinstance(cat_data, dict):
            continue
        for name, entry in cat_data.items():
            if name == "__meta__" or not isinstance(entry, dict):
                continue
            if not entry.get("id"):
                entry["id"] = uuid.uuid4().hex
                changed = True
    return changed


def merge_category_data(target, source, suffix_label=LEGACY_DEFAULT_CATEGORY):
    """Merge one category bucket into another without overwriting prompts."""
    if not isinstance(target, dict):
        target = {}
    if not isinstance(source, dict):
        return target
    for name, entry in source.items():
        if name == "__meta__":
            if "__meta__" not in target:
                target["__meta__"] = entry
            continue
        next_name = name
        if next_name in target:
            base = f"{name} ({suffix_label})"
            next_name = base
            i = 2
            while next_name in target:
                next_name = f"{base} {i}"
                i += 1
        target[next_name] = entry
    return target


def normalize_categories(data):
    """Rename legacy Default bucket to Unassigned, merging if needed."""
    if not isinstance(data, dict) or LEGACY_DEFAULT_CATEGORY not in data:
        return False
    legacy = data.pop(LEGACY_DEFAULT_CATEGORY)
    if UNASSIGNED_CATEGORY in data:
        data[UNASSIGNED_CATEGORY] = merge_category_data(data[UNASSIGNED_CATEGORY], legacy)
    else:
        data[UNASSIGNED_CATEGORY] = legacy
    return True


def normalize_category_name(category):
    category = (category or "").strip()
    return UNASSIGNED_CATEGORY if category == LEGACY_DEFAULT_CATEGORY else category




def sort_prompts_data(data):
    """Sort categories and prompts alphabetically, preserving __meta__."""
    sorted_data = {}
    categories = sorted(data.keys(), key=lambda value: (value != UNASSIGNED_CATEGORY, value.lower()))
    for category in categories:
        cat_data = data[category]
        meta = cat_data.get("__meta__")
        sorted_prompts = dict(sorted(
            ((k, v) for k, v in cat_data.items() if k != "__meta__"),
            key=lambda item: item[0].lower()
        ))
        if meta is not None:
            sorted_prompts["__meta__"] = meta
        sorted_data[category] = sorted_prompts
    return sorted_data


# ---- krc.db ------------------------------------------------------------------------------

STORE = "prompts"            # the `changes` store name (the load cache follows it)
USAGE_DOMAIN = "prompts"     # the `usage` domain (rows keyed by record id)
MIGRATED_KEY = "migrated.prompt_vault"

_cache_lock = threading.Lock()
_cache = {"key": None, "text": None}


def usage_key(category, name):
    """The category/name key the usage callers and the browser use."""
    return f"{category}/{name}"


def _library_from_rows(categories, rows):
    data = {}
    for category, meta in categories:
        data[category] = {} if meta is None else {"__meta__": json.loads(meta)}
    for category, name, record in rows:
        data.setdefault(category, {})[name] = json.loads(record)
    return sort_prompts_data(data)


def load_prompts(profile_id=DEFAULT_PROFILE_ID):
    """The whole library, ``{category: {name: record, "__meta__": meta}}``, sorted as the
    JSON store kept it. A fresh copy every call (callers may change it)."""
    return load_prompts_with_revision(profile_id)[1]


def load_prompts_with_revision(profile_id=DEFAULT_PROFILE_ID):
    """-> (revision, library): ``load_prompts`` plus the ``prompts`` revision it was read
    at, from the same read."""
    # Never publish uncommitted content to the process cache: rolled-back revisions
    # can be reused by a later write. Nested transaction reads must see their own work.
    uncommitted = db.connection().in_transaction
    with db.read() as conn:
        require_profile(profile_id, conn)
        revision = db.revision(STORE, conn)
        key = (str(db.db_path()), db.generation(), revision, profile_id)
        with _cache_lock:
            if not uncommitted and _cache["key"] == key:
                return revision, json.loads(_cache["text"])
        categories = conn.execute("SELECT name, meta FROM prompt_categories WHERE profile_id = ?", (profile_id,)).fetchall()
        rows = conn.execute("SELECT category, name, record FROM prompts WHERE profile_id = ?", (profile_id,)).fetchall()
    data = _library_from_rows(categories, rows)
    text = json.dumps(data, ensure_ascii=False)
    if not uncommitted:
        with _cache_lock:
            _cache["key"] = key
            _cache["text"] = text
    return revision, json.loads(text)


def prompts_by_id(record_id, *, profile_id=None):
    """Every prompt with this record id, as ``[(category, name, record), …]`` ordered by
    category, then name. Ids aren't unique (a copied prompt can keep its source's id), so
    there can be more than one; [] when there's none. An indexed lookup, not a full load."""
    record_id = str(record_id or "").strip()
    if not record_id:
        return []
    with db.read() as conn:
        if profile_id is not None:
            require_profile(profile_id, conn)
        rows = conn.execute(
            "SELECT category, name, record FROM prompts WHERE id = ? "
            "AND (? IS NULL OR profile_id = ?) ORDER BY category, name, profile_id",
            (record_id, profile_id, profile_id),
        ).fetchall()
    return [(category, name, json.loads(record)) for category, name, record in rows]


def prompts_by_ids(record_ids, *, profile_id=None):
    """Several ids at once, in one read: -> (revision, {id: [(category, name, record), …]}).
    Each id maps to every match, ordered by category then name; an id with no match is
    left out. ``revision`` is the ``prompts`` revision the answer was read at."""
    wanted = [str(value).strip() for value in record_ids if str(value or "").strip()]
    found = {}
    with db.read() as conn:
        if profile_id is not None:
            require_profile(profile_id, conn)
        revision = db.revision(STORE, conn)
        if wanted:
            marks = ", ".join("?" for _ in wanted)
            rows = conn.execute(
                f"SELECT id, category, name, record FROM prompts WHERE id IN ({marks}) "
                "AND (? IS NULL OR profile_id = ?) ORDER BY category, name, profile_id",
                [*wanted, profile_id, profile_id],
            ).fetchall()
            for record_id, category, name, record in rows:
                found.setdefault(record_id, []).append((category, name, json.loads(record)))
    return revision, found


def prompt_owners(record_ids):
    """Explicit references resolve across profiles; ownership stays outside raw records.

    -> {id: [{profileId, category, name}, ...]}. Legacy copies may share an id within
    one profile, so retain all locations. New cross-profile copies must mint ids.
    """
    wanted = list(dict.fromkeys(str(value).strip() for value in record_ids if str(value or "").strip()))
    if not wanted:
        return {}
    out = {}
    with db.read() as conn:
        for start in range(0, len(wanted), 500):
            chunk = wanted[start:start + 500]
            marks = ",".join("?" for _ in chunk)
            for record_id, profile_id, category, name in conn.execute(
                f"SELECT id, profile_id, category, name FROM prompts WHERE id IN ({marks}) "
                "ORDER BY profile_id, category, name", chunk,
            ):
                out.setdefault(record_id, []).append({"profileId": profile_id, "category": category, "name": name})
    return out


def save_prompts(data, source="", *, profile_id=DEFAULT_PROFILE_ID):
    """Store `data` as the whole library. Only the categories and prompts that differ from
    what's stored are written, in one transaction; usage of prompts that are gone is
    dropped. Raises on failure (callers report it)."""
    if not isinstance(data, dict):
        raise ValueError("Prompt library must be an object")
    normalize_categories(data)
    ensure_ids(data)
    with db.write() as conn:
        _write_library(conn, data, source, profile_id=profile_id)


def _write_library(conn, data, source="", *, profile_id=DEFAULT_PROFILE_ID):
    """Write the library diff inside the caller's transaction. -> rows changed."""
    require_profile(profile_id, conn)
    current_cats = dict(conn.execute("SELECT name, meta FROM prompt_categories WHERE profile_id = ?", (profile_id,)).fetchall())
    current_rows = {
        (category, name): (record_id, record)
        for category, name, record_id, record in conn.execute("SELECT category, name, id, record FROM prompts WHERE profile_id = ?", (profile_id,))
    }
    want_cats = {}
    want_rows = {}
    for category, bucket in data.items():
        if not isinstance(bucket, dict):
            continue
        meta = bucket.get("__meta__")
        want_cats[category] = None if meta is None else json.dumps(meta, ensure_ascii=False)
        for name, record in bucket.items():
            if name == "__meta__" or not isinstance(record, dict):
                continue
            want_rows[(category, name)] = (str(record.get("id") or ""), json.dumps(record, ensure_ascii=False))

    # A stable id has one owner. Legacy copies inside that owner remain supported.
    ids = list({record_id for record_id, _record in want_rows.values()})
    for start in range(0, len(ids), 500):
        chunk = ids[start:start + 500]
        marks = ",".join("?" for _ in chunk)
        if conn.execute(f"SELECT 1 FROM prompts WHERE profile_id != ? AND id IN ({marks}) LIMIT 1",
                        [profile_id, *chunk]).fetchone():
            raise ValueError("A prompt id belongs to another profile; create a copy with a fresh id")
    changed = 0
    for key in current_rows.keys() - want_rows.keys():
        conn.execute("DELETE FROM prompts WHERE profile_id = ? AND category = ? AND name = ?", (profile_id, *key))
        db.note_change(conn, STORE, current_rows[key][0], "delete", source)
        changed += 1
    for category in current_cats.keys() - want_cats.keys():
        conn.execute("DELETE FROM prompt_categories WHERE profile_id = ? AND name = ?", (profile_id, category))
        db.note_change(conn, STORE, f"category:{category}", "delete", source)
        changed += 1
    for category, meta in want_cats.items():
        if category in current_cats and current_cats[category] == meta:
            continue
        conn.execute(
            "INSERT INTO prompt_categories (name, meta, profile_id) VALUES (?, ?, ?) "
            "ON CONFLICT (profile_id, name) DO UPDATE SET meta = excluded.meta",
            (category, meta, profile_id),
        )
        db.note_change(conn, STORE, f"category:{category}", "save", source)
        changed += 1
    for (category, name), (record_id, record) in want_rows.items():
        if current_rows.get((category, name)) == (record_id, record):
            continue
        conn.execute(
            "INSERT INTO prompts (category, name, id, record, profile_id) VALUES (?, ?, ?, ?, ?) "
            "ON CONFLICT (profile_id, category, name) DO UPDATE SET id = excluded.id, record = excluded.record",
            (category, name, record_id, record, profile_id),
        )
        db.note_change(conn, STORE, record_id, "save", source)
        changed += 1

    gone = {record_id for record_id, _record in current_rows.values()} - {
        record_id for record_id, _record in want_rows.values()}
    for record_id in gone:
        conn.execute("DELETE FROM usage WHERE domain = ? AND item_id = ?", (USAGE_DOMAIN, record_id))
    return changed


# ---- usage (record-id keyed; callers speak category/name) ---------------------------------

def _ids_by_usage_key(conn, profile_id=DEFAULT_PROFILE_ID):
    require_profile(profile_id, conn)
    return {
        usage_key(category, name): record_id
        for category, name, record_id in conn.execute("SELECT category, name, id FROM prompts WHERE profile_id = ?", (profile_id,))
    }


def prompt_usage_by_key(profile_id=DEFAULT_PROFILE_ID):
    """{category/name: {"count", "lastUsedMs"}} for every prompt with usage."""
    conn = db.connection()
    require_profile(profile_id, conn)
    rows = conn.execute(
        "SELECT p.category, p.name, u.count, u.last_used_ms FROM prompts p "
        "JOIN usage u ON u.domain = ? AND u.item_id = p.id WHERE p.profile_id = ?",
        (USAGE_DOMAIN, profile_id),
    )
    return {usage_key(category, name): {"count": count, "lastUsedMs": last}
            for category, name, count, last in rows}


def prompt_usage_by_ids(record_ids):
    """Usage for explicit cross-profile references, keyed by stable id (one read)."""
    wanted = list(dict.fromkeys(str(value).strip() for value in record_ids if str(value or "").strip()))
    out = {}
    with db.read() as conn:
        for start in range(0, len(wanted), 500):
            chunk = wanted[start:start + 500]
            marks = ",".join("?" for _ in chunk)
            for record_id, count, last in conn.execute(
                f"SELECT item_id, count, last_used_ms FROM usage WHERE domain = ? AND item_id IN ({marks})",
                [USAGE_DOMAIN, *chunk],
            ):
                out[record_id] = {"count": count, "lastUsedMs": last}
    return out


def bump_prompt_usage(keys, *, profile_id=DEFAULT_PROFILE_ID):
    """Count one use for each category/name key (a prompt in several keys, or sharing an
    id, counts once). Unknown keys (an unsaved prompt) are skipped. -> {key: new totals}."""
    now = db.now_ms()
    out = {}
    with db.write() as conn:
        ids = _ids_by_usage_key(conn, profile_id)
        totals = {}
        for key in keys:
            record_id = ids.get(key)
            if not record_id:
                continue
            if record_id not in totals:
                conn.execute(
                    "INSERT INTO usage (domain, item_id, count, last_used_ms) VALUES (?, ?, 1, ?) "
                    "ON CONFLICT (domain, item_id) DO UPDATE SET count = count + 1, last_used_ms = excluded.last_used_ms",
                    (USAGE_DOMAIN, record_id, now),
                )
                count, last = conn.execute(
                    "SELECT count, last_used_ms FROM usage WHERE domain = ? AND item_id = ?",
                    (USAGE_DOMAIN, record_id),
                ).fetchone()
                totals[record_id] = {"count": count, "lastUsedMs": last}
            out[key] = dict(totals[record_id])
        if totals:
            db.note_change(conn, "usage", USAGE_DOMAIN, "bump", "run")
    return out


def set_prompt_usage(entries, *, profile_id=DEFAULT_PROFILE_ID):
    """{category/name: {"count", "lastUsedMs"}} sets an entry, {key: None} (or zeros)
    removes it. Keys with no saved prompt are skipped. -> number of entries set."""
    written = 0
    with db.write() as conn:
        ids = _ids_by_usage_key(conn, profile_id)
        for key, entry in entries.items():
            record_id = ids.get(str(key or "").strip())
            if not record_id:
                continue
            count = last = 0
            if isinstance(entry, dict):
                count = max(0, int(entry.get("count") or 0))
                last = max(0, int(entry.get("lastUsedMs") or 0))
            elif entry is not None:
                continue
            if not count and not last:
                conn.execute("DELETE FROM usage WHERE domain = ? AND item_id = ?", (USAGE_DOMAIN, record_id))
                continue
            conn.execute(
                "INSERT INTO usage (domain, item_id, count, last_used_ms) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (domain, item_id) DO UPDATE SET count = excluded.count, last_used_ms = excluded.last_used_ms",
                (USAGE_DOMAIN, record_id, count, last),
            )
            written += 1
        if entries:
            db.note_change(conn, "usage", USAGE_DOMAIN, "set", "import")
    return written


# ---- one-time import from the JSON store ---------------------------------------------------

def _legacy_candidates(path):
    """The JSON file, then the backups the old loader recovered from, in its order."""
    return [path, path + "_bak", path + ".bak", path + ".backup", path + ".tmp"]


def _read_legacy_library(path):
    """-> (library, file read) from the old JSON store, (None, "") when there is none.
    Raises KrcDatabaseError when it exists but neither it nor a backup can be read."""
    if not os.path.exists(path):
        return None, ""
    problems = []
    for candidate in _legacy_candidates(path):
        if not os.path.exists(candidate):
            continue
        try:
            with open(candidate, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if not isinstance(data, dict):
                raise ValueError("not a JSON object")
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{os.path.basename(candidate)}: {exc}")
            continue
        if candidate != path:
            print(f"[KRC DB] prompt_vault_data.json is unreadable; importing its backup {os.path.basename(candidate)}")
        return data, candidate
    raise KrcDatabaseError(
        f"{path} could not be read ({'; '.join(problems)}). Fix or move that file, then restart "
        "ComfyUI. Nothing was changed.")


def _count_library(data):
    categories = prompts = 0
    for bucket in data.values():
        if not isinstance(bucket, dict):
            continue
        categories += 1
        prompts += sum(1 for name, record in bucket.items() if name != "__meta__" and isinstance(record, dict))
    return categories, prompts


def import_legacy_prompt_vault(conn):
    """Move prompt_vault_data.json (and the prompt usage from usage_stats.json) into
    krc.db, once. A fresh install starts with an empty library. Runs on the
    first connection (utils/db/importers.py) with that connection. -> True when a JSON
    library was moved in."""
    if db.get_setting(conn, MIGRATED_KEY):
        return False
    path = get_prompts_path()
    data, source_path = _read_legacy_library(path)
    ledger = {}
    if source_path:
        from .library.usage_stats import read_json_section

        ledger = read_json_section("prompts")

    categories = prompts = usage = 0
    conn.execute("BEGIN IMMEDIATE")
    try:
        if data:
            normalize_categories(data)
            ensure_ids(data)
            categories, prompts = _count_library(data)
            _write_library(conn, data, "import")
            stored_categories = conn.execute("SELECT COUNT(*) FROM prompt_categories").fetchone()[0]
            stored_prompts = conn.execute("SELECT COUNT(*) FROM prompts").fetchone()[0]
            if (stored_categories, stored_prompts) != (categories, prompts):
                raise KrcDatabaseError(
                    f"Prompt Vault import check failed: {categories} categories / {prompts} prompts in the "
                    f"file, {stored_categories} / {stored_prompts} stored. Nothing was changed.")
            ids = _ids_by_usage_key(conn)
            for key, entry in (ledger or {}).items():
                record_id = ids.get(key)
                if not record_id or not isinstance(entry, dict):
                    continue
                count = max(0, int(entry.get("count") or 0))
                last = max(0, int(entry.get("lastUsedMs") or 0))
                if not count and not last:
                    continue
                conn.execute(
                    "INSERT INTO usage (domain, item_id, count, last_used_ms) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (domain, item_id) DO UPDATE SET count = MAX(count, excluded.count), "
                    "last_used_ms = MAX(last_used_ms, excluded.last_used_ms)",
                    (USAGE_DOMAIN, record_id, count, last),
                )
                usage += 1
        db.set_setting(conn, MIGRATED_KEY, {
            "atMs": db.now_ms(),
            "source": os.path.basename(source_path) if source_path else "",
            "categories": categories,
            "prompts": prompts,
            "usage": usage,
        })
        conn.execute("COMMIT")
    except BaseException:
        if conn.in_transaction:
            conn.execute("ROLLBACK")
        raise

    if source_path:
        from .db.importers import retire_json

        retire_json(path)
        retire_json(path + "_bak")
        print(f"[KRC DB] migrated prompt_vault: {prompts} prompts, {categories} categories, "
              f"{usage} usage entries (old file renamed to prompt_vault_data.json.migrated)")
    return bool(source_path)
