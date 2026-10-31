"""Word Bank banks (categories): stable ids, names and their words, in krc.db's
``word_banks`` table (one row per bank; ``text`` holds the words one per line, exactly
what a .txt export contains). Before 2026-10-13 they were a ``word_banks.json`` manifest
plus one .txt per bank under ``krc_nodes/word_bank/``; ``legacy_banks`` reads that once
for the import (utils/db/importers.py).
"""
import json
import re
import uuid
from pathlib import Path

from .db import connection as db
from .krc_paths import get_krc_node_dir

BANKS_MANIFEST_FILENAME = "word_banks.json"  # also the name inside bundles
MAX_BANK_NAME_LEN = 80


def normalize_bank_name(name):
    name = str(name or "").strip()
    if name.lower().endswith(".txt"):
        name = name[:-4].strip()
    name = re.sub(r"\s+", " ", name)
    name = re.sub(r"[^A-Za-z0-9 _-]+", "_", name)
    name = re.sub(r"_+", "_", name).strip(" ._-")
    if not name or len(name) > MAX_BANK_NAME_LEN:
        return ""
    return name


def bank_name_aliases(name):
    raw = str(name or "").strip()
    normalized = normalize_bank_name(raw)
    aliases = {raw, normalized}
    aliases.add(raw.replace("_", " "))
    aliases.add(raw.replace(" ", "_"))
    aliases.add(normalized.replace("_", " "))
    aliases.add(normalized.replace(" ", "_"))
    return {alias.strip() for alias in aliases if alias and alias.strip()}


class WordBankCatalog:
    """The banks in krc.db. A bank is ``{"id", "name", "filename"}``; ``filename`` is
    ``<id>.txt``, the name its words get in a bundle."""

    STORE = "word_banks"

    # ---- reads ---------------------------------------------------------------------------
    def load(self):
        rows = db.connection().execute("SELECT id, name FROM word_banks").fetchall()
        banks = [{"id": bank_id, "name": name, "filename": f"{bank_id}.txt"} for bank_id, name in rows]
        return {"banks": sorted(banks, key=lambda item: item["name"].lower())}

    def list(self):
        return self.load()["banks"]

    def get(self, ref):
        ref = str(ref or "").strip()
        if not ref:
            return None
        banks = self.list()
        for bank in banks:
            if bank.get("id") == ref:
                return bank
        ref_aliases = {alias.lower() for alias in bank_name_aliases(ref)}
        for bank in banks:
            if ref_aliases.intersection(alias.lower() for alias in bank_name_aliases(bank.get("name", ""))):
                return bank
        return None

    def read_text(self, ref):
        """A bank's words as stored (one per line), or None when there's no such bank."""
        bank = self.get(ref)
        if not bank:
            return None
        row = db.connection().execute("SELECT text FROM word_banks WHERE id = ?", (bank["id"],)).fetchone()
        return row[0] if row else None

    def read_lines(self, ref):
        """A bank's non-empty entries, stripped ([] when there's no such bank)."""
        text = self.read_text(ref)
        return [line.strip() for line in (text or "").splitlines() if line.strip()]

    # ---- writes --------------------------------------------------------------------------
    def write_lines(self, ref, entries):
        """Replace a bank's words with `entries` (already validated). -> bool."""
        bank = self.get(ref)
        if not bank:
            return False
        text = "\n".join(entries) + ("\n" if entries else "")
        with db.write() as conn:
            conn.execute("UPDATE word_banks SET text = ? WHERE id = ?", (text, bank["id"]))
            db.note_change(conn, self.STORE, bank["id"], "words")
        return True

    def create(self, name):
        name = normalize_bank_name(name)
        if not name:
            return None, "Invalid bank name"
        with db.write() as conn:
            if self._find_by_name(self.list(), name):
                return None, "Word bank already exists"
            bank = {"id": uuid.uuid4().hex, "name": name}
            bank["filename"] = f"{bank['id']}.txt"
            conn.execute("INSERT INTO word_banks (id, name, text) VALUES (?, ?, '')", (bank["id"], name))
            db.note_change(conn, self.STORE, bank["id"], "create")
        return bank, ""

    def upsert_file(self, name, raw_bytes, bank_id=""):
        """Create or replace a bank's words from a .txt's bytes (validated by the caller),
        matched by id, else by name. -> (bank, reason)."""
        name = normalize_bank_name(name)
        if not name:
            return None, "Invalid bank name"
        text = raw_bytes.decode("utf-8") if isinstance(raw_bytes, bytes) else str(raw_bytes or "")
        with db.write() as conn:
            banks = self.list()
            bank_id = str(bank_id or "").strip()
            bank = next((item for item in banks if item.get("id") == bank_id), None) if bank_id else None
            bank = bank or self._find_by_name(banks, name)
            if not bank:
                bank = {"id": bank_id or uuid.uuid4().hex, "name": name}
                bank["filename"] = f"{bank['id']}.txt"
                conn.execute("INSERT INTO word_banks (id, name, text) VALUES (?, ?, ?)", (bank["id"], name, text))
            else:
                bank = dict(bank, name=name)
                conn.execute("UPDATE word_banks SET name = ?, text = ? WHERE id = ?", (name, text, bank["id"]))
            db.note_change(conn, self.STORE, bank["id"], "save")
        return bank, ""

    def rename(self, bank_id, new_name):
        new_name = normalize_bank_name(new_name)
        if not bank_id or not new_name:
            return None, "Invalid bank name"
        with db.write() as conn:
            banks = self.list()
            bank = next((item for item in banks if item.get("id") == bank_id), None)
            if not bank:
                return None, "Word bank not found"
            existing = self._find_by_name(banks, new_name)
            if existing and existing.get("id") != bank_id:
                return None, "Target word bank exists"
            conn.execute("UPDATE word_banks SET name = ? WHERE id = ?", (new_name, bank_id))
            db.note_change(conn, self.STORE, bank_id, "rename")
        return dict(bank, name=new_name), ""

    def delete(self, bank_id):
        with db.write() as conn:
            bank = next((item for item in self.list() if item.get("id") == bank_id), None)
            if not bank:
                return None
            conn.execute("DELETE FROM word_banks WHERE id = ?", (bank_id,))
            db.note_change(conn, self.STORE, bank_id, "delete")
        return bank

    def _find_by_name(self, banks, name):
        wanted = {alias.lower() for alias in bank_name_aliases(name)}
        return next(
            (bank for bank in banks if wanted.intersection(alias.lower() for alias in bank_name_aliases(bank.get("name", "")))),
            None,
        )


# ---- the pre-database files (read once by the import) --------------------------------------

def legacy_banks_dir():
    return get_krc_node_dir("word_bank") / "word_banks"


def legacy_manifest_path():
    return get_krc_node_dir("word_bank") / BANKS_MANIFEST_FILENAME


def _legacy_clean(banks):
    """The old catalog's cleaning: valid names, one entry per id, a .txt filename each."""
    out = {}
    for bank in banks:
        if not isinstance(bank, dict):
            continue
        name = normalize_bank_name(bank.get("name", ""))
        if not name:
            continue
        bank_id = str(bank.get("id") or uuid.uuid4().hex)
        filename = Path(str(bank.get("filename") or f"{bank_id}.txt")).name
        if not filename.lower().endswith(".txt"):
            filename = f"{bank_id}.txt"
        out[bank_id] = {"id": bank_id, "name": name, "filename": filename}
    return list(out.values())


def banks_from_folder(folder, banks=None):
    """The old catalog's adoption: every .txt in `folder` not already listed becomes a
    bank named after its file (a listed name keeps its entry). -> [{id, name, filename}]."""
    banks = list(banks or [])
    known = {bank.get("filename") for bank in banks}
    by_name = {alias.lower(): bank for bank in banks for alias in bank_name_aliases(bank.get("name", ""))}
    for txt in sorted(Path(folder).glob("*.txt")) if Path(folder).is_dir() else []:
        if txt.name in known:
            continue
        name = normalize_bank_name(txt.stem.replace("_", " "))
        if not name:
            continue
        existing = next((by_name[alias.lower()] for alias in bank_name_aliases(name) if alias.lower() in by_name), None)
        if existing:
            existing["filename"] = existing.get("filename") or txt.name
            continue
        bank = {"id": uuid.uuid4().hex, "name": name, "filename": txt.name}
        banks.append(bank)
        for alias in bank_name_aliases(name):
            by_name[alias.lower()] = bank
    return _legacy_clean(banks)


def legacy_banks():
    """(banks, unreadable count) from the old manifest + .txt folder, as the old catalog
    saw them: [{id, name, text}]. A listed bank whose file is gone has no words.
    Raises ValueError when the manifest exists but can't be read."""
    folder = legacy_banks_dir()
    manifest = legacy_manifest_path()
    listed = []
    if manifest.exists():
        data = json.loads(manifest.read_text(encoding="utf-8"))
        listed = _legacy_clean(data.get("banks", []) if isinstance(data, dict) else [])
    out, unreadable = [], 0
    for bank in banks_from_folder(folder, listed):
        path = folder / bank["filename"]
        text = ""
        if path.is_file():
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                unreadable += 1
                continue
        out.append({"id": bank["id"], "name": bank["name"], "text": text})
    return out, unreadable
