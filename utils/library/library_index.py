"""Shared multi-root library-index skeleton for KRC library nodes.

Both LoRA Loadout and Model Library scan model roots the same way: walk each
root, keep one logical record per id, collapse content duplicates (oldest copy
canonical), and cache the result per root-set. Only the *scan descriptor*
diverges — supported extensions, how roots are discovered, and how a single file
becomes ``(library_id, record)``. That divergence is real (LoRA identity + SHA
stabilization vs generic in-memory model records), so each node subclasses
:class:`BaseLibraryIndex` and supplies those hooks; the skeleton below is shared.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (stage B4).

Folder-change detection (PATH_HEALING_GAMEPLAN.md step 1): a scan records every folder's
modification time, which changes when a file is added, removed or renamed in it. A
non-forced read checks those times (at most once per FOLDER_CHECK_WINDOW_S) and rescans
when something changed (at most once per MIN_RESCAN_INTERVAL_S), so a moved file is
found again without a manual Refresh. A root that goes missing (unplugged drive, offline
share) is "unavailable", not "moved": its records are kept, flagged ``unavailable``.

Run-time heal (step 2): a run doesn't do the folder check; it calls :meth:`heal` with the
ids it is about to load, which checks just those files and rescans once, only when one is
gone and folders changed since the last scan.

Push (step 3): a rescan triggered by a folder change or a heal that moved, added or removed
files sends one ``krc-library-healed`` websocket event to every open page:
``{lineage, scanId, moves: {id: {path, relativePath}}, added, removed}``. Every scan has a
``scanId``, and /library returns it, so the page whose request did the rescan doesn't
reload twice.
"""

import asyncio
import itertools
import os
import threading
import time
import uuid
from pathlib import Path

from .identity import add_detach_listener
from .thumbnails import thumbnail_listing_scope

# One scan lock per index class (lineage): concurrent requests wait for the running
# scan and then read its cache instead of walking the disk again in parallel.
_SCAN_LOCKS = {}
_SCAN_LOCKS_GUARD = threading.Lock()
# Per index class: bumped whenever a cached record changes in place (refresh_record, an
# in-place edit), so a scan that was walking at the time doesn't cache its older read.
_GENERATIONS = {}

# Folder-change detection. Steady state costs one stat per folder per window, never a
# rescan; a folder being written to continuously can't trigger more than one rescan per
# interval.
FOLDER_CHECK_WINDOW_S = 3.0
MIN_RESCAN_INTERVAL_S = 10.0
SLOW_FOLDER_CHECK_S = 0.25      # log a check slower than this (a slow network share)
_SLOW_LOG_INTERVAL_S = 60.0
_SLOW_LOGGED = {}

HEAL_EVENT = "krc-library-healed"
_SCAN_IDS = itertools.count(1)
# Differs per server process, so a change token never repeats across a restart (scan ids
# start from 1 again).
_PROCESS_TOKEN = uuid.uuid4().hex[:8]
# Server-side consumers of moves (Config Switcher rewrites its saved presets), called
# before the push goes out. See add_heal_listener.
_HEAL_LISTENERS = []


def add_heal_listener(listener):
    """Call `listener(moves)` with {library id: {path, relativePath}} whenever a heal or a
    folder rescan finds moved files, on whichever thread found them. Idempotent."""
    if listener not in _HEAL_LISTENERS:
        _HEAL_LISTENERS.append(listener)


def _announce(payload):
    """Tell the server-side listeners about any moves, then send the heal event to every
    open page. Safe from any thread (send_sync queues it on the server loop); the push is
    a no-op off the ComfyUI runtime."""
    if payload.get("moves"):
        for listener in list(_HEAL_LISTENERS):
            try:
                listener(payload["moves"])
            except Exception as exc:  # noqa: BLE001 — one consumer must not stop the push
                print(f"[KRC Library] heal listener failed: {exc}")
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(HEAL_EVENT, payload)
    except Exception:  # noqa: BLE001 — a missed push only means pages reload on their next read
        pass


def _scan_lock(cls):
    with _SCAN_LOCKS_GUARD:
        lock = _SCAN_LOCKS.get(cls)
        if lock is None:
            lock = _SCAN_LOCKS[cls] = threading.Lock()
        return lock


def resolve_output_dir():
    """ComfyUI's output directory (resolved), or None. Roots under it are scanned
    by neither node — that folder holds node-produced artifacts, not the library."""
    try:
        import folder_paths
    except ImportError:
        return None
    try:
        get_output = getattr(folder_paths, "get_output_directory", None)
        raw = get_output() if callable(get_output) else getattr(folder_paths, "output_directory", None)
        return Path(raw).resolve() if raw else None
    except Exception:
        return None


def is_under_output(root, output_dir):
    if not output_dir:
        return False
    try:
        resolved = Path(root).resolve()
    except Exception:
        return False
    return resolved == output_dir or output_dir in resolved.parents


def roots_for_folder_key(folder_paths, key):
    """Candidate roots for one ComfyUI folder key: the registered folder paths,
    plus the conventional ``models/<key>`` fallbacks. Not deduped or output-filtered
    (the caller does that, tracking its own per-record context)."""
    roots = []
    try:
        for path in folder_paths.get_folder_paths(key):
            roots.append(Path(path))
    except Exception:
        pass
    models_dir = getattr(folder_paths, "models_dir", None)
    if models_dir:
        roots.append(Path(models_dir) / key)
    base_path = getattr(folder_paths, "base_path", None)
    if base_path:
        roots.append(Path(base_path) / "models" / key)
    return roots


def _drop_all_caches():
    """A background rename confirm undid a re-attach: every lineage rescans on its next
    read so the file comes back as itself."""
    pending = list(BaseLibraryIndex.__subclasses__())
    while pending:
        cls = pending.pop()
        pending.extend(cls.__subclasses__())
        if "_cache" in cls.__dict__:
            cls._cache = {}


def announce_moves(index, moves):
    """Push moves found outside a rescan (e.g. Config Switcher found a stored path out of
    date against a current scan) in the same shape as a rescan's heal event. Pages that
    already hold this scan skip the reload; Config Switcher nodes rewrite their paths."""
    if moves:
        _announce({"lineage": index.LINEAGE, "scanId": index.scan_id, "moves": moves,
                   "added": 0, "removed": 0})


class BaseLibraryIndex:
    """Scan skeleton. A subclass MUST declare its own ``_cache = {}`` class attribute
    (so lineages don't share a cache) and implement the scan-descriptor hooks."""

    SUPPORTED_EXTENSIONS = frozenset()
    # Which library a heal event is about ("loras" / "models"); the browser routes it.
    LINEAGE = ""

    def __init__(self, roots):
        self.roots = roots
        self.records = {}
        self.errors = []
        # True when this instance's last refresh rescanned because folders changed.
        self.rescanned_for_changes = False
        # The id of the scan these records came from (see the module docstring).
        self.scan_id = 0

    # ── scan-descriptor hooks (subclass supplies) ──────────────────────────
    def _cache_key(self):
        raise NotImplementedError

    def _iter_roots(self):
        """Yield ``(root, root_meta)`` pairs; ``root_meta`` is per-root context
        (e.g. model_type) or None."""
        raise NotImplementedError

    def scan_file(self, path, root, root_meta, scan_state):
        """Turn one file into ``(library_id, record)``, or return None to skip.
        ``scan_state`` is whatever :meth:`_begin_scan` returned for this refresh."""
        raise NotImplementedError

    def _identity_store(self):
        """The node's IdentityStore, for the canonical-id fallback in :meth:`get`."""
        raise NotImplementedError

    def _begin_scan(self):
        """Per-refresh state handed to every ``scan_file`` call: one IdentityStore in
        batch mode, so a full scan reads the identity store once and writes it at most
        once (in :meth:`_end_scan`), instead of per file."""
        return self._identity_store().begin_batch()

    def _end_scan(self, scan_state):
        """Called after the walk, even when it failed part-way: flush the batched
        identity writes."""
        if scan_state is not None:
            scan_state.end_batch()

    def _on_missing_root(self, root, errors):
        """Called when a root doesn't exist. Default: silently skip."""

    def _post_scan(self, records):
        """Called after a fresh scan is cached. Default: nothing."""

    # ── shared skeleton ────────────────────────────────────────────────────
    @classmethod
    def note_record_changed(cls):
        """Call after changing a cached record in place (see :data:`_GENERATIONS`)."""
        with _SCAN_LOCKS_GUARD:
            _GENERATIONS[cls] = _GENERATIONS.get(cls, 0) + 1

    @classmethod
    def _generation(cls):
        return _GENERATIONS.get(cls, 0)

    def change_token(self):
        """A short string that changes whenever this index's records may have: a new scan
        (scan ids are unique within a process), an in-place record change, or a restart.
        Read it after ``loaded()``/``refresh()``. External API stage 8."""
        return f"{_PROCESS_TOKEN}.{self.scan_id}.{self._generation()}"

    def _adopt(self, cached):
        self.records = cached.get("records", {})
        self.errors = cached.get("errors", [])
        self.scan_id = cached.get("scanId", 0)
        return True

    def _adopt_cached(self, cache_key, check_folders=True):
        """Adopt the cached scan if it is still current. Inside the check window that's
        free; past it, the folders are stat'ed once (see :meth:`_folders_changed`). A
        change marks the entry stale, so it isn't adopted until a rescan replaces it.
        check_folders=False (runs) trusts the cache; :meth:`heal` checks the files."""
        cached = self._cache.get(cache_key)
        if cached is None or cached.get("stale"):
            return False
        if not check_folders:
            return self._adopt(cached)
        now = time.monotonic()
        if now - cached.get("checked_at", 0) < FOLDER_CHECK_WINDOW_S:
            return self._adopt(cached)
        cached["checked_at"] = now
        if self._folders_changed(cached) and now - cached.get("scanned_at", 0) >= MIN_RESCAN_INTERVAL_S:
            cached["stale"] = True
            return False
        return self._adopt(cached)

    def _cache_current_without_check(self, cache_key):
        """True (and adopted) when the cache can be used without touching the disk, so an
        async caller can answer on the event loop."""
        cached = self._cache.get(cache_key)
        if cached is None or cached.get("stale"):
            return False
        if time.monotonic() - cached.get("checked_at", 0) >= FOLDER_CHECK_WINDOW_S:
            return False
        return self._adopt(cached)

    def refresh(self, force=False, check_folders=True):
        cache_key = self._cache_key()
        self.rescanned_for_changes = False
        if not force and self._adopt_cached(cache_key, check_folders):
            return self.records
        with _scan_lock(type(self)):
            # A scan that finished while we waited already answers a non-forced read.
            if not force and self._adopt_cached(cache_key, check_folders):
                return self.records
            previous = self._cache.get(cache_key)
            reason = "forced" if force else ("folders" if previous else "cold")
            return self._scan(cache_key, reason=reason, previous=previous)

    async def refresh_async(self, force=False):
        """:meth:`refresh` off the event loop: a current cache returns at once; a folder
        check or a disk walk runs on a worker thread so the ComfyUI server stays
        responsive."""
        self.rescanned_for_changes = False
        if not force and self._cache_current_without_check(self._cache_key()):
            return self.records
        return await asyncio.get_running_loop().run_in_executor(None, self.refresh, force)

    def _folders_changed(self, cached):
        """Whether any folder recorded by the last scan changed (entry added, removed or
        renamed), vanished, or a missing root came back. Folders under a root that is
        missing now are skipped: an offline drive isn't a change."""
        started = time.monotonic()
        recorded_missing = set(cached.get("missing_roots") or ())
        unavailable = []
        changed = False
        for root, _ in self._iter_roots():
            root = Path(root)
            exists = root.exists()
            if str(root) in recorded_missing and exists:
                changed = True
                break
            if not exists and str(root) not in recorded_missing:
                unavailable.append(str(root))
        if not changed:
            for dirpath, mtime in (cached.get("folders") or {}).items():
                if any(dirpath == root or dirpath.startswith(root + os.sep) for root in unavailable):
                    continue
                try:
                    if os.stat(dirpath).st_mtime_ns != mtime:
                        changed = True
                        break
                except OSError:
                    changed = True
                    break
        elapsed = time.monotonic() - started
        if elapsed > SLOW_FOLDER_CHECK_S:
            # "Never logged" is -inf, not 0: time.monotonic() can start near 0 (it counts
            # from about process start on some platforms), and 0 would hide the first warning.
            last = _SLOW_LOGGED.get(type(self), float("-inf"))
            if started - last > _SLOW_LOG_INTERVAL_S:
                _SLOW_LOGGED[type(self)] = started
                print(f"[KRC Library] {type(self).__name__}: folder check took {int(elapsed * 1000)} ms "
                      f"over {len(cached.get('folders') or {})} folders (slow disk or network share?)")
        return changed

    @classmethod
    async def loaded(cls, force=False):
        """A new index with its records loaded (see :meth:`refresh_async`). Async route
        handlers use this instead of ``cls()`` so a cold cache never scans on the loop."""
        index = cls()
        await index.refresh_async(force=force)
        return index

    def _scan(self, cache_key, reason="forced", previous=None):
        # The scan runs off the event loop, so a route can clear the cache (rebind
        # ``_cache``) mid-walk after changing a record. Only store the result when that
        # didn't happen; otherwise this caller still gets it and the next read rescans.
        cache = type(self)._cache
        generation = self._generation()
        grouped = {}
        errors = []
        folders = {}
        missing_roots = []
        scan_state = self._begin_scan()
        try:
            with thumbnail_listing_scope():   # one listing per thumbnail dir, not a stat per file
                self._walk(grouped, errors, scan_state, folders, missing_roots)
        finally:
            self._end_scan(scan_state)

        records = self._collapse_duplicates(grouped)
        # Only the user's Refresh drops the records of a root that's gone (they may have
        # deleted it); any other scan keeps them, flagged, until the drive is back.
        if reason != "forced" and previous:
            self._keep_unavailable(records, previous.get("records") or {}, missing_roots)
        self.records = records
        self.errors = errors
        self.rescanned_for_changes = reason in ("folders", "heal")
        self.scan_id = next(_SCAN_IDS)
        if type(self)._cache is cache and self._generation() == generation:
            now = time.monotonic()
            cache[cache_key] = {
                "records": records,
                "errors": errors,
                "folders": folders,
                "missing_roots": missing_roots,
                "scanned_at": now,
                "checked_at": now,
                "scanId": self.scan_id,
            }
        if reason in ("folders", "heal"):
            print(f"[KRC Library] {type(self).__name__}: folders changed, rescanned ({len(records)} records)")
            self._announce_changes((previous or {}).get("records") or {}, records)
        self._post_scan(records)
        return records

    def _announce_changes(self, before, after):
        """Push what a folder/heal rescan changed to every open page (only if anything did)."""
        moves = {}
        for library_id, record in after.items():
            old = before.get(library_id)
            if old is not None and old.get("path") != record.get("path") and not record.get("unavailable"):
                moves[library_id] = {"path": record.get("path") or "", "relativePath": record.get("relative_path") or ""}
        added = sum(1 for library_id in after if library_id not in before)
        removed = sum(1 for library_id in before if library_id not in after)
        if moves or added or removed:
            _announce({"lineage": self.LINEAGE, "scanId": self.scan_id, "moves": moves,
                       "added": added, "removed": removed})

    def heal(self, ids):
        """Run-time path check for the records a run is about to load. Every id whose
        file is where the cache says costs one stat. If one is gone (moved, renamed,
        deleted, or its drive is offline), rescan once, and only when the folders
        changed since the last scan: a move always changes them, so a file that's simply
        gone doesn't rescan on every run. Afterwards self.records is current.
        -> {"healed": [ids now at a new path], "missing": [ids still not loadable]}"""
        ids = [library_id for library_id in dict.fromkeys(ids or ()) if library_id]
        if not ids:
            return {"healed": [], "missing": []}
        if not self.records:
            self.refresh(check_folders=False)
        before = {library_id: self.get(library_id) for library_id in ids}
        if not any(self._dead(record) for record in before.values()):
            return {"healed": [], "missing": []}

        cls = type(self)
        cache_key = self._cache_key()
        cached = cls._cache.get(cache_key)
        if cached is None or cached.get("stale") or self._folders_changed(cached):
            with _scan_lock(cls):
                current = cls._cache.get(cache_key)
                if current is not None and current is not cached and not current.get("stale"):
                    self._adopt(current)   # another caller rescanned while we waited
                else:
                    self._scan(cache_key, reason="heal", previous=cached)

        healed, missing = [], []
        for library_id, old in before.items():
            record = self.get(library_id)
            if self._dead(record):
                missing.append(library_id)
            elif old is not None and old.get("path") != record.get("path"):
                healed.append(library_id)
        if healed:
            print(f"[KRC Library] {cls.__name__}: healed {len(healed)} moved file path(s)")
        return {"healed": healed, "missing": missing}

    @staticmethod
    def _dead(record):
        """A record a run can't load: unknown, on an offline root, or its file gone."""
        if record is None or record.get("unavailable"):
            return True
        return not os.path.isfile(record.get("path") or "")

    @staticmethod
    def _keep_unavailable(records, previous_records, missing_roots):
        if not missing_roots:
            return
        prefixes = [root.rstrip(os.sep) + os.sep for root in missing_roots]
        for library_id, record in previous_records.items():
            if library_id in records:
                continue
            path = str(record.get("path") or "")
            if any(path.startswith(prefix) for prefix in prefixes):
                kept = dict(record)
                kept["unavailable"] = True
                records[library_id] = kept

    def refresh_record(self, library_id):
        """Re-read one record (sidecar, identity, thumbnails) into the cached scan after a
        change to that one item, instead of clearing the whole cache and walking every
        file again. Nothing to do when nothing is cached or the id isn't in the cache
        (e.g. a LoRA id on a Model Library route): no cached copy can be stale. Falls
        back to clearing the cache when the record's file is gone or has duplicate
        copies, or it now resolves to a different id (stabilize, reset). Returns the
        fresh record, or None."""
        cls = type(self)
        cls.note_record_changed()
        cached = cls._cache.get(self._cache_key())
        records = cached.get("records") if cached else None
        if not records:
            return None
        record = records.get(library_id)
        if record is None:
            library_id = self._identity_store().canonical_id(library_id)
            record = records.get(library_id)
            if record is None:
                return None
        located = None
        if not record.get("duplicate_paths"):
            path = Path(record.get("path") or "")
            if path.is_file():
                located = self._root_for(path)
        result = None
        if located is not None:
            root, root_meta = located
            scan_state = self._begin_scan()
            try:
                result = self.scan_file(path, root, root_meta, scan_state)
            except Exception:  # noqa: BLE001
                result = None
            finally:
                self._end_scan(scan_state)
        if not result or result[0] != library_id:
            cls._cache = {}
            self.records = {}
            return None
        records[library_id] = result[1]
        self.records = records
        return result[1]

    def _root_for(self, path):
        for root, root_meta in self._iter_roots():
            root = Path(root)
            if root in path.parents:
                return root, root_meta
        return None

    def _walk(self, grouped, errors, scan_state, folders=None, missing_roots=None):
        for root, root_meta in self._iter_roots():
            root = Path(root)
            if not root.exists():
                if missing_roots is not None:
                    missing_roots.append(str(root))
                self._on_missing_root(root, errors)
                continue
            for dirpath, _, filenames in os.walk(root):
                if folders is not None:
                    try:
                        folders[dirpath] = os.stat(dirpath).st_mtime_ns
                    except OSError:
                        pass
                for filename in filenames:
                    path = Path(dirpath) / filename
                    if path.suffix.lower() not in self.SUPPORTED_EXTENSIONS:
                        continue
                    try:
                        result = self.scan_file(path, root, root_meta, scan_state)
                        if result is None:
                            continue
                        library_id, record = result
                        # Collect every physical file that resolves to this id so
                        # true content duplicates (same file in two folders) are
                        # kept, not silently clobbered by whichever we walk last.
                        grouped.setdefault(library_id, []).append(record)
                    except Exception as exc:  # noqa: BLE001
                        errors.append(f"{path}: {exc}")

    def _collapse_duplicates(self, grouped):
        # One logical record per id. When several physical files share an id, the
        # OLDEST copy (by date_added, then file mtime, then path) becomes canonical,
        # so a live read of record["path"] always loads the oldest copy even if the
        # user never cleans up. The full path list rides along for the UI.
        records = {}
        for library_id, copies in grouped.items():
            copies.sort(key=lambda rec: (
                rec.get("date_added") or 0,
                rec.get("date_modified") or 0,
                rec.get("path") or "",
            ))
            canonical = copies[0]
            if len(copies) > 1:
                canonical = dict(canonical)
                canonical["duplicate_paths"] = [rec.get("path", "") for rec in copies]
            records[library_id] = canonical
        return records

    def all(self):
        if not self.records:
            self.refresh()
        return list(self.records.values())

    def get(self, library_id):
        if not self.records:
            self.refresh()
        record = self.records.get(library_id)
        if record:
            return record
        canonical = self._identity_store().canonical_id(library_id)
        if canonical and canonical != library_id:
            return self.records.get(canonical)
        return None


add_detach_listener(_drop_all_caches)
