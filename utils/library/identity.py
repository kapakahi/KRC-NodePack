"""Shared identity store for KRC library nodes.

The scanner starts with path-derived ``local-...`` ids; an explicit stabilize
action promotes one file to a content SHA256 and records an alias so later scans
resolve the same path/fingerprint back to the SHA id without re-hashing large
model files.

The store logic is identical across LoRA Loadout and Model Library; only the
lineage differs. Each node subclasses :class:`IdentityStore` and sets ``LINEAGE``
(``loras`` / ``models``); all other behaviour lives here once. The data lives in
krc.db (identity_aliases / identity_files, KRC_SQLITE_GAMEPLAN.md stage 3): ``load``
reads a lineage's rows, ``save`` writes only the aliases and file entries this store
changed since it loaded.
"""

import copy
import hashlib
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ..db import library as library_db

# Rename recovery (PATH_HEALING_GAMEPLAN.md step 5). A renamed file loses its fingerprint
# (the filename is part of it); size + modification time alone still pin it when exactly
# one known id has those AND its recorded file is gone. A content-hashed id is confirmed
# by hashing the file, right away up to this size, in the background above it.
RENAME_CONFIRM_MAX_BYTES = 2 * 1024 ** 3
_CONFIRM_POOL = None
_CONFIRM_POOL_GUARD = threading.Lock()
# Called after a background confirm detached a wrong re-attach (the library indexes drop
# their caches so the file is scanned again as itself).
_DETACH_LISTENERS = []


def add_detach_listener(listener):
    if listener not in _DETACH_LISTENERS:
        _DETACH_LISTENERS.append(listener)


def size_mtime_key(signature):
    if not isinstance(signature, dict):
        return ""
    size = int(signature.get("size") or 0)
    mtime = int(signature.get("mtime") or 0)
    if not size or not mtime:
        return ""
    return f"{size}|{mtime}"


def _confirm_later(make_store, relative_path, path, expected_sha, canonical_id):
    """Hash a large re-attached file off the scan; undo the re-attach on a mismatch. Must
    be submitted after the re-attach is saved (see IdentityStore._queue_confirm), or the
    job could find nothing to undo."""
    global _CONFIRM_POOL

    def job():
        try:
            actual = compute_sha256(path)
        except OSError:
            return
        if actual == expected_sha:
            return
        store = make_store()
        data = store.load()
        entry = data["files"].get(relative_path)
        if not isinstance(entry, dict) or store.canonical_id(entry.get("canonicalId")) != canonical_id:
            return
        store._pop_file(relative_path)
        legacy = entry.get("legacyId")
        if legacy and data["aliases"].get(legacy) == canonical_id:
            data["aliases"].pop(legacy, None)
        store.save()
        print(f"[KRC Library] {relative_path} turned out not to be {canonical_id} (hash differs); detached")
        for listener in list(_DETACH_LISTENERS):
            try:
                listener()
            except Exception:  # noqa: BLE001
                pass

    with _CONFIRM_POOL_GUARD:
        if _CONFIRM_POOL is None:
            _CONFIRM_POOL = ThreadPoolExecutor(max_workers=1, thread_name_prefix="krc-rename-confirm")
    _CONFIRM_POOL.submit(job)


def current_millis():
    return int(time.time() * 1000)


def file_birth_or_mtime(path):
    """Best stable "when did this file arrive" timestamp in ms, WITHOUT hashing.

    Prefers ``st_birthtime`` (creation time) where the filesystem reports it
    (macOS/APFS); falls back to ``st_mtime`` (the common Linux/ext4 case, which
    has no birthtime via Python stat). Used to seed ``krcFirstSeen`` for
    unstabilized records so "Date Added" is stable across rescans/restarts
    instead of resetting to the scan moment. Returns 0 if the file is unreadable.
    """
    try:
        stat = Path(path).stat()
    except OSError:
        return 0
    birth = getattr(stat, "st_birthtime", 0) or 0
    stamp = birth if birth > 0 else stat.st_mtime
    return int(stamp * 1000)


def is_local_library_id(value):
    return str(value or "").startswith("local-")


def file_signature(path, root=None):
    path = Path(path)
    try:
        stat = path.stat()
        size = int(stat.st_size)
        mtime = int(stat.st_mtime * 1000)
    except OSError:
        size = 0
        mtime = 0

    relative = path.name
    if root:
        try:
            relative = str(path.relative_to(root))
        except ValueError:
            relative = path.name

    return {
        "relativePath": relative,
        "filename": path.name,
        "size": size,
        "mtime": mtime,
    }


def fingerprint_key(signature):
    if not isinstance(signature, dict):
        return ""
    filename = str(signature.get("filename") or "").lower()
    size = int(signature.get("size") or 0)
    mtime = int(signature.get("mtime") or 0)
    if not filename or not size:
        return ""
    return f"{filename}|{size}|{mtime}"


def compute_sha256(path, chunk_size=1024 * 1024):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


class IdentityStore:
    LINEAGE = None  # "loras" / "models", set by each node's subclass

    def __init__(self):
        if not self.LINEAGE:
            raise NotImplementedError("IdentityStore subclass must set LINEAGE")
        self.data = None
        self._base = None  # what was loaded / last saved, to write only the changes
        # Batch mode (a full scan): saves are deferred to end_batch(), and lookups by
        # fingerprint / canonical id use in-memory indexes instead of looping over every
        # file entry per call.
        self._batch_depth = 0
        self._batch_dirty = False
        self._by_fingerprint = None   # fingerprint -> {canonicalId: count}
        self._by_canonical = None     # canonicalId -> {relativePath}
        self._by_size_mtime = None    # "size|mtime" -> {relativePath} (rename recovery)
        self._pending_confirms = []   # background rename confirms, submitted once saved

    def fresh(self):
        """A new store over the same lineage (it loads the stored state again)."""
        return type(self)()

    def load(self):
        if self.data is not None:
            return self.data
        aliases, files = library_db.identity_load(self.LINEAGE)
        self.data = {"schemaVersion": 1, "aliases": aliases, "files": files}
        self._base = copy.deepcopy(self.data)
        return self.data

    def save(self):
        data = self.load()
        if self._batch_depth:
            self._batch_dirty = True
            return data
        if self._base is None:  # data was set without load(): diff against what's stored
            aliases, files = library_db.identity_load(self.LINEAGE)
            self._base = {"aliases": aliases, "files": files}
        alias_sets, alias_deletes = library_db.diff_maps(self._base["aliases"], data["aliases"])
        file_sets, file_deletes = library_db.diff_maps(self._base["files"], data["files"])
        library_db.identity_apply(self.LINEAGE, alias_sets, alias_deletes, file_sets, file_deletes)
        self._base = copy.deepcopy(data)
        return data

    def begin_batch(self):
        """Defer saves until the matching :meth:`end_batch` (one write per scan instead
        of one per changed file). Returns self."""
        self._batch_depth += 1
        return self

    def end_batch(self):
        self._batch_depth = max(0, self._batch_depth - 1)
        if self._batch_depth:
            return self.load()
        self._by_fingerprint = None
        self._by_canonical = None
        self._by_size_mtime = None
        data = self.load()
        if self._batch_dirty:
            self._batch_dirty = False
            data = self.save()
        self._flush_confirms()
        return data

    def _queue_confirm(self, *args):
        """Background rename confirms start only once the re-attach is saved: at the end
        of the batch (a scan), or right away outside one."""
        self._pending_confirms.append(args)
        if not self._batch_depth:
            self._flush_confirms()

    def _flush_confirms(self):
        pending, self._pending_confirms = self._pending_confirms, []
        for args in pending:
            _confirm_later(*args)

    # ── file-entry indexes (batch mode only) ────────────────────────────────
    def _ensure_indexes(self):
        if not self._batch_depth or self._by_fingerprint is not None:
            return
        self._by_fingerprint = {}
        self._by_canonical = {}
        self._by_size_mtime = {}
        for key, entry in self.load()["files"].items():
            self._index_entry(key, entry, 1)

    def _index_entry(self, key, entry, delta):
        if self._by_fingerprint is None or not isinstance(entry, dict):
            return
        canonical = entry.get("canonicalId")
        if not canonical:
            return
        fp = fingerprint_key(entry)
        if fp:
            bucket = self._by_fingerprint.setdefault(fp, {})
            count = bucket.get(canonical, 0) + delta
            if count > 0:
                bucket[canonical] = count
            else:
                bucket.pop(canonical, None)
        keys = self._by_canonical.setdefault(canonical, set())
        sized = self._by_size_mtime.setdefault(size_mtime_key(entry), set()) if size_mtime_key(entry) else None
        if delta > 0:
            keys.add(key)
            if sized is not None:
                sized.add(key)
        else:
            keys.discard(key)
            if sized is not None:
                sized.discard(key)

    def _set_file(self, key, entry):
        files = self.load()["files"]
        self._index_entry(key, files.get(key), -1)
        files[key] = entry
        self._index_entry(key, entry, 1)

    def _pop_file(self, key):
        entry = self.load()["files"].pop(key, None)
        self._index_entry(key, entry, -1)
        return entry

    def _fingerprint_ids(self, fp):
        self._ensure_indexes()
        if self._by_fingerprint is not None:
            return list(self._by_fingerprint.get(fp, {}))
        return [
            entry["canonicalId"]
            for entry in self.load()["files"].values()
            if isinstance(entry, dict) and entry.get("canonicalId") and fingerprint_key(entry) == fp
        ]

    def _size_mtime_keys(self, key):
        self._ensure_indexes()
        if self._by_size_mtime is not None:
            return list(self._by_size_mtime.get(key, ()))
        return [
            file_key for file_key, entry in self.load()["files"].items()
            if isinstance(entry, dict) and entry.get("canonicalId") and size_mtime_key(entry) == key
        ]

    def _file_keys_for(self, canonical_id):
        self._ensure_indexes()
        if self._by_canonical is not None:
            return list(self._by_canonical.get(canonical_id, ()))
        return [
            key for key, value in self.load()["files"].items()
            if isinstance(value, dict) and value.get("canonicalId") == canonical_id
        ]

    def canonical_id(self, library_id):
        data = self.load()
        current = str(library_id or "")
        seen = set()
        while current and current not in seen:
            seen.add(current)
            nxt = data["aliases"].get(current)
            if not nxt or nxt == current:
                return current
            current = str(nxt)
        return str(library_id or "")

    def resolve(self, library_id, signature=None, root=None):
        """The id a scanned file should have: its alias target, the id recorded for its
        path, the one id with its fingerprint (a move), or, given the scan `root`, the
        one lost id with its size + mtime (a rename; see :meth:`_renamed_from`)."""
        canonical = self.canonical_id(library_id)
        if canonical != library_id:
            return canonical

        if not is_local_library_id(library_id):
            return canonical

        data = self.load()
        relative_path = str((signature or {}).get("relativePath") or "")
        if relative_path:
            entry = data["files"].get(relative_path)
            entry_id = self.canonical_id(entry.get("canonicalId")) if isinstance(entry, dict) else ""
            if entry_id:
                return entry_id

        fp = fingerprint_key(signature)
        if fp:
            matches = sorted(set(
                match for match in (self.canonical_id(cid) for cid in self._fingerprint_ids(fp)) if match
            ))
            if len(matches) == 1:
                return matches[0]
            if matches:
                return canonical   # ambiguous fingerprint: don't guess further
        return self._renamed_from(signature, root) or canonical

    def _renamed_from(self, signature, root):
        """Rename recovery: the id this new path had under its old name, or "".

        Candidates are known files with the same size + mtime whose recorded file is gone
        (still there = a copy, not a rename). Exactly one id must remain. A content-hashed
        id is confirmed by hashing the new file (in the background above
        RENAME_CONFIRM_MAX_BYTES, undone on a mismatch); a local- id has no hash, so the
        unique size + millisecond-mtime match of a lost file is the evidence. The old
        entry is dropped so the id keeps one path."""
        key = size_mtime_key(signature)
        relative_path = str((signature or {}).get("relativePath") or "")
        if root is None or not key or not relative_path:
            return ""
        root = Path(root)
        files = self.load()["files"]
        candidates = {}
        for old_key in self._size_mtime_keys(key):
            entry = files.get(old_key)
            if old_key == relative_path or not isinstance(entry, dict):
                continue
            if (root / old_key).exists():
                continue
            canonical = self.canonical_id(entry.get("canonicalId"))
            if canonical:
                candidates.setdefault(canonical, []).append((old_key, entry))
        if len(candidates) != 1:
            return ""
        canonical, lost = next(iter(candidates.items()))
        path = root / relative_path
        if not is_local_library_id(canonical):
            expected = str(lost[0][1].get("sha256") or canonical)
            if int(signature.get("size") or 0) <= RENAME_CONFIRM_MAX_BYTES:
                try:
                    if compute_sha256(path) != expected:
                        return ""
                except OSError:
                    return ""
        for old_key, _entry in lost:
            self._pop_file(old_key)
        self.save()
        if not is_local_library_id(canonical) and int(signature.get("size") or 0) > RENAME_CONFIRM_MAX_BYTES:
            self._queue_confirm(self.fresh, relative_path, path, expected, canonical)
        print(f"[KRC Library] re-attached renamed file: {lost[0][0]} -> {relative_path}")
        return canonical

    def remember_file(self, canonical_id, legacy_id, signature=None, sha256=""):
        canonical_id = str(canonical_id or "").strip()
        if not canonical_id:
            return self.load()

        data = self.load()
        changed = False
        if legacy_id and legacy_id != canonical_id:
            legacy_id = str(legacy_id)
            if data["aliases"].get(legacy_id) != canonical_id:
                data["aliases"][legacy_id] = canonical_id
                changed = True

        signature = signature if isinstance(signature, dict) else {}
        relative_path = str(signature.get("relativePath") or "")
        if relative_path:
            entry = dict(signature)
            entry["canonicalId"] = canonical_id
            entry["legacyId"] = str(legacy_id or "")
            entry["sha256"] = sha256 or canonical_id
            existing = data["files"].get(relative_path)
            comparable_existing = {k: v for k, v in existing.items() if k != "updated"} if isinstance(existing, dict) else {}
            if comparable_existing != entry:
                entry["updated"] = current_millis()
                self._set_file(relative_path, entry)
                changed = True
        return self.save() if changed else data

    def remember_path(self, library_id, signature=None):
        """Record the current path + fingerprint for a path-derived (local-) id
        without creating an alias.

        A never-stabilized local id otherwise has no `files` entry at all, so a
        move orphans its metadata — there's nothing for `resolve`'s fingerprint
        fallback to match. Recording it here gives future scans both the fast
        relativePath lookup and a fingerprint to recover the id after a move,
        then re-homes the entry to the new path. The id itself is untouched, so
        the LoRA stays distinguishable as local and promotable to a content sha.
        """
        canonical_id = str(library_id or "").strip()
        signature = signature if isinstance(signature, dict) else {}
        relative_path = str(signature.get("relativePath") or "")
        if not canonical_id or not relative_path:
            return self.load()

        data = self.load()
        entry = dict(signature)
        entry["canonicalId"] = canonical_id
        entry["sha256"] = str(signature.get("sha256") or canonical_id)

        # Steady state (file didn't move) is the common case: bail in O(1) when
        # the stored entry already matches, so a full scan doesn't pay the prune
        # below for every unchanged local LoRA.
        existing = data["files"].get(relative_path)
        comparable_existing = {k: v for k, v in existing.items() if k != "updated"} if isinstance(existing, dict) else None
        if comparable_existing == entry:
            return data

        # The path changed (or is new): drop any stale entry pointing at this id
        # from a previous location so the `files` map holds one path per id.
        for key in self._file_keys_for(canonical_id):
            if key != relative_path:
                self._pop_file(key)

        entry["updated"] = current_millis()
        self._set_file(relative_path, entry)
        return self.save()

    def forget_identity(self, library_id, relative_path=""):
        data = self.load()
        library_id = str(library_id or "")
        relative_path = str(relative_path or "")
        changed = False

        for key, value in list(data["aliases"].items()):
            if key == library_id or value == library_id:
                data["aliases"].pop(key, None)
                changed = True

        if relative_path and relative_path in data["files"]:
            self._pop_file(relative_path)
            changed = True

        for key, value in list(data["files"].items()):
            if isinstance(value, dict) and (value.get("canonicalId") == library_id or value.get("legacyId") == library_id):
                self._pop_file(key)
                changed = True

        return self.save() if changed else data
