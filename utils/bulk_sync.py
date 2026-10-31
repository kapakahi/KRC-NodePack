"""Post-commit cross-page bulk notifications, bounded by the existing sync envelope."""
import json

from .server_sync import publish_sync, SYNC_EVENTS, MAX_PAYLOAD_BYTES


def _origin(value):
    return value if isinstance(value, str) and len(value) <= 128 else ""


def announce_prompt_bulk(origin_page=""):
    # One refetch per receiving page, independent of selection/library size. The
    # receiver reconciles focused records by stable ID and preserves unsaved text.
    publish_sync(SYNC_EVENTS["PROMPTS_CHANGED"], {"bulk": True, "originPage": _origin(origin_page)})


def announce_model_attributes(ids, field, value, origin_page=""):
    base = {"fields": [field], "metadata": {field: value}, "originPage": _origin(origin_page)}
    chunk = []
    # Reserve the exact JSON overhead of the affected array, including separators.
    size = len(json.dumps({**base, "affected": []}))
    base_size = size
    for item_id in ids:
        extra = len(json.dumps(item_id)) + (2 if chunk else 0)
        if chunk and size + extra > MAX_PAYLOAD_BYTES:
            publish_sync(SYNC_EVENTS["LORA_METADATA_CHANGED"], {**base, "affected": chunk}, lane="metadata")
            chunk = []; size = base_size; extra = len(json.dumps(item_id))
        chunk.append(item_id); size += extra
    if chunk:
        publish_sync(SYNC_EVENTS["LORA_METADATA_CHANGED"], {**base, "affected": chunk}, lane="metadata")
