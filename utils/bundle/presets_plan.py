"""One import plan for every preset store (LoRA Loadout, Config Switcher, Loadout Kits).

Merge adds presets whose key isn't here and leaves existing ones alone; Overwrite also
replaces a same-key preset with the bundle's. A preset without a name (or without its key),
or with a name reserved for --empty-- / --unsaved--, is skipped.

The plan's counts are a preview against the store as it was when planning. apply() runs
inside the import's transaction and re-reads the store there, so a preset saved, edited
or deleted while the bundle was being planned is kept as it is now (never dropped or
brought back); it returns the counts it actually committed.
"""
from .sections import ImportPlan, plan_summary


def _resolve(current, incoming, overwrite, key):
    """The store after the import, and its counts. -> (presets or None, added, updated, unchanged)."""
    by_key = {key(preset): preset for preset in current if key(preset)}
    added = updated = unchanged = 0
    for preset in incoming:
        preset_key = key(preset)
        if preset_key not in by_key:
            added += 1
        elif overwrite:
            updated += 1
        else:
            unchanged += 1
            continue
        by_key[preset_key] = preset
    return (list(by_key.values()) if added or updated else None), added, updated, unchanged


def plan_presets(store, incoming, mode, *, key, required=("name",), reserved=None, skip=None, result_key="presets"):
    """``store``: has load() -> {"presets": [...]} and save({"presets": [...]}).
    ``incoming``: the bundle's preset list. ``key(preset)`` -> its identity ("" = none).
    ``skip(preset)`` -> why it can't be imported (counted as a skip reason), else None."""
    overwrite = mode == "overwrite"
    skipped = {"invalid": 0, "reserved name": 0}
    valid = []
    for preset in incoming if isinstance(incoming, list) else []:
        if not isinstance(preset, dict) or not all(preset.get(field) for field in required) or not key(preset):
            skipped["invalid"] += 1
            continue
        if reserved and reserved(preset.get("group"), preset.get("name")):
            skipped["reserved name"] += 1
            continue
        reason = skip(preset) if skip else None
        if reason:
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        valid.append(preset)

    def current():
        return [preset for preset in store.load().get("presets", []) if isinstance(preset, dict)]

    _presets, added, updated, unchanged = _resolve(current(), valid, overwrite, key)

    def apply():
        presets, added_now, updated_now, _unchanged = _resolve(current(), valid, overwrite, key)
        if presets is not None:
            store.save({"presets": presets})
        return {result_key: added_now + updated_now}

    return ImportPlan(plan_summary(added, updated, unchanged, skipped), apply)


def incoming_presets(payload):
    """The preset list of a presets.json payload ({"presets": [...]} or a bare list)."""
    presets = payload.get("presets") if isinstance(payload, dict) else payload
    return presets if isinstance(presets, list) else []
