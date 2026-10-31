import shutil
from pathlib import Path

from .identity import IdentityStore, compute_sha256, file_signature, is_local_library_id
from .thumbnails import find_thumbnail, find_thumbnail_variant, get_krc_thumbnail_path, thumbnail_kind


def adopt_identity_files(old_id, new_id):
    if not old_id or not new_id or old_id == new_id:
        return

    from ..db import library as library_db
    from .metadata import safe_id

    library_db.metadata_copy(library_db.LORAS, "", safe_id(old_id), safe_id(new_id))

    old_thumb = get_krc_thumbnail_path(old_id)
    new_thumb = get_krc_thumbnail_path(new_id)
    if old_thumb.exists() and not new_thumb.exists():
        try:
            new_thumb.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old_thumb, new_thumb)
        except OSError:
            pass


def delete_identity_files(library_id):
    if not library_id:
        return

    from ..db import library as library_db
    from .metadata import safe_id
    from .thumbnails import KRC_THUMBNAIL_EXTENSIONS

    library_db.metadata_delete(library_db.LORAS, safe_id(library_id), type_dir="")
    for extension in KRC_THUMBNAIL_EXTENSIONS:
        thumbnail_path = get_krc_thumbnail_path(library_id, extension)
        try:
            if thumbnail_path.exists():
                thumbnail_path.unlink()
        except OSError:
            pass


def stale_identity_records(live_ids=None):
    """Return saved LL metadata/thumbnail/identity entries whose LoRA is absent.

    This is a review surface for bulk cleanup. It intentionally looks beyond
    presets: old records can exist only as a metadata record, a thumbnail, or an
    identity entry after a model has been deleted or moved outside all roots.
    """
    from ..db import library as library_db
    from .thumbnails import KRC_THUMBNAIL_EXTENSIONS, get_krc_animated_thumbnail_dir, get_krc_thumbnail_dir

    store = IdentityStore()
    identities = store.load()
    live = set(str(item or "") for item in (live_ids or []) if item)
    live.update(store.canonical_id(item) for item in list(live))

    candidates = set(library_db.metadata_ids(library_db.LORAS))

    for thumbnail_dir in (get_krc_thumbnail_dir(), get_krc_animated_thumbnail_dir()):
        if not thumbnail_dir.exists():
            continue
        candidates.update(
            path.stem
            for path in thumbnail_dir.iterdir()
            if path.is_file() and path.suffix.lower() in KRC_THUMBNAIL_EXTENSIONS
        )

    aliases = identities.get("aliases", {})
    if isinstance(aliases, dict):
        for old_id, new_id in aliases.items():
            candidates.add(str(old_id))
            candidates.add(str(new_id))

    files = identities.get("files", {})
    if isinstance(files, dict):
        for entry in files.values():
            if not isinstance(entry, dict):
                continue
            if entry.get("canonicalId"):
                candidates.add(str(entry["canonicalId"]))
            if entry.get("legacyId"):
                candidates.add(str(entry["legacyId"]))

    stale = {}
    for raw_id in candidates:
        library_id = str(raw_id or "")
        if not library_id:
            continue
        canonical = store.canonical_id(library_id)
        if library_id in live or canonical in live:
            continue
        key = canonical or library_id
        info = last_known_identity(key)
        if not info or not info.get("known"):
            info = last_known_identity(library_id) or {"id": key, "known": False}
            info["id"] = key
        stale[key] = info

    return sorted(
        stale.values(),
        key=lambda item: (
            str(item.get("path") or item.get("file") or "").lower(),
            str(item.get("name") or "").lower(),
            str(item.get("id") or "").lower(),
        ),
    )


def last_known_identity(library_id):
    """Assemble the last-known details for an id that's no longer in the library.

    A missing LoRA's KRC metadata sidecar (<id>.json) and thumbnail survive the
    file's deletion, and the IdentityStore files map still holds its last-known
    relative path. This reads both so the UI can show a tombstone (path, name,
    thumbnail) instead of a bare hash. Returns {"id", "known": False} when
    nothing about the id was ever recorded.
    """
    from .metadata import read_krc_metadata

    library_id = str(library_id or "")
    if not library_id:
        return None

    meta = read_krc_metadata(library_id)
    path = str(meta.get("path") or "") if meta else ""
    relative = str(meta.get("file") or "") if meta else ""
    name = str(meta.get("name") or "") if meta else ""
    base_model = str(meta.get("baseModel") or "") if meta else ""
    category = str(meta.get("category") or "") if meta else ""
    description = str(meta.get("description") or "") if meta else ""

    if not path or not relative:
        for rel, entry in IdentityStore().load().get("files", {}).items():
            if isinstance(entry, dict) and library_id in (entry.get("canonicalId"), entry.get("legacyId")):
                relative = relative or str(rel)
                path = path or str(rel)
                break

    thumbnail = find_thumbnail(None, library_id, prefer_animated=True)
    poster = find_thumbnail_variant(library_id, "poster")
    animated = find_thumbnail_variant(library_id, "animated")
    has_thumbnail = thumbnail is not None
    if not (meta or path or has_thumbnail):
        return {"id": library_id, "known": False}

    return {
        "id": library_id,
        "known": True,
        "name": name or (Path(relative).stem if relative else ""),
        "path": path,
        "file": relative,
        "baseModel": base_model,
        "category": category,
        "description": description,
        "hasThumbnail": has_thumbnail,
        "thumbnailType": thumbnail_kind(thumbnail) if thumbnail else "image",
        "thumbnailHasPoster": bool(poster),
        "thumbnailHasAnimation": bool(animated),
    }


def purge_missing_identity(library_id):
    """Delete the orphaned KRC metadata, thumbnails, and identity entries for an
    id no longer in the library. The caller must confirm it isn't present."""
    library_id = str(library_id or "")
    if not library_id:
        return False
    store = IdentityStore()
    identities = store.load()
    canonical = store.canonical_id(library_id)
    related_ids = {library_id, canonical}
    aliases = identities.get("aliases", {})
    if isinstance(aliases, dict):
        for old_id, new_id in aliases.items():
            if old_id in related_ids or new_id in related_ids:
                related_ids.add(str(old_id))
                related_ids.add(str(new_id))
    files = identities.get("files", {})
    if isinstance(files, dict):
        for entry in files.values():
            if not isinstance(entry, dict):
                continue
            if entry.get("canonicalId") in related_ids or entry.get("legacyId") in related_ids:
                if entry.get("canonicalId"):
                    related_ids.add(str(entry["canonicalId"]))
                if entry.get("legacyId"):
                    related_ids.add(str(entry["legacyId"]))
    for related_id in related_ids:
        delete_identity_files(related_id)
    for related_id in related_ids:
        store.forget_identity(related_id)
    return True


def blank_record_metadata(record):
    """Reset one LoRA to a BLANK default record under a stabilized content-SHA id.

    A user-owned blank slate whose id is promoted to the file's content SHA256, so the
    empty record is stable, not path-derived. Marks userBlanked so the Civitai batch
    fill skips it; a Civitai fetch or HuggingFace import clears the flag."""
    if not record:
        return None

    from .metadata import current_millis, default_metadata, make_library_id, write_krc_metadata

    library_id = record.get("library_id") or ""
    path = Path(record.get("path") or "")
    relative_path = record.get("relative_path") or path.name
    fallback_id = make_library_id(Path(relative_path))

    # Stabilized id: the file's content SHA. Fall back to the existing/path id only if
    # the file can't be read.
    try:
        new_id = compute_sha256(str(path)).lower()
    except OSError:
        new_id = library_id or fallback_id

    # Drop all existing metadata + thumbnail variants for the old id (and the
    # path-derived fallback), and forget the identity alias so nothing re-imports.
    delete_identity_files(library_id)
    if fallback_id != library_id:
        delete_identity_files(fallback_id)
    IdentityStore().forget_identity(library_id, relative_path)

    metadata = default_metadata(path, new_id)
    metadata["sha256"] = new_id
    metadata["userBlanked"] = True
    if library_id and library_id != new_id:
        metadata["identityStabilizedFrom"] = library_id
        metadata["identityStabilizedAt"] = current_millis()

    write_krc_metadata(
        {
            "library_id": new_id,
            "relative_path": relative_path,
            "filename": path.name,
            "path": str(path),
        },
        metadata,
    )

    # Re-link the file's signature to the blank record's id so the very next library
    # scan resolves this file straight to new_id. Without this, the forget_identity
    # above leaves a no-sidecar LoRA resolving to a fresh local- id (a new default
    # record) on rescan — orphaning the blank record and showing the LoRA as "Missing"
    # in the preset stack until the async stabilization loop re-links it.
    if not is_local_library_id(new_id):
        try:
            signature = file_signature(path, None)
            signature["relativePath"] = relative_path
            IdentityStore().remember_file(new_id, library_id, signature, sha256=new_id)
        except OSError:
            pass

    return {"oldId": library_id, "newId": new_id, "source": "blank"}


def stabilize_record_identity(record):
    """Promote a path-derived local id to a content SHA id for one explicit save."""
    if not record or not is_local_library_id(record.get("library_id")):
        return record, None

    path = record.get("path")
    if not path:
        return record, None

    try:
        sha256 = compute_sha256(path)
    except OSError:
        return record, None

    old_id = record["library_id"]
    new_id = sha256.lower()
    if not new_id or new_id == old_id:
        return record, None

    from .metadata import current_millis, krc_metadata_exists, read_krc_metadata, write_krc_metadata

    signature = file_signature(path, None)
    signature["relativePath"] = record.get("relative_path") or signature["relativePath"]
    # Sampled before adopt (which copies old -> new only when new is absent): did a
    # canonical record already exist for this content? Decides the merge precedence below.
    sha_had_record = krc_metadata_exists(new_id)
    IdentityStore().remember_file(new_id, old_id, signature, sha256=new_id)
    adopt_identity_files(old_id, new_id)

    # Commit-time re-read. compute_sha256 above can take minutes on a large LoRA, during
    # which the user may have edited this record; the edit save wrote it to the still-
    # local-id record. Re-read that live state instead of the pre-hash in-memory
    # snapshot so a mid-stabilize edit survives promotion rather than being clobbered.
    live_old_sidecar = read_krc_metadata(old_id) or dict(record.get("sidecar_data") or {})
    if sha_had_record:
        # A pre-existing canonical record for this content wins over the local record.
        merged = {**live_old_sidecar, **read_krc_metadata(new_id)}
    else:
        # Fresh promotion: the live local sidecar (with any mid-hash edit) is authoritative.
        merged = dict(live_old_sidecar)
    merged["libraryId"] = new_id
    merged["sha256"] = new_id
    merged["identityPending"] = False  # now has a content SHA — no longer a seed
    merged["identityStabilizedFrom"] = old_id
    merged["identityStabilizedAt"] = current_millis()

    promoted = dict(record)
    promoted["library_id"] = new_id
    promoted["sha256"] = new_id
    promoted["sidecar_data"] = merged
    write_krc_metadata(promoted, merged)
    return promoted, {"oldId": old_id, "newId": new_id}
