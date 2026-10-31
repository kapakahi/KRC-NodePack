"""Undo last import (UNIFIED_BUNDLE_GAMEPLAN.md stage 5): one level, kept across restarts.

Before an import applies, begin() copies krc.db to a new candidate folder,
krc_nodes/bundle_undo/<time>-<random>/before.db, next to (not over) the published undo.
The import's transaction also writes the candidate's name into settings (COMMITTED_KEY),
so a restart can tell an import that landed from one that rolled back. While the staged
thumbnails move into place, every file the import replaces or removes is moved into the
candidate first and every file it adds is noted (journal.jsonl, one line each). finish()
publishes it: manifest.json (written last, atomically: the sections imported, the mode,
the file's name, the change log's last rev), then the previous undo is removed. The
published undo is the newest folder with a manifest; a candidate without one is never
offered. A failed import discards only its candidate, so the last good import stays
undoable; recover() (startup) publishes a candidate whose import had landed and drops one
whose import didn't, putting back any file it holds.

undo() puts back only the slices of krc.db those sections own (Section.slices: e.g.
item_metadata WHERE lineage = 'loras', presets WHERE kind = 'll') from before.db, notes a
change in each section's stores (caches reload), moves the saved thumbnails back and deletes
the added ones. Changes made since the import in those slices are undone too; info() counts
them (``changesSince``) so the dialog can say so first.
"""
import json
import os
import shutil
import sqlite3
import time
import uuid
from pathlib import Path

from ..db import connection as db
from ..krc_paths import get_krc_nodes_dir
from .sections import all_sections

UNDO_DIRNAME = "bundle_undo"
BEFORE_DB = "before.db"
MANIFEST = "manifest.json"
PENDING = "pending.json"     # a candidate's sections / mode / file name, from begin()
JOURNAL = "journal.jsonl"    # a candidate's moved / added files, one JSON line each
FILES_DIRNAME = "files"
COMMITTED_KEY = "bundle_undo.committed"   # settings: the candidate whose import landed


class UndoError(ValueError):
    """An undo that can't run; the message is shown to the user."""


def undo_root():
    return Path(get_krc_nodes_dir()) / UNDO_DIRNAME


def _published(folder):
    return (folder / MANIFEST).is_file() and (folder / BEFORE_DB).is_file()


def _current():
    """The published undo: the newest folder with a manifest (names sort by time), or None."""
    root = undo_root()
    if not root.is_dir():
        return None
    published = [folder for folder in root.iterdir() if folder.is_dir() and _published(folder)]
    return max(published, key=lambda folder: folder.name) if published else None


class UndoRecord:
    """The candidate undo folder an import is filling (see the module docstring)."""

    def __init__(self, folder, sections=(), mode="", file_name="", slices=None):
        self.dir = folder
        self.files = folder / FILES_DIRNAME
        self.slices = slices or {}
        self.sections = list(sections)
        self.mode = mode
        self.file_name = str(file_name or "")[:200]
        self.saved = []   # [stored name, original path]
        self.added = []   # paths the import created

    def _journal(self, entry):
        with (self.dir / JOURNAL).open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    def mark_committed(self, conn):
        """Inside the import's transaction: this candidate's import is the one that landed."""
        conn.execute("INSERT INTO settings (key, value) VALUES (?, ?) "
                     "ON CONFLICT (key) DO UPDATE SET value = excluded.value", (COMMITTED_KEY, self.dir.name))

    def keep(self, path):
        """Move ``path`` (about to be replaced or removed) into the undo folder."""
        path = Path(path)
        if not path.exists():
            return
        self.files.mkdir(parents=True, exist_ok=True)
        stored = f"{len(self.saved):06d}{path.suffix}"
        shutil.move(str(path), str(self.files / stored))
        self.saved.append([stored, str(path)])
        self._journal({"saved": [stored, str(path)]})

    def note_added(self, path):
        self.added.append(str(path))
        self._journal({"added": str(path)})

    def finish(self):
        """Publish: write the manifest (last, atomically), then drop the previous undo."""
        return _publish(self.dir, self.sections, self.mode, self.file_name, self.saved, self.added, slices=self.slices)

    def discard(self):
        """The import didn't land: put any moved file back and drop this candidate only
        (the published undo, if any, stays)."""
        _restore_files(self.dir, self.saved, self.added)
        shutil.rmtree(self.dir, ignore_errors=True)


def _publish(folder, sections, mode, file_name, saved, added, created_ms=None, slices=None):
    manifest = {
        "createdMs": created_ms or int(time.time() * 1000),
        "slices": slices or {},
        "sections": list(sections),
        "mode": mode,
        "fileName": str(file_name or "")[:200],
        "rev": _last_rev(),
        "saved": saved,
        "added": added,
    }
    temp = folder / f"{MANIFEST}.tmp"
    temp.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    os.replace(temp, folder / MANIFEST)
    for path in (folder / PENDING, folder / JOURNAL):
        path.unlink(missing_ok=True)
    root = folder.parent
    for other in root.iterdir():
        if other != folder and other.is_dir():
            shutil.rmtree(other, ignore_errors=True)
    return manifest


def _last_rev(conn=None):
    conn = conn or db.connection()
    return int(conn.execute("SELECT COALESCE(MAX(rev), 0) FROM changes").fetchone()[0])


def begin(sections=(), mode="", file_name="", *, slices=None):
    """Snapshot krc.db for this import into a new candidate folder (the published undo is
    left alone until finish()). -> UndoRecord. UndoError when the snapshot can't be
    written (the import then doesn't run, and the last undo stays)."""
    folder = undo_root() / f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    record = UndoRecord(folder, sections, mode, file_name, slices)
    try:
        folder.mkdir(parents=True, exist_ok=False)
        dest = sqlite3.connect(str(folder / BEFORE_DB))
        try:
            db.connection().backup(dest)
        finally:
            dest.close()
        (folder / PENDING).write_text(json.dumps({
            "sections": record.sections, "mode": mode, "fileName": record.file_name, "slices": record.slices,
            "createdMs": int(time.time() * 1000)}), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        shutil.rmtree(folder, ignore_errors=True)
        raise UndoError(f"Couldn't save the current state first, so nothing was imported ({exc}).") from exc
    return record


def _read_journal(folder):
    saved, added = [], []
    try:
        lines = (folder / JOURNAL).read_text(encoding="utf-8").splitlines()
    except OSError:
        return saved, added
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue  # a line cut short by the crash
        if isinstance(entry.get("saved"), list) and len(entry["saved"]) == 2:
            saved.append([str(entry["saved"][0]), str(entry["saved"][1])])
        elif isinstance(entry.get("added"), str):
            added.append(entry["added"])
    return saved, added


def recover():
    """At startup (no import running): settle every candidate an interrupted import left.
    Its import landed (COMMITTED_KEY names it): publish it, so it can be undone. It didn't:
    put back any file it holds and drop it. -> (published, dropped)."""
    root = undo_root()
    if not root.is_dir():
        return 0, 0
    row = db.connection().execute("SELECT value FROM settings WHERE key = ?", (COMMITTED_KEY,)).fetchone()
    committed = row[0] if row else ""
    published = dropped = 0
    for folder in sorted(root.iterdir(), key=lambda folder: folder.name):
        if not folder.is_dir() or _published(folder):
            continue
        saved, added = _read_journal(folder)
        if folder.name == committed and (folder / BEFORE_DB).is_file():
            try:
                pending = json.loads((folder / PENDING).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pending = {}
            _publish(folder, pending.get("sections") or [], pending.get("mode") or "",
                     pending.get("fileName") or "", saved, added, pending.get("createdMs"), slices=pending.get("slices"))
            published += 1
        else:
            _restore_files(folder, saved, added)
            shutil.rmtree(folder, ignore_errors=True)
            dropped += 1
    return published, dropped


def _sections_by_id():
    return {section.id: section for section in all_sections()}


def _stores(section_ids, by_id):
    """[(store, item or None)] for the sections."""
    return sorted({tuple(entry) for section_id in section_ids for entry in (getattr(by_id.get(section_id), "stores", ()) or ())},
                  key=lambda entry: (entry[0], entry[1] or ""))


def info():
    """The last import that can be undone -> {createdMs, sections, mode, fileName,
    changesSince}, or None."""
    folder = _current()
    if folder is None:
        return None
    try:
        manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    since = 0
    conn = db.connection()
    for store, item in _stores(manifest.get("sections", []), _sections_by_id()):
        clause, args = ("store = ? AND item_id = ?", (store, item)) if item else ("store = ?", (store,))
        since += int(conn.execute(f"SELECT COUNT(*) FROM changes WHERE rev > ? AND {clause}",
                                  (int(manifest.get("rev") or 0), *args)).fetchone()[0])
    return {key: manifest.get(key) for key in ("createdMs", "sections", "mode", "fileName")} | {"changesSince": since}


def _restore_files(folder, saved, added):
    for path in added:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError as exc:
            print(f"[KRC Bundle] undo: couldn't remove {Path(path).name}: {exc}")
    for stored, original in saved:
        source = folder / FILES_DIRNAME / stored
        if not source.exists():
            continue
        try:
            Path(original).parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(source), original)
        except OSError as exc:
            print(f"[KRC Bundle] undo: couldn't put back {Path(original).name}: {exc}")


def undo():
    """Undo the last import. -> {"sections", "rows", "files"}."""
    folder = _current()
    if folder is None:
        raise UndoError("There's no import to undo.")
    manifest = json.loads((folder / MANIFEST).read_text(encoding="utf-8"))
    by_id = _sections_by_id()
    section_ids = [section_id for section_id in manifest.get("sections", []) if section_id in by_id]
    slices = [piece for section_id in section_ids for piece in (manifest.get("slices", {}).get(section_id, by_id[section_id].slices) or ())]
    conn = db.connection()
    if conn.in_transaction:
        raise UndoError("A write is in progress; try again.")
    conn.execute("ATTACH DATABASE ? AS snap", (str(folder / BEFORE_DB),))
    rows = 0
    try:
        with db.write():
            conn.execute("PRAGMA defer_foreign_keys = ON")
            for table, where in slices:
                clause = f" WHERE {where}" if where else ""
                conn.execute(f"DELETE FROM main.{table}{clause}")
                rows += conn.execute(f"INSERT INTO main.{table} SELECT * FROM snap.{table}{clause}").rowcount
            for store, item in _stores(section_ids, by_id):
                db.note_change(conn, store, item or "", "restore", "undo import")
    finally:
        conn.execute("DETACH DATABASE snap")
    saved, added = manifest.get("saved", []), manifest.get("added", [])
    _restore_files(folder, saved, added)
    shutil.rmtree(folder, ignore_errors=True)
    for section_id in section_ids:
        refresh = getattr(by_id[section_id], "refresh", None)
        if refresh:
            refresh()
    return {"sections": section_ids, "rows": rows, "files": len(saved) + len(added)}
