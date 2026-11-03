"""Model Library identity promotion helpers."""

import shutil

from ..library.identity import content_id
from .identity import IdentityStore, file_signature, is_local_library_id
from ..db import library as library_db
from .metadata import (
    current_millis, metadata_dir_name_for_model_type, model_metadata_exists,
    model_type_dirs, read_model_metadata, safe_id, write_model_metadata,
)
from .thumbnails import get_model_thumbnail_path


def adopt_identity_files(old_id, new_id, model_type=None):
    if not old_id or not new_id or old_id == new_id:
        return

    type_dirs = [metadata_dir_name_for_model_type(model_type)] if model_type else model_type_dirs()
    for type_dir in type_dirs:
        library_db.metadata_copy(library_db.MODELS, type_dir, safe_id(old_id), safe_id(new_id))

    old_thumb = get_model_thumbnail_path(old_id, model_type)
    new_thumb = get_model_thumbnail_path(new_id, model_type)
    if old_thumb.exists() and not new_thumb.exists():
        try:
            new_thumb.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old_thumb, new_thumb)
        except OSError:
            pass


def delete_identity_files(library_id, model_type=None):
    if not library_id:
        return
    library_db.metadata_delete(
        library_db.MODELS, safe_id(library_id),
        type_dir=metadata_dir_name_for_model_type(model_type) if model_type else None)
    path = get_model_thumbnail_path(library_id, model_type)
    try:
        if path.exists():
            path.unlink()
    except OSError:
        pass


def blank_record_metadata(record):
    """Reset ID for a model: re-read the file and give it its own id (its content
    SHA256) and a BLANK default record, as LoRA Loadout's blank_record_metadata does.
    If another file still on disk uses the old id, that file keeps the id and its
    record; only this file is unlinked."""
    if not record:
        return None

    from pathlib import Path
    from ..library.identity import EMPTY_SHA256, file_root
    from .metadata import default_model_metadata, make_model_library_id

    library_id = record.get("library_id") or ""
    path = Path(record.get("path") or "")
    relative_path = record.get("relative_path") or path.name
    model_type = record.get("modelType") or (record.get("sidecar_data") or {}).get("modelType")
    fallback_id = make_model_library_id(Path(relative_path))
    root = file_root(path, relative_path)
    try:
        new_id = content_id(str(path))
    except OSError:
        new_id = ""
    new_id = new_id or (library_id if library_id != EMPTY_SHA256 else "") or fallback_id

    store = IdentityStore()
    shared = store.id_used_by_other_file(library_id, relative_path, root)
    if shared:
        store.release_file(relative_path, fallback_id)
    else:
        delete_identity_files(library_id, model_type)
        store.forget_identity(library_id, relative_path)
    if fallback_id != library_id:
        delete_identity_files(fallback_id, model_type)
    if new_id != library_id and not store.id_used_by_other_file(new_id, relative_path, root):
        delete_identity_files(new_id, model_type)

    metadata = default_model_metadata(path, new_id)
    metadata["sha256"] = new_id
    metadata["userBlanked"] = True
    if model_type:
        metadata["modelType"] = model_type
    if library_id and library_id != new_id and not shared:
        metadata["identityStabilizedFrom"] = library_id
        metadata["identityStabilizedAt"] = current_millis()
    write_model_metadata({
        "library_id": new_id,
        "relative_path": relative_path,
        "filename": path.name,
        "path": str(path),
        "modelType": model_type,
    }, metadata)

    # Same re-link as LoRA Loadout's: the next scan resolves this file straight to new_id.
    if not is_local_library_id(new_id):
        try:
            signature = file_signature(path, None)
            signature["relativePath"] = relative_path
            store.remember_file(new_id, fallback_id if shared else library_id, signature, sha256=new_id)
        except OSError:
            pass

    return {"oldId": library_id, "newId": new_id, "source": "blank", "shared": shared}


def stabilize_record_identity(record):
    """Promote one path-derived Model Library record to its content SHA256 id."""
    if not record or not is_local_library_id(record.get("library_id")):
        return record, None

    path = record.get("path")
    if not path:
        return record, None

    sha256 = content_id(path)
    old_id = record["library_id"]
    model_type = record.get("modelType") or (record.get("sidecar_data") or {}).get("modelType")
    if not sha256 or sha256 == old_id:
        return record, None

    signature = file_signature(path, None)
    signature["relativePath"] = record.get("relative_path") or signature["relativePath"]
    # Sampled before adopt (which copies old -> new only when new is absent): did a
    # canonical record already exist for this content? Decides the merge precedence below.
    # (With no model type the old check looked at a file that never existed: False.)
    sha_had_record = model_metadata_exists(sha256, model_type) if model_type else False
    IdentityStore().remember_file(sha256, old_id, signature, sha256=sha256)
    adopt_identity_files(old_id, sha256, model_type)

    # Commit-time re-read. compute_sha256 above can take minutes on a 20GB+ model, and the
    # user may have edited this record's metadata (title/description/thumbnail) during that
    # window — the edit save wrote it to the still-local-id record. Re-read that
    # live record now instead of trusting the pre-hash in-memory snapshot, so a mid-hash
    # edit is carried into the promoted record rather than clobbered by a stale copy.
    live_old_sidecar = read_model_metadata(old_id, model_type) or dict(record.get("sidecar_data") or {})
    if sha_had_record:
        # A pre-existing canonical record for this content wins over the local record
        # (e.g. a second identical file promoting to an already-stabilized sha).
        merged = {**live_old_sidecar, **read_model_metadata(sha256, model_type)}
    else:
        # Fresh promotion: the live local sidecar (with any mid-hash edit) is authoritative.
        merged = dict(live_old_sidecar)
    merged["libraryId"] = sha256
    merged["sha256"] = sha256
    if model_type:
        merged["modelType"] = model_type
    merged["identityPending"] = False  # now has a content SHA — no longer a seed
    merged["identityStabilizedFrom"] = old_id
    merged["identityStabilizedAt"] = current_millis()

    promoted = dict(record)
    promoted["library_id"] = sha256
    promoted["sha256"] = sha256
    promoted["sidecar_data"] = merged
    write_model_metadata(promoted, merged)
    delete_identity_files(old_id, model_type)
    return promoted, {"oldId": old_id, "newId": sha256}
