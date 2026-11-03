"""Model Library's Clean stale records: saved model records (metadata, thumbnails,
identity entries) whose file is no longer in the library. LoRA Loadout's own version
is lora_loadout/identity_records.stale_identity_records; the route lists both."""

from ..db import library as library_db
from .identity import IdentityStore
from .metadata import get_krc_model_base_dir, read_model_metadata, safe_id
from .thumbnails import delete_model_thumbnail


def _thumbnail_ids():
    ids = set()
    for name in ("thumbnails", "animated_thumbnails"):
        base = get_krc_model_base_dir() / name
        if base.exists():
            ids.update(path.stem for path in base.rglob("*") if path.is_file())
    return ids


def _identity_ids(identities):
    ids = set()
    aliases = identities.get("aliases", {})
    if isinstance(aliases, dict):
        for old_id, new_id in aliases.items():
            ids.update((str(old_id), str(new_id)))
    files = identities.get("files", {})
    if isinstance(files, dict):
        for entry in files.values():
            if isinstance(entry, dict):
                ids.update(str(entry[key]) for key in ("canonicalId", "legacyId") if entry.get(key))
    return ids


def _last_known(store, library_id):
    meta = read_model_metadata(library_id) or {}
    relative = str(meta.get("file") or "")
    if not relative:
        for rel, entry in store.load().get("files", {}).items():
            if isinstance(entry, dict) and library_id in (entry.get("canonicalId"), entry.get("legacyId")):
                relative = str(rel)
                break
    name = str(meta.get("name") or "") or (relative.rsplit("/", 1)[-1].rsplit(".", 1)[0] if relative else "")
    return {
        "id": library_id,
        "known": bool(meta or relative),
        "name": name,
        "path": str(meta.get("path") or relative),
        "file": relative,
    }


def stale_model_records(live_ids):
    """Saved model records whose id no file in the library has, for review."""
    store = IdentityStore()
    live = {str(item) for item in live_ids if item}
    live.update(store.canonical_id(item) for item in list(live))
    candidates = set(library_db.metadata_ids(library_db.MODELS)) | _thumbnail_ids() | _identity_ids(store.load())
    stale = {}
    for raw_id in candidates:
        if not raw_id:
            continue
        key = store.canonical_id(raw_id) or raw_id
        if raw_id in live or key in live:
            continue
        if key not in stale:
            stale[key] = _last_known(store, key)
    return sorted(stale.values(), key=lambda item: (
        str(item.get("path") or "").lower(), str(item.get("name") or "").lower(), item["id"]))


def purge_stale_model(library_id):
    """Delete one absent model's metadata, thumbnails and identity entries (and those of
    the ids aliased to it). The caller must confirm no file in the library has it."""
    library_id = str(library_id or "")
    if not library_id:
        return False
    store = IdentityStore()
    identities = store.load()
    related = {library_id, store.canonical_id(library_id)}
    for old_id, new_id in (identities.get("aliases") or {}).items():
        if old_id in related or new_id in related:
            related.update((str(old_id), str(new_id)))
    for related_id in related:
        delete_model_thumbnail(related_id)
        library_db.metadata_delete(library_db.MODELS, safe_id(related_id))
    for related_id in related:
        store.forget_identity(related_id)
    return True
