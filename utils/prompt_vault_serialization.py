import copy
import os
import re
from contextlib import nullcontext

from .library.usage_stats import load_usage_section
from .library.thumbnails import thumbnail_listing_scope
from .prompt_vault_thumbnails import find_thumbnail_path, find_thumbnail_variant
from .prompt_profiles import DEFAULT_PROFILE_ID
from .prompt_vault_store import prompt_usage_by_ids, prompt_usage_by_key, prompt_owners


def prompt_detail(category, name, record):
    """One full prompt record as the detail routes answer it: text included, usage and
    thumbnail flags joined in, plus ``category``, ``name`` and ``textDeferred: false``."""
    return prompt_details([(category, name, record)])[0]


FIELD_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,64}$")
MAX_FIELDS = 50


def parse_fields(value):
    """``?fields=a,b,c`` -> a set of field names, or None when the parameter is absent or
    empty (the whole record). Raises ValueError for a bad name or too many."""
    names = [name.strip() for name in str(value or "").split(",") if name.strip()]
    if not names:
        return None
    if len(names) > MAX_FIELDS:
        raise ValueError(f"At most {MAX_FIELDS} fields")
    bad = next((name for name in names if not FIELD_NAME_RE.match(name)), None)
    if bad is not None:
        raise ValueError(f"Bad field name {bad!r}")
    return set(names)


def select_fields(response, fields):
    """Keep only ``fields`` in each prompt record of a get-prompts response (in place).
    Categories and names are the response's keys, so they always stay, and so does each
    category's ``__meta__``; a field a record doesn't have is simply absent."""
    if fields is None:
        return response
    for bucket in response.values():
        if not isinstance(bucket, dict):
            continue
        for name, record in bucket.items():
            if name != "__meta__" and isinstance(record, dict):
                for key in [key for key in record if key not in fields]:
                    del record[key]
    return response


def prompt_details(matches):
    """Many ``(category, name, record)`` at once -> their prompt_detail payloads, in the same
    order, joining usage and thumbnail flags in one pass (not one per record)."""
    # Category/name is only unique inside a profile. Synthetic buckets preserve every
    # explicit match in a batch even when two profiles use identical display names.
    library = {str(index): {name: record} for index, (_category, name, record) in enumerate(matches)}
    usage = prompt_usage_by_ids(record.get("id") for _category, _name, record in matches)
    owners = prompt_owners(record.get("id") for _category, _name, record in matches)
    response = prompts_for_response(library, include_heavy_text=True, usage_by_id=usage)
    details = []
    for index, (category, name, _record) in enumerate(matches):
        payload = response[str(index)][name]
        payload["category"] = category
        payload["name"] = name
        payload["textDeferred"] = False
        locations = owners.get(payload.get("id"), [])
        payload["profileId"] = locations[0]["profileId"] if locations else DEFAULT_PROFILE_ID
        details.append(payload)
    return details


def prompts_for_response(data, include_heavy_text=False, find_thumbnail=None, *, profile_id=DEFAULT_PROFILE_ID, usage_by_id=None):
    """Return a copy with response-only thumbnail flags derived from disk."""
    response = copy.deepcopy(data or {})
    # Silent usage ledger, joined in once for the whole response so the browser can
    # later sort by Most Used / Last Used. Keyed by category/name (the browser's key).
    usage_map = {} if usage_by_id is not None else (
        load_usage_section("prompts") if profile_id == DEFAULT_PROFILE_ID else prompt_usage_by_key(profile_id))
    # Single-record details keep direct lookups instead of listing a large library.
    batch = sum(len(bucket) - ("__meta__" in bucket) for bucket in response.values() if isinstance(bucket, dict)) > 1
    with thumbnail_listing_scope() if batch else nullcontext():
        for category, cat_data in response.items():
            if not isinstance(cat_data, dict):
                continue
            for name, entry in cat_data.items():
                if name == "__meta__" or not isinstance(entry, dict):
                    continue
                stats = usage_by_id.get(entry.get("id")) if usage_by_id is not None else usage_map.get(f"{category}/{name}")
                entry["useCount"] = int(stats.get("count") or 0) if isinstance(stats, dict) else 0
                entry["lastUsedMs"] = int(stats.get("lastUsedMs") or 0) if isinstance(stats, dict) else 0
                if not include_heavy_text:
                    text_length = 0
                    text_deferred = False
                    for key in ("prompt", "promptB", "notes"):
                        value = entry.get(key, "")
                        if value:
                            text_length += len(str(value))
                            text_deferred = True
                        entry[key] = ""
                    entry["textDeferred"] = text_deferred
                    entry["textLength"] = text_length
                record_id = entry.get("id")
                if find_thumbnail is None:
                    path = find_thumbnail_path(record_id, prefer_animated=True)
                else:
                    path = find_thumbnail(record_id)
                poster_path = find_thumbnail_variant(record_id, "poster")
                if path:
                    entry["hasThumb"] = True
                    entry["thumbType"] = "video" if os.path.splitext(path)[1].lower() == ".webm" else "image"
                    entry["thumbHasPoster"] = bool(poster_path)
                else:
                    entry.pop("thumbType", None)
                    entry.pop("thumbHasPoster", None)
                if "ll_preset" in entry:
                    entry["llPreset"] = entry.pop("ll_preset")
                if "ll_preset_label" in entry:
                    entry["llPresetLabel"] = entry.pop("ll_preset_label")
    return response
