"""Missing-card status for model cards on the server: a port of web/js/shared/card_status.js
``modelCardStatus`` and shared/model_identity.js (``canonicalModelId``,
``modelIdentityIndex``), the rule the Config Switcher uses to show a model option MISSING.
The external API's /krc/ext/v1/models/resolve answers with it. The dev repo's parity test
runs the same cases through that JS and through this; change both together.

    "ok"       the id is in the library (following identity aliases) and loadable
    "by-path"  id unknown, but the path the node's run falls back to is exactly one library
               item's relative path (same type folder when given): it will run
    "missing"  neither, or the item is on an offline drive

Paths are exact and type-scoped, and must identify one item; no filename or size matching.
"""

STATUS_OK = "ok"
STATUS_BY_PATH = "by-path"
STATUS_MISSING = "missing"
_MAX_ALIAS_HOPS = 64


def canonical_model_id(value, aliases):
    """model_identity.js canonicalModelId: follow the alias chain; a cycle keeps the id."""
    original = str(value or "").strip()
    current = original
    seen = set()
    while current and current in aliases:
        if current in seen or len(seen) >= _MAX_ALIAS_HOPS:
            return original
        seen.add(current)
        nxt = str(aliases.get(current) or "").strip()
        if not nxt:
            return original
        current = nxt
    return current


def _path_key(value):
    return str(value or "").strip().replace("\\", "/")


def _type_key(value):
    if value == "loras":
        return "lora"
    if value == "all":
        return ""
    return str(value or "")


def _identities(item):
    return list(dict.fromkeys(str(value) for value in (item.get("id"), item.get("libraryId"), item.get("sha256")) if value))


def _paths(item):
    keys = (item.get("relativePath"), item.get("relative_path"), item.get("path"), item.get("value"))
    return list(dict.fromkeys(key for key in (_path_key(value) for value in keys) if key))


def model_identity_index(items, aliases):
    """model_identity.js modelIdentityIndex -> resolve(option): the one item an option
    names (by id, else by exact type-scoped path), or None when none or several do."""
    ids, paths = {}, {}

    def add(table, key, item):
        if key:
            table.setdefault(key, {})[id(item)] = item

    for item in items or []:
        if not item:
            continue
        for value in _identities(item):
            add(ids, canonical_model_id(value, aliases), item)
        if item.get("unavailable"):
            continue
        for path in _paths(item):
            add(paths, f"{_type_key(item.get('modelType'))}|{path}", item)
            add(paths, f"|{path}", item)

    def resolve(option):
        candidates = {}
        for value in _identities(option):
            candidates.update(ids.get(canonical_model_id(value, aliases), {}))
        if candidates:
            return next(iter(candidates.values())) if len(candidates) == 1 else None
        found = {}
        folder = option.get("modelType") or option.get("folder")
        for path in _paths(option):
            found.update(paths.get(f"{_type_key(folder)}|{path}", {}))
        return next(iter(found.values())) if len(found) == 1 else None

    return resolve


def model_card_status(entries, items, aliases):
    """card_status.js modelCardStatus for ``entries`` ({id, path?, folder?}) against the
    library list's ``items`` and identity ``aliases``. -> [(status, item or None)] in order.
    (The library always reads here; the JS's "unreadable library -> ok" is the caller's.)"""
    resolve = model_identity_index(items, aliases)
    out = []
    for entry in entries:
        entry_id = str(entry.get("id") or "").strip()
        item = resolve({"id": entry_id, "path": entry.get("path"), "folder": entry.get("folder")})
        matches_id = bool(item) and any(
            value and canonical_model_id(value, aliases) == canonical_model_id(entry_id, aliases)
            for value in (item.get("sha256"), item.get("libraryId"), item.get("id")))
        if not item or item.get("unavailable"):
            status = STATUS_MISSING
        else:
            status = STATUS_OK if matches_id else STATUS_BY_PATH
        out.append((status, item))
    return out
