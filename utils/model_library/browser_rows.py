"""Model Library browser rows: generic-model rows, LoRA read-through rows (LoRA Loadout's own
list serializer + ML overlays), the folder-rail rows and their ids, folder meta and the
LoRA folder-colour store, and the identity alias map."""

from ..library.nsfw import nsfw_rating
from .metadata import as_int


def _type_row_id(model_type):
    return f"__type__:{model_type}"


def _root_row_id(model_type):
    return f"__root__:{model_type}"


def _folder_row_id(model_type, folder):
    return f"__folder__:{model_type}:{folder}"


def _lora_folder_name(folder_id):
    """If folder_id is a Model Library LoRA nested-folder row, return the bare folder
    name LoRA Loadout keys its store by; else None. LoRA folder color/pin is owned by
    LoRA Loadout (read-through), so only these rows delegate to LL's FolderColorStore.
    The type/root rows (__type__:lora, __root__:lora) are Model-Library-only nav and
    stay in the Model Library store."""
    prefix = _folder_row_id("lora", "")  # "__folder__:lora:"
    if isinstance(folder_id, str) and folder_id.startswith(prefix):
        return folder_id[len(prefix):]
    return None


def _lora_folder_store():
    """LoRA Loadout's folder color/pin store instance, or None if LL is unavailable.
    Lazy so a missing/broken LL never blocks Model Library."""
    try:
        from ..lora_loadout.presets import FolderColorStore
        return FolderColorStore()
    except Exception:  # noqa: BLE001
        return None


def _load_lora_folder_store():
    store = _lora_folder_store()
    if store is None:
        return {"folders": {}, "pinned": []}
    try:
        return store.load()
    except Exception:  # noqa: BLE001
        return {"folders": {}, "pinned": []}


def _load_identity_aliases(store_cls):
    try:
        aliases = store_cls().load().get("aliases", {})
    except Exception:  # noqa: BLE001
        return {}
    return aliases if isinstance(aliases, dict) else {}


def _folder_meta(folder_id, folder_store, lora_store=None):
    # LoRA nested folders read their color/pin from LoRA Loadout's store (keyed by the
    # bare folder name), so pins/colors set in the LoRA Loadout node show through in the
    # Model Library LoRA view. Per-type scoping is preserved: only __folder__:lora:* rows
    # consult LL, so LoRA pins never appear under another model type.
    lora_folder = _lora_folder_name(folder_id)
    if lora_folder is not None and lora_store is not None:
        colors = lora_store.get("folders", {})
        pinned = set(lora_store.get("pinned", []))
        return {"cardColor": colors.get(lora_folder, ""), "pinned": lora_folder in pinned}
    colors = folder_store.get("folders", {})
    pinned = set(folder_store.get("pinned", []))
    return {"cardColor": colors.get(folder_id, ""), "pinned": folder_id in pinned}


def _browser_model_item(record):
    meta = record.get("sidecar_data") or {}
    library_id = record.get("library_id") or meta.get("libraryId") or ""
    return {
        "sha256": library_id,
        "actualSha256": record.get("sha256") or meta.get("sha256") or library_id,
        "libraryId": library_id,
        "modelType": record.get("modelType") or meta.get("modelType") or "other",
        "display_name": record.get("display_name") or meta.get("name") or record.get("filename") or library_id,
        # Title mode (browserLabel) only shows display_name when hasName is truthy;
        # without it every card falls back to filename even when a title is set.
        "hasName": bool(meta.get("name")),
        "filename": record.get("filename") or "",
        "originalName": meta.get("originalName") or "",
        "format": meta.get("format") or "",
        "folder": record.get("folder") or "",
        "relativePath": record.get("relative_path") or "",
        "path": record.get("path") or "",
        # On an offline root (kept, not moved): a run can't load it (Card API cardStatus).
        "unavailable": bool(record.get("unavailable")),
        "dateAdded": record.get("date_added") or 0,
        "dateModified": record.get("date_modified") or 0,
        "thumbnail": bool(record.get("thumbnail")),
        "thumbnailSha": library_id,
        "thumbnailType": record.get("thumbnail_type") or "image",
        "thumbnailHasPoster": True,
        # Derived from the actual webm on disk (library_index sets thumbnail_type),
        # so the card/InfoPanel enable the hover loop only when one exists.
        "thumbnailHasAnimation": (record.get("thumbnail_type") == "video"),
        "thumbnailVersion": int(record.get("thumbnail_version") or 0),
        "favorite": bool(meta.get("favorite")),
        "pinned": bool(meta.get("pinned")),
        "rating": as_int(meta.get("rating"), 0),
        "nsfw": bool(meta.get("nsfw")),
        "nsfwLevel": nsfw_rating(meta.get("nsfwLevel")),
        "baseModel": meta.get("baseModel") or "",
        "category": record.get("modelType") or meta.get("modelType") or "model",
        "version": meta.get("version") or "",
        "family": meta.get("family") or "",
        "architecture": meta.get("architecture") or "",
        "variant": meta.get("variant") or "",
        "role": meta.get("role") or "",
        "parameterCount": meta.get("parameterCount") or "",
        "quantization": meta.get("quantization") or "",
        "precision": meta.get("precision") or "",
        "releaseDate": meta.get("releaseDate") or "",
        "baseModelReleaseDate": meta.get("baseModelReleaseDate") or "",
        "license": meta.get("license") or "",
        "description": meta.get("description") or "",
        "notes": meta.get("notes") or "",
        # Verification object drives the KRC ID shield (also in the normalized detail).
        "verification": meta.get("verification") or {},
        "creatorName": meta.get("creator", {}).get("name") or meta.get("creator", {}).get("username") or "",
        "companyName": meta.get("organization", {}).get("name") or "",
        "sourceName": meta.get("source", {}).get("name") or "",
        "cardColor": meta.get("cardColor") or "",
        "customBadge": meta.get("customBadge") or "",
        "tags": meta.get("tags") if isinstance(meta.get("tags"), list) else [],
        "deferDetails": True,
    }


def _browser_lora_item(record, serialize, folder_colors):
    """A Model Library browser-list row for a read-through LoRA. Delegates to LoRA Loadout's
    own list serializer (`serialize` = `_serialize_lora`, light mode) so ML's LoRA rows are
    byte-identical to LL's — one loader, no parallel field list (this used to be a hand-
    maintained fork that drifted off the deferred-detail contract; see
    INFO_PANEL_RECORD_CONTRACT_GAMEPLAN.md step 3). Only the genuinely ML-specific fields are
    overlaid: `modelType` (drives the browser's LoRA-vs-model dispatch — MUST be "lora"), the
    `libraryId` / camelCase `relativePath` aliases ML consumers read, and ML's "lora" default
    for an untagged category."""
    sidecar = record.get("sidecar_data") or {}
    library_id = record.get("library_id") or sidecar.get("libraryId") or ""
    item = serialize(record, sidecar, folder_colors, include_heavy_text=False, include_detail_fields=False)
    item.update({
        "modelType": "lora",
        "libraryId": library_id,
        "relativePath": record.get("relative_path") or "",
        "category": item.get("category") or "lora",
    })
    return item


def _build_folder_rows(items, folder_store, lora_store=None):
    counts_by_type = {}
    root_counts = {}
    folder_counts = {}
    for item in items:
        model_type = item.get("modelType") or "other"
        counts_by_type[model_type] = counts_by_type.get(model_type, 0) + 1
        folder = item.get("folder") or ""
        if folder:
            folder_counts[(model_type, folder)] = folder_counts.get((model_type, folder), 0) + 1
        else:
            root_counts[model_type] = root_counts.get(model_type, 0) + 1

    rows = [{"name": "__model_home__", "label": "All Models", "count": len(items), "scope": True, "parent": "__model_home__", "kind": "home"}]

    type_rows = []
    for model_type, count in sorted(counts_by_type.items(), key=lambda kv: (kv[0].lower(), kv[0])):
        row_id = _type_row_id(model_type)
        meta = _folder_meta(row_id, folder_store, lora_store)
        type_rows.append({
            "name": row_id,
            "label": model_type,
            "count": count,
            "scope": False,
            "parent": "__model_home__",
            "kind": "type",
            "modelType": model_type,
            **meta,
        })
    type_rows.sort(key=lambda row: (0 if row.get("pinned") else 1, (row.get("label") or "").lower(), row.get("label") or ""))
    rows.extend(type_rows)

    for model_type, _count in sorted(counts_by_type.items(), key=lambda kv: (kv[0].lower(), kv[0])):
        parent = _type_row_id(model_type)
        rows.append({"name": "__model_home__", "label": "All Models", "count": len(items), "scope": True, "parent": parent, "kind": "home"})
        rows.append({"name": parent, "label": f"All {model_type}", "count": counts_by_type[model_type], "scope": True, "parent": parent, "kind": "type", "modelType": model_type})
        if root_counts.get(model_type, 0):
            rows.append({"name": _root_row_id(model_type), "label": "Root", "count": root_counts[model_type], "scope": True, "parent": parent, "kind": "root", "modelType": model_type})
        folder_rows = []
        for (folder_type, folder), count in folder_counts.items():
            if folder_type != model_type:
                continue
            row_id = _folder_row_id(model_type, folder)
            meta = _folder_meta(row_id, folder_store, lora_store)
            folder_rows.append({
                "name": row_id,
                "label": folder,
                "folder": folder,
                "count": count,
                "scope": False,
                "parent": parent,
                "kind": "folder",
                "modelType": model_type,
                **meta,
            })
        folder_rows.sort(key=lambda row: (0 if row.get("pinned") else 1, (row.get("label") or "").lower(), row.get("label") or ""))
        rows.extend(folder_rows)
    return rows
