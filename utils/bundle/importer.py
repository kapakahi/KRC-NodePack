"""Import a KRC bundle (UNIFIED_BUNDLE_GAMEPLAN.md stage 3).

An upload is stored once under a token (krc_nodes/bundle_uploads/<token>.zip, removed
after its import or after an hour) so a 2 GB bundle never travels twice. Then:

  1. plan, outside any transaction: every chosen section reads its folder, scans what it
     needs and stages its thumbnails; nothing is written.
  2. apply: every section's DB writes in ONE db.write() transaction (all or nothing).
  3. the staged thumbnail files move into place; each section's after() runs.

A failure in 1 or 2 changes nothing (the transaction rolls back, staging is discarded).
A preview runs only step 1, with a dry stager: nothing is written or copied.
"""
import re
import secrets
import shutil
import time
import zipfile
from pathlib import Path

from ..archive_guard import ArchiveGuardError, guard_archive_size, validate_archive_marker
from ..db import connection as db
from ..krc_paths import get_krc_nodes_dir
from .container import ARCHIVE_TYPE, BUNDLE_VERSION, SectionArchive
from .sections import all_sections
from . import undo
from .stager import Stager, staging_root

UPLOADS_DIRNAME = "bundle_uploads"
UPLOAD_TTL_S = 60 * 60
_TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
MODES = ("merge", "overwrite")


class BundleImportError(ValueError):
    """An import that can't run; the message is shown to the user."""


def uploads_dir():
    return Path(get_krc_nodes_dir()) / UPLOADS_DIRNAME


def prune_uploads(now=None):
    """Remove uploads older than UPLOAD_TTL_S."""
    now = time.time() if now is None else now
    folder = uploads_dir()
    if not folder.is_dir():
        return
    for path in folder.glob("*.zip"):
        try:
            if now - path.stat().st_mtime > UPLOAD_TTL_S:
                path.unlink()
        except OSError:
            pass


def _publish_after_failure(record):
    try:
        record.finish()
    except Exception as exc:  # noqa: BLE001 - startup recovery publishes it instead
        print(f"[KRC Bundle] couldn't save the undo of an import that landed ({exc}); it is kept for a restart")


def clean_leftovers():
    """At startup: no import can be running yet, so any staging folder is one an interrupted
    import left behind (ComfyUI stopped mid-import), uploads past their hour are dead, and
    an unpublished undo candidate is settled (undo.recover: published if its import
    landed, else dropped with its files put back). -> (staging folders removed, uploads removed)."""
    staging = 0
    root = staging_root()
    if root.is_dir():
        for folder in root.iterdir():
            shutil.rmtree(folder, ignore_errors=True)
            staging += 1
    folder = uploads_dir()
    before = len(list(folder.glob("*.zip"))) if folder.is_dir() else 0
    prune_uploads()
    after = len(list(folder.glob("*.zip"))) if folder.is_dir() else 0
    if staging or before > after:
        print(f"[KRC Bundle] removed leftovers: {staging} staging folder(s), {before - after} expired upload(s)")
    published, dropped = undo.recover()
    if published or dropped:
        print(f"[KRC Bundle] interrupted import: {published} undo kept, {dropped} unfinished undo dropped")
    return staging, before - after


def store_upload(temp_path):
    """Move a saved upload under a new token. -> token."""
    prune_uploads()
    folder = uploads_dir()
    folder.mkdir(parents=True, exist_ok=True)
    token = secrets.token_hex(16)
    Path(temp_path).replace(folder / f"{token}.zip")
    return token


def upload_path(token):
    """The stored upload for ``token``, or BundleImportError (bad, expired or used)."""
    token = str(token or "")
    path = uploads_dir() / f"{token}.zip"
    if not _TOKEN_RE.match(token) or not path.is_file():
        raise BundleImportError("That upload has expired. Choose the bundle again.")
    return path


def discard_upload(token):
    try:
        upload_path(token).unlink()
    except (BundleImportError, OSError):
        pass


def _check_bundle_version(marker):
    """A bundle made by a newer pack (its marker's versions.bundle) isn't read here."""
    versions = marker.get("versions") if isinstance(marker.get("versions"), dict) else {}
    try:
        version = int(versions.get("bundle", BUNDLE_VERSION))
    except (TypeError, ValueError):
        version = BUNDLE_VERSION + 1
    if version > BUNDLE_VERSION:
        raise ArchiveGuardError("This bundle was made by a newer KRC NodePack. Update KRC NodePack to import it.")


def _open_bundle(path):
    archive = zipfile.ZipFile(path, "r")
    try:
        guard_archive_size(archive)
        marker = validate_archive_marker(archive, ARCHIVE_TYPE)
        _check_bundle_version(marker)
    except Exception:
        archive.close()
        raise
    sections = marker.get("sections")
    if not isinstance(sections, dict):
        archive.close()
        raise ArchiveGuardError("The bundle's section list is missing")
    return archive, sections


def inspect_bundle(path):
    """-> [{id, counts, linkedOnly, known, choices?}] for the sections the bundle holds, in
    this machine's section order (unknown ones, e.g. a kit not installed here, last).
    ``choices`` = the items a section's subset picker offers (Section.choices)."""
    try:
        archive, sections = _open_bundle(path)
    except zipfile.BadZipFile as err:
        raise BundleImportError("That isn't a valid .zip file.") from err
    with archive:
        by_id = {section.id: section for section in all_sections()}
        order = list(by_id)
        known = set(order)
        listed = [section_id for section_id in order if section_id in sections]
        listed += sorted(str(section_id) for section_id in sections if section_id not in known)
        out = []
        for section_id in listed:
            entry = sections.get(section_id) if isinstance(sections.get(section_id), dict) else {}
            counts = entry.get("counts") if isinstance(entry.get("counts"), dict) else {}
            profile = {}
            if section_id == "prompt_vault":
                from ..prompt_profile_transfer import archive_profile
                profile = {"profile": archive_profile(SectionArchive(archive, section_id))}
            section = by_id.get(section_id)
            if section is not None and section.choices is not None:
                profile["choices"] = section.choices(SectionArchive(archive, section_id))
            out.append({
                **profile,
                "id": section_id,
                "counts": {str(key): int(value) for key, value in counts.items() if isinstance(value, int)},
                "linkedOnly": bool(entry.get("linkedOnly")),
                "known": section_id in known,
            })
        return out


def _plans(archive, sections, section_ids, mode, options, stager, selection=None):
    by_id = {section.id: section for section in all_sections()}
    plans = []
    for section_id in section_ids:
        section = by_id.get(section_id)
        if section is None or section.plan is None:
            raise BundleImportError(f"This machine can't import {section_id}")
        if section_id not in sections:
            raise BundleImportError(f"The bundle has no {section_id}")
        section_options = {**options, "selection": (selection or {}).get(section_id)}
        plans.append((section_id, section.plan(SectionArchive(archive, section_id), mode, section_options, stager)))
    return plans


def _check_request(section_ids, mode, selection=None):
    if mode not in MODES:
        raise BundleImportError(f"Unknown import mode: {mode}")
    section_ids = list(dict.fromkeys(str(s) for s in section_ids or []))
    if not section_ids:
        raise BundleImportError("Choose at least one section to import.")
    if selection is not None and (not isinstance(selection, dict)
                                  or not all(value is None or isinstance(value, dict) for value in selection.values())):
        raise BundleImportError("The import's selection is invalid")
    return section_ids


def preview_bundle(path, section_ids, mode="merge", history=True, prompt_profile=None, selection=None):
    """What importing ``section_ids`` would do, writing nothing (plans only, a dry stager).
    ``selection`` = {section id: subset}, as for export. -> {"sections": {id: summary}}."""
    section_ids = _check_request(section_ids, mode, selection)
    try:
        archive, sections = _open_bundle(path)
    except zipfile.BadZipFile as err:
        raise BundleImportError("That isn't a valid .zip file.") from err
    with archive:
        plans = _plans(archive, sections, section_ids, mode, {"history": bool(history), "promptProfile": prompt_profile},
                       Stager(dry=True), selection)
    return {"sections": {section_id: plan.summary for section_id, plan in plans}}


def import_bundle(path, section_ids, mode="merge", history=True, file_name="", prompt_profile=None, selection=None):
    """Import ``section_ids`` from the bundle at ``path`` (``selection`` = {section id:
    subset}, as for export). -> {"sections": {id: {summary, result}}, "files": {"placed",
    "removed"}, "undo": {...}}. Saves the state first for Undo last import (undo.py);
    ``file_name`` is what the Undo line calls the import."""
    section_ids = _check_request(section_ids, mode, selection)
    try:
        archive, sections = _open_bundle(path)
    except zipfile.BadZipFile as err:
        raise BundleImportError("That isn't a valid .zip file.") from err
    stager = Stager()
    record = None
    try:
        with archive:
            plans = _plans(archive, sections, section_ids, mode, {"history": bool(history), "promptProfile": prompt_profile},
                           stager, selection)
        record = undo.begin(section_ids, mode, file_name, slices={sid: getattr(plan, "slices", None) for sid, plan in plans if getattr(plan, "slices", None) is not None})
        with db.write() as conn:
            results = {section_id: plan.apply() for section_id, plan in plans}
            record.mark_committed(conn)   # a restart can tell this import landed
    except BaseException:
        stager.discard()
        if record is not None:
            record.discard()   # only this attempt's: the last import stays undoable
        raise
    # The import has landed: whatever happens now, publish its undo so it can be rolled back.
    try:
        placed, removed = stager.commit(record)
    except Exception as exc:  # noqa: BLE001
        _publish_after_failure(record)
        raise BundleImportError(f"The import landed, but placing its thumbnails failed ({exc}). "
                                "Undo last import can roll it back.") from exc
    try:
        manifest = record.finish()
    except Exception as exc:  # noqa: BLE001
        raise BundleImportError(f"The import landed, but its undo couldn't be saved ({exc}). "
                                "It will be offered again after a restart.") from exc
    for section_id, plan in plans:
        if plan.after:
            try:
                plan.after()
            except Exception as exc:  # noqa: BLE001 - the import itself has landed
                print(f"[KRC Bundle] {section_id}: after-import step failed: {exc}")
    return {
        "sections": {section_id: {"summary": plan.summary, "result": results[section_id]} for section_id, plan in plans},
        "files": {"placed": placed, "removed": removed},
        "undo": {"createdMs": manifest["createdMs"], "fileName": manifest["fileName"]},
    }
