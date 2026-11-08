"""The Model Library's list: every model row plus the LoRA read-through rows, with usage
joined, the folder-rail rows and the identity aliases. One builder for the node's own
``/krc/model-library/library`` and the external API's ``/krc/ext/v1/models``, so both
always list the same thing.

Read-only: nothing here writes a record (the Info panel's detail route seeds sidecars;
this never does).
"""

from ..library.thumbnails import thumbnail_listing_scope
from ..library.usage_stats import load_usage_section
from ..lora_loadout.identity import IdentityStore as LoraIdentityStore
from .browser_rows import (
    _browser_lora_item,
    _browser_model_item,
    _build_folder_rows,
    _load_identity_aliases,
    _load_lora_folder_store,
)
from .folders import ModelLibraryFolderStore
from .identity import IdentityStore as ModelIdentityStore


def lora_rows(lora_records, include_detail=False):
    """LoRA read-through rows through LoRA Loadout's own serializer (schema S8). A missing or
    broken LoRA Loadout gives [] (the list degrades to models only). ``include_detail``
    fills what the list holds back (description, example prompts, paths, usage), for the
    Info panel's full record."""
    try:
        from ..lora_loadout.serialize import _join_civitai_not_found, _serialize_lora
        lora_folders = _load_lora_folder_store().get("folders", {})
    except Exception:  # noqa: BLE001
        return []
    if include_detail:
        def serialize(record, sidecar, folders, **_kwargs):
            return _serialize_lora(record, sidecar, folders, include_heavy_text=True, include_detail_fields=True)
    else:
        serialize = _serialize_lora
    try:
        items = [_browser_lora_item(record, serialize, lora_folders) for record in lora_records]
    except Exception:  # noqa: BLE001
        return []
    if not include_detail:
        _join_civitai_not_found(items)
    return items


def join_usage(items):
    """useCount / lastUsedMs on each row from the usage ledger: model rows from the
    CS-fed "models" section, LoRA rows from LoRA Loadout's "loras". Unseen ids read 0."""
    model_usage = load_usage_section("models")
    lora_usage = load_usage_section("loras")
    for item in items:
        stats = model_usage.get(item.get("sha256") or "") or lora_usage.get(item.get("sha256") or "")
        item["useCount"] = int(stats.get("count") or 0) if isinstance(stats, dict) else 0
        item["lastUsedMs"] = int(stats.get("lastUsedMs") or 0) if isinstance(stats, dict) else 0
    return items


def library_rows(index, lora_index, model_types=None):
    """-> {"items", "folders", "aliases"} for loaded indexes; ``model_types`` (a set of
    type folders, "lora" for LoRAs) keeps only those, folder rows included. Run off the
    event loop, inside one database read (library/response_work.py
    prepare_library_response)."""
    # Cached metadata edits replace sidecars; freeze the outer records before joining
    # DB-backed folders, usage and aliases in this read snapshot.
    model_records = tuple(dict(record) for record in tuple(index.records.values()))
    lora_records = tuple(dict(record) for record in tuple(lora_index.records.values()))
    # One listing per thumbnail dir for the whole list, not a stat per item per variant.
    if model_types is not None and "lora" not in model_types:
        lora_records = ()
    with thumbnail_listing_scope():
        items = [_browser_model_item(record) for record in model_records]
        items.extend(lora_rows(lora_records))
    if model_types is not None:
        items = [item for item in items if item.get("modelType") in model_types]
    join_usage(items)
    items.sort(key=lambda item: (item.get("display_name") or "").lower())
    return {
        "items": items,
        "folders": _build_folder_rows(items, ModelLibraryFolderStore().load(), _load_lora_folder_store()),
        "aliases": {
            **_load_identity_aliases(ModelIdentityStore),
            **_load_identity_aliases(LoraIdentityStore),
        },
    }
