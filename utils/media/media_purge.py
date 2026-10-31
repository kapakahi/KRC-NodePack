"""Global Media Purge: scoped, protective, snapshot-confirmed tracked-file deletion."""
import hashlib
import json

from . import media_store as store, preset_store as presets

SCOPES = {"unsorted": "Purge unsorted", "selected": "Purge selected", "all": "Purge all", "output": "Purge output"}


def _plan(payload, doc):
    if not isinstance(payload, dict) or not isinstance(payload.get("scope"), str) or payload["scope"] not in SCOPES:
        raise store.MediaError("Choose a valid Purge scope.")
    scope = payload["scope"]
    selected = set()
    if scope == "selected":
        selected = {store.valid_id(item_id) for item_id in store.api().validate_card_ids(payload.get("ids"))}
        if not selected.issubset({item["id"] for item in doc["items"]}):
            raise store.MediaError("Selected Media changed. Refresh and select cards again.")
    candidates = [item for item in doc["items"] if scope == "all"
                  # Unsorted uploads; Default outputs (no folder either) are "output"'s.
                  or (scope == "unsorted" and not item.get("folder") and item.get("storage") != "output")
                  or (scope == "selected" and item["id"] in selected)
                  or (scope == "output" and item.get("storage") == "output")]
    used = presets.used_ids()
    protected_folders = {folder["id"] for folder in doc["folders"] if folder["keep"]}
    protected = [item for item in candidates if item["id"] in used or item.get("folder") in protected_folders
                 or (scope != "all" and store.kept_by_flush(item))]
    skipped_ids = {item["id"] for item in protected}
    doomed = [item for item in candidates if item["id"] not in skipped_ids]
    files = []
    for item in doomed:
        for path in (store.media_path(item), store.thumb_path(item["id"])):
            try:
                size = path.stat().st_size
            except FileNotFoundError:
                size = 0
            files.append((item["id"], str(path), size))
    snapshot = hashlib.sha256(json.dumps({"scope": scope, "candidates": sorted(item["id"] for item in candidates),
                                         "files": sorted(files)}, sort_keys=True).encode()).hexdigest()
    protection = ("Saved preset references and protected folders are kept. Favorites and pinned items are included."
                  if scope == "all" else "Favorites, pinned items, saved preset references and protected folders are kept.")
    scope_note = " Output includes tracked KRC-generated files regardless of their current folder; unrelated ComfyUI output files are excluded." if scope == "output" else ""
    result = {"ok": True, "scope": scope, "title": SCOPES[scope], "count": len(candidates), "eligible": len(doomed),
              "skipped": len(protected), "bytes": sum(size for _, _, size in files), "snapshot": snapshot,
              "message": f"Permanently deletes {len(doomed)} media files and their cached thumbnails; {len(protected)} items are kept. {protection}{scope_note} Folder chips remain. Deleted files may show Missing in output history. This cannot be undone."}
    return result, doomed


def purge(payload, *, preview=False):
    """Preview and commit share eligibility; changed scopes require a fresh confirmation."""
    if not preview and (not isinstance(payload, dict) or payload.get("confirmed") is not True):
        raise store.MediaError("Confirm Purge before continuing.")
    with store.locked():
        doc = store._read_doc()
        result, doomed = _plan(payload, doc)
        if preview:
            return result
        if payload.get("snapshot") != result["snapshot"]:
            raise store.MediaError("Media or its protections changed. Close this dialog and check Purge again.")
        ids = {item["id"] for item in doomed}
        if ids:
            doc["items"] = [item for item in doc["items"] if item["id"] not in ids]
            store._write_doc(doc)
    warnings = store._remove_media_files(doomed)
    return {"ok": True, "removed": len(doomed), "kept": result["skipped"], "deleted": sorted(ids), "warnings": warnings}
