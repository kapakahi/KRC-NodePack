"""Thumbnail files for a two-phase import (UNIFIED_BUNDLE_GAMEPLAN.md stage 3).

During plan, a section copies each thumbnail it will place into a staging folder (on the
same disk as the thumbnails, under krc_nodes) and notes the files it will remove. Nothing
on disk changes until the import's DB transaction has committed; then commit() removes the
noted files and moves the staged ones into place (each an atomic rename). A failed
import calls discard(), which only deletes the staging folder. A preview uses a dry Stager:
it notes what would be placed and copies nothing.
"""
import os
import secrets
import shutil
from pathlib import Path

from ..krc_paths import get_krc_nodes_dir

STAGING_DIRNAME = "bundle_staging"


def staging_root():
    return Path(get_krc_nodes_dir()) / STAGING_DIRNAME


class Stager:
    def __init__(self, root=None, dry=False):
        self.dir = Path(root or staging_root()) / secrets.token_hex(8)
        self.dry = dry
        self.places = {}   # target -> staged file (None when dry)
        self.removes = []  # files to delete (unless something is placed there)

    def stage(self, archive, name, target):
        """Copy archive member ``name`` to the staging folder, to be moved to ``target``."""
        if self.dry:
            self.places[Path(target)] = None
            return None
        self.dir.mkdir(parents=True, exist_ok=True)
        staged = self.dir / f"{len(self.places):06d}{Path(str(target)).suffix}"
        with archive.open(name) as source, staged.open("wb") as handle:
            shutil.copyfileobj(source, handle)
        self.places[Path(target)] = staged
        return staged

    def stage_bytes(self, data, target):
        """Stage ``data`` (bytes) to be written to ``target`` (a KRC pack section's file)."""
        if self.dry:
            self.places[Path(target)] = None
            return None
        self.dir.mkdir(parents=True, exist_ok=True)
        staged = self.dir / f"{len(self.places):06d}{Path(str(target)).suffix}"
        staged.write_bytes(bytes(data))
        self.places[Path(target)] = staged
        return staged

    def remove(self, path):
        self.removes.append(Path(path))

    def will_exist(self, path):
        """Whether ``path`` will be there after commit (placed, or kept and not removed)."""
        path = Path(path)
        if path in self.places:
            return True
        return path.exists() and path not in self.removes

    def commit(self, undo=None):
        """Apply the file changes. -> (placed, removed). Best effort per file: the DB has
        already committed, so a file that fails is logged and the rest go on. With an
        ``undo`` record (undo.py), every file replaced or removed is moved into it first and
        every new one is noted, so Undo last import can put them back."""
        if self.dry:
            raise RuntimeError("A dry (preview) Stager never commits")
        placed = removed = 0
        for path in self.removes:
            if path in self.places:
                continue  # replaced below
            try:
                if path.exists():
                    if undo is not None:
                        undo.keep(path)
                    else:
                        path.unlink()
                    removed += 1
            except OSError as exc:
                print(f"[KRC Bundle] couldn't remove {path.name}: {exc}")
        for target, staged in self.places.items():
            try:
                target.parent.mkdir(parents=True, exist_ok=True)
                if undo is not None:
                    if target.exists():
                        undo.keep(target)
                    else:
                        undo.note_added(target)
                os.replace(staged, target)
                placed += 1
            except OSError as exc:
                print(f"[KRC Bundle] couldn't place {target.name}: {exc}")
        self.discard()
        return placed, removed

    def discard(self):
        shutil.rmtree(self.dir, ignore_errors=True)
