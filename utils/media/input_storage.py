"""Bind converted uploads to ComfyUI’s configured input directory."""
from . import media_store as store, media_paths


def prepare_upload(record):
    """Bind a new converted upload to the configured input root before processing."""
    record = dict(record)
    item_id = store.valid_id(record.get("id"))
    extension = record.get("ext")
    if extension not in (".webp", ".webm"):
        raise store.MediaError("Unsupported converted upload format.")
    try:
        record.update(storage="input", storage_root=str(media_paths.configured_root("input")),
                      relative_path=f"KRC-Media/uploads/{item_id}{extension}")
        store.media_path(record)  # validate the bound root and confined destination
    except media_paths.MediaPathError as err:
        raise store.MediaError(str(err)) from err
    return record
