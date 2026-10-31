"""Word Bank's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md): "word_bank" — the banks
(word_banks/*.txt + their manifest) and the Word Bank presets.

Import: merge adds banks whose name isn't here and presets whose id isn't; overwrite also
replaces same-named banks and same-id presets. Every bank's text is checked as a word list.
"""
import json
import re
from pathlib import Path

from .archive_guard import read_json_entry
from .bundle.presets_plan import incoming_presets
from .bundle.sections import ImportPlan, Section, plan_summary
from .upload_limits import TEXT_UPLOAD_MAX
from .word_bank_banks import BANKS_MANIFEST_FILENAME, WordBankCatalog, normalize_bank_name
from .word_bank_presets import WordBankPresetStore

PRESETS_ARCHIVE_NAME = "presets.json"
BANKS_MANIFEST_ARCHIVE_NAME = BANKS_MANIFEST_FILENAME
BANKS_ARCHIVE_DIR = "word_banks"
MAX_BANK_BYTES = 1_000_000
MAX_BANK_LINES = 10_000
MAX_LINE_LEN = 120


def validate_bank_text(raw_bytes):
    """Return (ok, reason). Rejects files that don't look like a word list."""
    if len(raw_bytes) > MAX_BANK_BYTES:
        return False, "file too large"
    try:
        text = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        return False, "not valid UTF-8 text"
    entries = [line.strip() for line in text.splitlines() if line.strip()]
    if not entries:
        return False, "no word entries"
    if len(entries) > MAX_BANK_LINES:
        return False, "too many entries"
    if any(len(line) > MAX_LINE_LEN for line in entries):
        return False, "lines too long (not a word list)"
    return True, ""


def _safe_bank_filename(name):
    stem = Path(name).stem.strip()
    stem = re.sub(r"\s+", "_", stem)
    stem = re.sub(r"[^A-Za-z0-9_-]+", "_", stem)
    stem = re.sub(r"_+", "_", stem).strip("._-")
    return f"{stem}.txt" if stem else ""


def write_section(archive, selection=None):
    """Word Bank into ``archive`` (a zip or a bundle's SectionArchive): every bank, or
    ``{"banks": [ids]}``, plus all Word Bank presets (they're small, and a preset row only
    names a bank). -> {"counts", "links"}."""
    archive.writestr(PRESETS_ARCHIVE_NAME, json.dumps(WordBankPresetStore().load(), indent=2, ensure_ascii=False))
    catalog = WordBankCatalog()
    manifest = catalog.load()
    banks = manifest.get("banks", [])
    wanted = (selection or {}).get("banks")
    if wanted is not None:
        wanted = {str(bank_id) for bank_id in wanted}
        banks = [bank for bank in banks if str(bank.get("id", "")) in wanted]
    archive.writestr(BANKS_MANIFEST_ARCHIVE_NAME, json.dumps({**manifest, "banks": banks}, indent=2, ensure_ascii=False))
    written = 0
    for bank in banks:
        text = catalog.read_text(bank.get("id", ""))
        if text is not None:
            archive.writestr(f"{BANKS_ARCHIVE_DIR}/{bank.get('filename')}", text)
            written += 1
    presets = WordBankPresetStore().load().get("presets", [])
    return {"counts": {"banks": written, "presets": len(presets)}, "links": {}}


def _optional_json(archive, name):
    if name not in archive.namelist():
        return None
    try:
        return read_json_entry(archive, name)
    except (ValueError, UnicodeDecodeError):
        return None


def plan_section(archive, mode, options, stager):
    """Plan a "word_bank" import (see the module docstring)."""
    overwrite = mode == "overwrite"
    manifest = _optional_json(archive, BANKS_MANIFEST_ARCHIVE_NAME)
    manifest_banks = manifest.get("banks", []) if isinstance(manifest, dict) else []
    by_filename = {Path(bank.get("filename", "")).name: bank for bank in manifest_banks
                   if isinstance(bank, dict) and bank.get("filename") and bank.get("name")}
    catalog = WordBankCatalog()
    local_banks = catalog.list()
    local_ids = {str(bank.get("id")) for bank in local_banks}
    bank_writes, skipped = [], {}
    added = updated = unchanged = 0
    for name in archive.namelist():
        if not name.startswith(f"{BANKS_ARCHIVE_DIR}/") or not name.lower().endswith(".txt"):
            continue
        base = Path(name).name  # strip archive dirs / traversal
        if archive.getinfo(name).file_size > TEXT_UPLOAD_MAX:
            skipped["too large"] = skipped.get("too large", 0) + 1
            continue
        raw = archive.read(name)
        ok, reason = validate_bank_text(raw)
        if not ok:
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        meta = by_filename.get(base)
        bank_name = normalize_bank_name(meta.get("name", "") if meta else Path(_safe_bank_filename(base)).stem)
        if not bank_name:
            skipped["invalid bank name"] = skipped.get("invalid bank name", 0) + 1
            continue
        bank_id = str(meta.get("id", "")) if meta else ""
        exists = (bank_id and bank_id in local_ids) or catalog._find_by_name(local_banks, bank_name)
        if exists and not overwrite:
            unchanged += 1
            continue
        bank_writes.append((bank_name, raw, bank_id))
        if exists:
            updated += 1
        else:
            added += 1

    presets = [preset for preset in incoming_presets(_optional_json(archive, PRESETS_ARCHIVE_NAME))
               if isinstance(preset, dict) and preset.get("name")]
    store = WordBankPresetStore()
    local_presets = {str(preset.get("id")) for preset in store.load().get("presets", [])}
    preset_writes = [preset for preset in presets if overwrite or str(preset.get("id") or "") not in local_presets]
    added += sum(1 for preset in preset_writes if str(preset.get("id") or "") not in local_presets)
    updated += sum(1 for preset in preset_writes if str(preset.get("id") or "") in local_presets)
    unchanged += len(presets) - len(preset_writes)

    def apply():
        banks = 0
        for bank_name, raw, bank_id in bank_writes:
            bank, _reason = catalog.upsert_file(bank_name, raw, bank_id)
            banks += 1 if bank else 0
        for preset in preset_writes:
            store.upsert_by_id(preset.get("id", ""), preset.get("group", ""), preset.get("name"), preset.get("rows", []))
        return {"banks": banks, "presets": len(preset_writes)}

    return ImportPlan(plan_summary(added, updated, unchanged, skipped), apply)


def bundle_sections():
    """This node's KRC bundle section (registered with its routes)."""
    return [Section("word_bank", "Word Bank", lambda: len(WordBankCatalog().load().get("banks", [])), write_section,
                    plan_section, slices=(("word_banks", None), ("presets", "kind = 'wb'")),
                    stores=(("word_banks", None), ("presets:wb", None)))]
