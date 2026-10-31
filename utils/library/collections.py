"""Shared, cross-node Collections store for KRC library nodes.

A **Collection** links a mix of models and LoRAs into a named, stable-id set. It is pure
*membership*: no shared metadata, no roles (unlike the removed metadata-pairing model it
replaces). Members are canonical library ids — a stabilized ``sha256`` in practice, since
joining is gated on a stabilized file. A file may belong to many collections.

The store is **node-neutral**: one store for both libraries (krc.db's ``collections`` table,
one row per collection; ``collections.json`` under the KRC nodes root before
KRC_SQLITE_GAMEPLAN.md stage 3), because a collection spans Model Library models AND LoRA
Loadout LoRAs in a single id space. Membership lives ONLY here — nothing is written onto a
member's record, so the per-file metadata schema gains no collection field.

See ``COLLECTIONS_GAMEPLAN.md``. Data layout (also the bundle's ``collections.json``)::

    {
      "schemaVersion": 1,
      "collections": {
        "<collectionId>": {
          "id": "collection-<hex>",
          "name": "WAN 2.2 I2V Kit",
          "pinned": false,
          "createdMs": 0,
          "modifiedMs": 0,
          "members": ["<canonicalId>", ...]
        }
      }
    }
"""

import copy
import threading
import time
import uuid

from ..db import library as library_db
from ..krc_paths import get_krc_nodes_dir

COLLECTIONS_FILENAME = "collections.json"
SCHEMA_VERSION = 1

# Read-modify-write mutations are serialized so two concurrent aiohttp requests can't clobber
# each other's change to the (small) shared file. Re-entrant so a mutation may call save().
_LOCK = threading.RLock()


def current_millis():
    return int(time.time() * 1000)


def new_collection_id():
    """A stable, dedicated id — not derived from any member, so it survives every member being
    removed/re-added or re-hashed."""
    return "collection-" + uuid.uuid4().hex[:16]


def get_krc_collections_path():
    """The pre-database collections file, read once by the stage-3 import."""
    return get_krc_nodes_dir() / COLLECTIONS_FILENAME


def _dedupe_members(members):
    """Order-preserving de-dupe of non-empty string member ids."""
    out = []
    seen = set()
    for raw in members or []:
        key = str(raw or "").strip()
        if key and key not in seen:
            seen.add(key)
            out.append(key)
    return out


def normalize_record(record, fallback_id=""):
    """Coerce a raw dict into the canonical collection shape (defensive on load + create)."""
    record = record if isinstance(record, dict) else {}
    cid = str(record.get("id") or fallback_id or "").strip()
    created = int(record.get("createdMs") or 0)
    modified = int(record.get("modifiedMs") or 0)
    return {
        "id": cid,
        "name": str(record.get("name") or "").strip(),
        "pinned": bool(record.get("pinned")),
        "cardColor": str(record.get("cardColor") or "").strip(),
        "createdMs": created,
        "modifiedMs": modified or created,
        "members": _dedupe_members(record.get("members")),
    }


def normalize_collections(raw_collections):
    """{id: record} with every record normalized; records without an id are dropped."""
    collections = {}
    if isinstance(raw_collections, dict):
        for cid, record in raw_collections.items():
            norm = normalize_record(record, fallback_id=cid)
            if norm["id"]:
                collections[norm["id"]] = norm
    return collections


class CollectionStore:
    """Load/save wrapper over the collections rows, mirroring ``IdentityStore``: ``save``
    writes only the collections changed since this store loaded.

    Constructed fresh per request (like ``FolderColorStore``), so it never serves a stale copy.
    """

    def __init__(self):
        self.data = None
        self._base = None

    # ---- persistence -----------------------------------------------------------------
    def load(self):
        if self.data is not None:
            return self.data
        collections = normalize_collections(library_db.collections_load())
        self.data = {"schemaVersion": SCHEMA_VERSION, "collections": collections}
        self._base = copy.deepcopy(collections)
        return self.data

    def save(self):
        data = self.load()
        with _LOCK:
            base = self._base if self._base is not None else normalize_collections(library_db.collections_load())
            sets, deletes = library_db.diff_maps(base, data["collections"])
            library_db.collections_apply(sets, deletes)
            self._base = copy.deepcopy(data["collections"])
        return data

    # ---- queries ---------------------------------------------------------------------
    def collections(self):
        return self.load()["collections"]

    def get(self, collection_id):
        return self.collections().get(str(collection_id or "")) if collection_id else None

    def ordered(self):
        """Records in display order: pinned first, then case-insensitive name, then id."""
        records = list(self.collections().values())
        records.sort(key=lambda r: (0 if r.get("pinned") else 1, str(r.get("name") or "").lower(), r.get("id") or ""))
        return records

    def membership_index(self):
        """Reverse index ``canonicalId -> [collectionId, ...]`` (each list in display order).

        Powers the InfoPanel "which collections am I in?" without scanning every record per card.
        """
        index = {}
        for record in self.ordered():
            cid = record["id"]
            for member in record.get("members") or []:
                index.setdefault(member, []).append(cid)
        return index

    def collections_for_member(self, member_id):
        member_id = str(member_id or "").strip()
        if not member_id:
            return []
        return [r["id"] for r in self.ordered() if member_id in (r.get("members") or [])]

    # ---- mutations -------------------------------------------------------------------
    def create(self, name="", members=None, pinned=False, collection_id=None):
        with _LOCK:
            cid = str(collection_id or new_collection_id())
            now = current_millis()
            record = normalize_record(
                {
                    "id": cid,
                    "name": name,
                    "pinned": pinned,
                    "createdMs": now,
                    "modifiedMs": now,
                    "members": members,
                },
                fallback_id=cid,
            )
            self.collections()[cid] = record
            self.save()
            return record

    def rename(self, collection_id, name):
        with _LOCK:
            record = self.get(collection_id)
            if not record:
                return None
            record["name"] = str(name or "").strip()
            record["modifiedMs"] = current_millis()
            self.save()
            return record

    def set_pinned(self, collection_id, pinned):
        with _LOCK:
            record = self.get(collection_id)
            if not record:
                return None
            record["pinned"] = bool(pinned)
            record["modifiedMs"] = current_millis()
            self.save()
            return record

    def set_color(self, collection_id, card_color):
        with _LOCK:
            record = self.get(collection_id)
            if not record:
                return None
            record["cardColor"] = str(card_color or "").strip()
            record["modifiedMs"] = current_millis()
            self.save()
            return record

    def delete(self, collection_id):
        with _LOCK:
            removed = self.collections().pop(str(collection_id or ""), None)
            if removed is not None:
                self.save()
            return removed

    def add_member(self, collection_id, member_id):
        with _LOCK:
            record = self.get(collection_id)
            member_id = str(member_id or "").strip()
            if not record or not member_id:
                return None
            if member_id not in record["members"]:
                record["members"].append(member_id)
                record["modifiedMs"] = current_millis()
                self.save()
            return record

    def remove_member(self, collection_id, member_id):
        with _LOCK:
            record = self.get(collection_id)
            member_id = str(member_id or "").strip()
            if not record or not member_id:
                return None
            if member_id in record["members"]:
                record["members"].remove(member_id)
                record["modifiedMs"] = current_millis()
                self.save()
            return record

    def import_records(self, records, mode="merge"):
        """Apply collections from a Model Library bundle (IMPORT_EXPORT_PAGE_GAMEPLAN.md §4),
        keyed by collection id. Local-only collections are never touched.

        merge     — a new id is added; an existing one gains the imported members it lacks
                    (local order first) and keeps its local name / pin / color, only filling
                    the ones that are empty.
        overwrite — an imported collection replaces the local one with the same id.

        Members not present on this machine are kept (membership is by canonical id).
        Returns the number of collections added or changed."""
        overwrite = mode == "overwrite"
        with _LOCK:
            collections = self.collections()
            changed = 0
            now = current_millis()
            for raw in records or []:
                incoming = normalize_record(raw)
                cid = incoming["id"]
                if not cid:
                    continue
                if not incoming["createdMs"]:
                    incoming["createdMs"] = incoming["modifiedMs"] = now
                local = collections.get(cid)
                if local is None:
                    collections[cid] = incoming
                    changed += 1
                    continue
                if overwrite:
                    if incoming != local:
                        collections[cid] = incoming
                        changed += 1
                    continue
                merged = dict(local)
                merged["members"] = _dedupe_members(local["members"] + incoming["members"])
                for key in ("name", "cardColor"):
                    if not merged.get(key) and incoming.get(key):
                        merged[key] = incoming[key]
                if merged != local:
                    merged["modifiedMs"] = now
                    collections[cid] = merged
                    changed += 1
            if changed:
                self.save()
            return changed

    def rename_member(self, old_id, new_id):
        """Swap a member id everywhere it appears — the hook for an ``IDENTITY_CHANGED`` id
        promotion (local-id → sha, or alias reconverge) so a membership survives re-hash.
        Returns True if any collection changed."""
        old_id = str(old_id or "").strip()
        new_id = str(new_id or "").strip()
        if not old_id or not new_id or old_id == new_id:
            return False
        with _LOCK:
            changed = False
            for record in self.collections().values():
                members = record.get("members") or []
                if old_id in members:
                    record["members"] = _dedupe_members([new_id if m == old_id else m for m in members])
                    record["modifiedMs"] = current_millis()
                    changed = True
            if changed:
                self.save()
            return changed
