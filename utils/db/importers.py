"""One-time JSON -> krc.db importers (KRC_SQLITE_GAMEPLAN.md, "Migration").

Each store that moves into the database brings an importer. It runs on the first
connection to a database file (``connection._prepare``), gets that connection (it must
not call ``connection()``), and:

- skips when ``settings['migrated.<store>']`` is already set;
- otherwise imports the store's JSON in one transaction, checks the counts, records the
  migration, commits, and only then renames the JSON to ``*.migrated`` (never deletes);
- raises KrcDatabaseError when the JSON exists but can't be imported: the pack then
  doesn't load, rather than starting with that area empty.
"""

import json
import os
import re
import uuid

from . import connection as db
from .check import KrcDatabaseError

# Set when an importer moved something in during this process, so startup takes a fresh
# snapshot of the result even if one was taken earlier today.
migrated_this_start = False


def _prompt_vault(conn):
    from ..prompt_vault_store import import_legacy_prompt_vault

    return import_legacy_prompt_vault(conn)


PRESETS_MIGRATED_KEY = "migrated.presets"
# krc_nodes folders that are not Loadout Kits (a kit's folder is its id).
_NOT_KIT_DIRS = {"lora_loadout", "model_library", "config_switcher", "word_bank", "prompt_vault", "backups"}
_KIT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")


def _read_json(path):
    """A legacy JSON file's content, None when it isn't there. Raises KrcDatabaseError
    when it exists but can't be read."""
    if not path.exists():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as exc:  # noqa: BLE001
        raise KrcDatabaseError(
            f"{path} could not be read ({exc}). Fix or move that file, then restart ComfyUI. "
            "Nothing was changed.") from exc


def _keep_last(data, mint_ids):
    """The records of a {"presets": [...]} file, one per id (the last wins, as every store's
    load did). With mint_ids a record without an id gets one (CS / Word Bank minted one on
    every load); without, it's dropped (LoRA Loadout / kits dropped it on load)."""
    raw = data.get("presets") if isinstance(data, dict) else None
    out = {}
    for record in raw if isinstance(raw, list) else []:
        if not isinstance(record, dict) or not record.get("name"):
            continue
        record = dict(record)
        if not str(record.get("id") or "").strip():
            if not mint_ids:
                continue
            record["id"] = uuid.uuid4().hex
        out[str(record["id"])] = record
    return list(out.values())


def _kit_dirs():
    from .. import krc_paths

    root = krc_paths.get_krc_nodes_dir()
    if not root.is_dir():
        return []
    return sorted(
        child.name for child in root.iterdir()
        if child.is_dir() and child.name not in _NOT_KIT_DIRS and _KIT_ID_RE.match(child.name)
        and (child / f"{child.name}_presets.json").is_file()
    )


def _presets(_conn):
    """Stage 2: every preset file (LoRA Loadout, Config Switcher, Word Bank, each kit) and
    LoRA Loadout's folder colours, in one transaction."""
    conn = db.connection()
    if db.get_setting(conn, PRESETS_MIGRATED_KEY):
        return False
    from . import presets as preset_db
    from ..config_switcher_presets import legacy_presets_path as cs_path
    from ..loadout_kit.presets import legacy_presets_path as kit_path
    from ..lora_loadout.presets import (
        FOLDER_LINEAGE, PresetStore, clean_folder_colors, legacy_folder_colors_path, legacy_presets_path as ll_path,
        legacy_raw_presets,
    )
    from ..word_bank_presets import legacy_presets_path as wb_path

    sources = []  # (kind, file, records)
    data = _read_json(ll_path())
    if data is not None:
        sources.append((preset_db.LORA_LOADOUT, ll_path(), PresetStore()._dedupe(legacy_raw_presets(data))))
    for kind, path in ((preset_db.CONFIG_SWITCHER, cs_path()), (preset_db.WORD_BANK, wb_path())):
        data = _read_json(path)
        if data is not None:
            sources.append((kind, path, _keep_last(data, mint_ids=True)))
    for kit_id in _kit_dirs():
        path = kit_path(kit_id)
        sources.append((preset_db.kit_kind(kit_id), path, _keep_last(_read_json(path), mint_ids=False)))
    folder_file = legacy_folder_colors_path()
    folder_data = _read_json(folder_file)
    folders = clean_folder_colors(folder_data) if folder_data is not None else None

    counts = {}
    with db.write():
        for kind, path, records in sources:
            preset_db.save_records(kind, records, "import")
            stored = preset_db.count_records(kind)
            if stored != len(records):
                raise KrcDatabaseError(
                    f"Preset import check failed for {path}: {len(records)} presets in the file, "
                    f"{stored} stored. Nothing was changed.")
            counts[kind] = stored
        if folders is not None:
            preset_db.save_folder_colors(FOLDER_LINEAGE, folders, "import")
            counts["folder_colors"] = len(set(folders["folders"]) | set(folders["pinned"]))
        db.set_setting(conn, PRESETS_MIGRATED_KEY, {"atMs": db.now_ms(), **counts})

    for _kind, path, _records in sources:
        retire_json(path)
    if folders is not None:
        retire_json(folder_file)
    if counts:
        summary = ", ".join(f"{kind} {count}" for kind, count in counts.items())
        print(f"[KRC DB] migrated presets: {summary} (old files renamed to *.migrated)")
        return True
    return False


LIBRARY_MIGRATED_KEY = "migrated.library"


def _sidecar_files(folder):
    """{stem: data} for every readable *.json in `folder` (not recursive), plus the count
    of unreadable ones (skipped: the old stores read those as "no record" too)."""
    records, skipped = {}, 0
    try:
        files = sorted(p for p in folder.iterdir() if p.is_file() and p.suffix.lower() == ".json")
    except OSError:
        return records, skipped
    for path in files:
        try:
            with path.open("r", encoding="utf-8") as handle:
                data = json.load(handle)
        except Exception:  # noqa: BLE001
            skipped += 1
            continue
        if isinstance(data, dict):
            records[path.stem] = data
        else:
            skipped += 1
    return records, skipped


def _library(_conn):
    """Stage 3: the library. Identity (LoRAs, models), every metadata sidecar (LoRA, and
    model per type dir), Model Library folder meta, Collections, LoRA / model usage,
    transfer history, the Civitai cache and the batch's last run, in one transaction."""
    conn = db.connection()
    if db.get_setting(conn, LIBRARY_MIGRATED_KEY):
        return False
    from . import library as library_db
    from . import presets as preset_db
    from ..library.civitai_cache import legacy_cache_dir
    from ..library.collections import get_krc_collections_path, normalize_collections
    from ..library.transfer_history import clean_history, get_transfer_history_path
    from ..library.usage_stats import _usage_path
    from ..lora_loadout.civitai_batch_job import LAST_RUN_KEY, legacy_last_run_path
    from ..lora_loadout.identity import get_identity_path as ll_identity_path
    from ..lora_loadout.metadata import get_krc_metadata_dir as ll_metadata_dir
    from ..model_library.folders import FOLDER_LINEAGE, ModelLibraryFolderStore, legacy_folder_meta_path
    from ..model_library.identity import get_identity_path as ml_identity_path
    from ..model_library.metadata import get_krc_model_metadata_dir as ml_metadata_dir

    counts = {}
    skipped = 0
    retire = []  # files / folders to rename *.migrated after the commit

    # Read everything first: an unreadable top-level file stops here, before any write.
    identities = {}
    for lineage, path in ((library_db.LORAS, ll_identity_path()), (library_db.MODELS, ml_identity_path())):
        data = _read_json(path)
        if data is not None:
            aliases = data.get("aliases") if isinstance(data, dict) else {}
            files = data.get("files") if isinstance(data, dict) else {}
            identities[lineage] = (aliases if isinstance(aliases, dict) else {}, files if isinstance(files, dict) else {})
            retire.append(path)

    sidecars = []  # (lineage, type_dir, {stem: record})
    folder = ll_metadata_dir()
    if folder.is_dir():
        records, bad = _sidecar_files(folder)
        sidecars.append((library_db.LORAS, "", records))
        skipped += bad
        retire.append(folder)
    folder = ml_metadata_dir()
    if folder.is_dir():
        try:
            type_dirs = sorted(child for child in folder.iterdir() if child.is_dir() and child.name != "lora")
        except OSError:
            type_dirs = []
        for type_dir in type_dirs:
            records, bad = _sidecar_files(type_dir)
            sidecars.append((library_db.MODELS, type_dir.name, records))
            skipped += bad
        retire.append(folder)

    folder_meta = _read_json(legacy_folder_meta_path())
    if folder_meta is not None:
        retire.append(legacy_folder_meta_path())
    collections_file = _read_json(get_krc_collections_path())
    if collections_file is not None:
        retire.append(get_krc_collections_path())
    usage_file = _read_json(_usage_path())
    if usage_file is not None:
        retire.append(_usage_path())  # its prompts section moved in stage 1
    history_file = _read_json(get_transfer_history_path())
    if history_file is not None:
        retire.append(get_transfer_history_path())
    cache = {}
    cache_folder = legacy_cache_dir()
    if cache_folder.is_dir():
        cache, bad = _sidecar_files(cache_folder)
        skipped += bad
        retire.append(cache_folder)
    last_run = _read_json(legacy_last_run_path())
    if last_run is not None:
        retire.append(legacy_last_run_path())

    with db.write():
        for lineage, (aliases, files) in identities.items():
            library_db.identity_apply(lineage, {str(k): str(v) for k, v in aliases.items() if k and v}, [],
                                      {str(k): v for k, v in files.items() if isinstance(v, dict)}, [], "import")
            counts[f"identity_{lineage}"] = len(files)
        for lineage, type_dir, records in sidecars:
            conn.executemany(
                "INSERT INTO item_metadata (lineage, type_dir, id, record) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (lineage, type_dir, id) DO UPDATE SET record = excluded.record",
                [(lineage, type_dir, stem, json.dumps(record, ensure_ascii=False)) for stem, record in records.items()])
            counts[f"metadata_{lineage}"] = counts.get(f"metadata_{lineage}", 0) + len(records)
        for lineage in (library_db.LORAS, library_db.MODELS):
            stored = conn.execute("SELECT COUNT(*) FROM item_metadata WHERE lineage = ?", (lineage,)).fetchone()[0]
            if stored != counts.get(f"metadata_{lineage}", 0):
                raise KrcDatabaseError(
                    f"Metadata import check failed for {lineage}: {counts.get(f'metadata_{lineage}', 0)} files read, "
                    f"{stored} stored. Nothing was changed.")
        if folder_meta is not None:
            preset_db.save_folder_colors(FOLDER_LINEAGE, ModelLibraryFolderStore().clean(folder_meta), "import")
        if collections_file is not None:
            raw = collections_file.get("collections") if isinstance(collections_file, dict) else {}
            collections = normalize_collections(raw)
            library_db.collections_apply(collections, [], "import")
            counts["collections"] = len(collections)
        if isinstance(usage_file, dict):
            for domain in ("loras", "models"):
                section = usage_file.get(domain)
                if isinstance(section, dict) and section:
                    counts[f"usage_{domain}"] = library_db.usage_set(domain, section)
        if history_file is not None:
            kinds = clean_history(history_file.get("kinds") if isinstance(history_file, dict) else {})
            for key, entry in kinds.items():
                library_db.history_put(key, entry)
            counts["history"] = len(kinds)
        if cache:
            conn.executemany(
                "INSERT INTO civitai_cache (sha256, status, fetched_ms, envelope) VALUES (?, ?, ?, ?) "
                "ON CONFLICT (sha256) DO UPDATE SET status = excluded.status, fetched_ms = excluded.fetched_ms, "
                "envelope = excluded.envelope",
                [(stem.lower(), str(env.get("status") or ""), int(env.get("fetchedAt") or 0),
                  json.dumps(env, ensure_ascii=False)) for stem, env in cache.items()])
            counts["civitai_cache"] = len(cache)
        if isinstance(last_run, dict):
            db.set_setting(conn, LAST_RUN_KEY, last_run)
        db.set_setting(conn, LIBRARY_MIGRATED_KEY, {"atMs": db.now_ms(), **counts, "skipped": skipped})

    for path in retire:
        retire_json(path)
    if retire:
        summary = ", ".join(f"{key} {count}" for key, count in counts.items())
        note = f"; {skipped} unreadable file(s) skipped, left in the *.migrated folders" if skipped else ""
        print(f"[KRC DB] migrated library: {summary or 'nothing to move'}{note} (old files renamed to *.migrated)")
        return True
    return False


SETTINGS_MIGRATED_KEY = "migrated.settings"


def _settings(_conn):
    """Stage 4: the internet-access consent and the video-thumbnail settings. These follow
    their old read rules instead of stopping the pack: an unreadable consent file meant
    "internet off" (fail closed) and is stored as that; unreadable video settings meant the
    defaults, so nothing is stored."""
    conn = db.connection()
    if db.get_setting(conn, SETTINGS_MIGRATED_KEY):
        return False
    from ..krc_network import CONSENT_KEY, legacy_consent_path
    from ..krc_video_settings import SETTINGS_KEY, _coerce, legacy_settings_path

    moved = []
    with db.write():
        path = legacy_consent_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                allow = bool(data.get("allowInternet", True)) if isinstance(data, dict) else False
            except Exception:  # noqa: BLE001 - fail closed, as the file always read
                allow = False
            db.set_setting(conn, CONSENT_KEY, {"allowInternet": allow})
            moved.append(path)
        path = legacy_settings_path()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001 - the defaults, as the file always read
                data = None
            if isinstance(data, dict):
                db.set_setting(conn, SETTINGS_KEY, _coerce(data))
            moved.append(path)
        db.set_setting(conn, SETTINGS_MIGRATED_KEY, {"atMs": db.now_ms(), "files": len(moved)})
    for path in moved:
        retire_json(path)
    if moved:
        print(f"[KRC DB] migrated settings: {', '.join(p.name for p in moved)} (renamed to *.migrated)")
        return True
    return False


WORD_BANKS_MIGRATED_KEY = "migrated.word_banks"


def _word_banks(_conn):
    """Word Bank banks (schema 4): the old word_banks.json manifest + .txt folder, read as
    the old catalog saw them (stray .txt files adopted by name), in one transaction; the
    manifest and folder become *.migrated. A fresh install is seeded from the starter
    banks in data/word_banks/. An unreadable .txt is skipped (the old reader saw it as
    empty) and stays in the *.migrated folder; an unreadable manifest stops the pack."""
    conn = db.connection()
    if db.get_setting(conn, WORD_BANKS_MIGRATED_KEY):
        return False
    from pathlib import Path

    from ..word_bank_banks import banks_from_folder, legacy_banks, legacy_banks_dir, legacy_manifest_path

    folder, manifest = legacy_banks_dir(), legacy_manifest_path()
    had_files = manifest.exists() or (folder.is_dir() and any(folder.glob("*.txt")))
    seeded = False
    if had_files:
        try:
            banks, skipped = legacy_banks()
        except (OSError, ValueError) as exc:
            raise KrcDatabaseError(
                f"{manifest} could not be read ({exc}). Fix or move that file, then restart ComfyUI. "
                "Nothing was changed.") from exc
    else:
        seed_folder = Path(__file__).resolve().parents[2] / "data" / "word_banks"
        banks, skipped = [], 0
        if not conn.execute("SELECT 1 FROM word_banks LIMIT 1").fetchone():
            for bank in banks_from_folder(seed_folder):
                try:
                    text = (seed_folder / bank["filename"]).read_text(encoding="utf-8")
                except (OSError, UnicodeDecodeError):
                    continue
                banks.append({"id": bank["id"], "name": bank["name"], "text": text})
            seeded = bool(banks)
    with db.write():
        conn.executemany(
            "INSERT INTO word_banks (id, name, text) VALUES (?, ?, ?) "
            "ON CONFLICT (id) DO UPDATE SET name = excluded.name, text = excluded.text",
            [(bank["id"], bank["name"], bank["text"]) for bank in banks])
        stored = conn.execute("SELECT COUNT(*) FROM word_banks").fetchone()[0]
        if had_files and stored < len(banks):
            raise KrcDatabaseError(
                f"Word Bank import check failed: {len(banks)} banks read, {stored} stored. Nothing was changed.")
        if banks:
            db.note_change(conn, "word_banks", "", "import")
        db.set_setting(conn, WORD_BANKS_MIGRATED_KEY, {
            "atMs": db.now_ms(), "banks": len(banks), "skipped": skipped,
            "source": "word_banks" if had_files else ("starter banks" if seeded else "")})
    if had_files:
        retire_json(manifest)
        retire_json(folder)
        note = f"; {skipped} unreadable file(s) skipped, left in word_banks.migrated" if skipped else ""
        print(f"[KRC DB] migrated word banks: {len(banks)} banks{note} (old files renamed to *.migrated)")
        return True
    if seeded:
        print(f"[KRC DB] word banks: seeded {len(banks)} starter banks")
    return False


IMPORTERS = [
    ("prompt_vault", _prompt_vault),
    ("presets", _presets),
    ("library", _library),
    ("settings", _settings),
    ("word_banks", _word_banks),
]


def run_pending(conn):
    global migrated_this_start
    for name, importer in IMPORTERS:
        try:
            if importer(conn):
                migrated_this_start = True
        except KrcDatabaseError:
            raise
        except Exception as exc:  # noqa: BLE001 - any failure stops the pack, clearly
            if conn.in_transaction:
                conn.execute("ROLLBACK")
            raise KrcDatabaseError(f"Moving {name} into krc.db failed: {exc}") from exc


def retire_json(path):
    """Rename a migrated JSON file (or folder) to ``<name>.migrated`` (a numbered suffix if taken).
    -> the new path, or "" when the file isn't there."""
    path = str(path)
    if not os.path.exists(path):
        return ""
    target = path + ".migrated"
    index = 2
    while os.path.exists(target):
        target = f"{path}.migrated{index}"
        index += 1
    os.replace(path, target)
    return target
