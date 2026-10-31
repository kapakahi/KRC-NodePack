import time

NONE_PRESET_GROUP = "none"
NONE_PRESET_GROUP_LABEL = "--none--"

# Filter sentinels that are never real group names (picker "All" / legacy default).
_RESERVED_GROUP_TOKENS = {"__all__", "__default__"}


def canonical_group(value):
    """Normalize a stored group string.

    Empty / the ``--none--`` label / a filter sentinel all collapse to the reserved
    ``none`` token (the ungrouped bucket, displayed as ``--none--``). A group never
    contains ``:`` (it separates group and label in ``compose_trigger``) and never starts
    with ``@`` (kept from the old combined preset string; harmless, and existing groups
    already follow it).
    """
    raw = str(value or "").strip()
    if not raw or raw in _RESERVED_GROUP_TOKENS or raw == NONE_PRESET_GROUP_LABEL:
        return NONE_PRESET_GROUP
    cleaned = raw.replace(":", "").strip().lstrip("@").strip()
    return cleaned or NONE_PRESET_GROUP


def canonical_label(value):
    """Normalize a preset label: strip only.

    Labels are free-form and MAY contain ``:``: ``group:label`` is composed for display
    and never re-split, so a colon in the label is unambiguous.
    """
    return str(value or "").strip()


def compose_trigger(group, label):
    """A preset's ``group:label`` (group defaults ``none``), for display and for the
    reserved-name checks. Nothing matches presets by it any more: loadouts follow
    preset ids (PRESET_LINK_GAMEPLAN.md), so the name is display only.
    """
    lbl = canonical_label(label)
    if not lbl:
        return ""
    return f"{canonical_group(group)}:{lbl}"


def rename_group_records(records, old, new, unique_names=False, reserved=None, to_none=False, now=None):
    """Move every preset in group ``old`` to group ``new`` (PRESET_GROUP_RENAME_GAMEPLAN.md).

    ``records`` are one store's preset dicts; the moved ones are copied with the new
    ``group`` and a fresh ``modified``, everything else (ids included) is untouched. ``old``
    matches exactly, so ``colors`` -> ``Colors`` merges a case split. A ``new`` that already
    exists merges. ``unique_names`` (Word Bank, Config Switcher) refuses the whole rename
    when a moved preset's name is already used in ``new``; ``reserved(group, name)`` (LoRA
    Loadout, kits) refuses a name the new group can't hold. ``new`` may be ``none`` only
    with ``to_none`` (the group menu's Ungroup).

    -> ``{"ok": True, "records", "ids", "group"}``, or ``{"ok": False, "error"}`` with
    error ``invalid`` (``none``, empty, or the same name), ``not_found`` (no preset in
    ``old``), ``name_clash`` or ``reserved`` (both plus ``clashes``, the names, sorted).
    """
    old_group = canonical_group(old)
    new_group = canonical_group(new)
    if old_group == NONE_PRESET_GROUP or old_group == new_group or (new_group == NONE_PRESET_GROUP) != bool(to_none):
        return {"ok": False, "error": "invalid"}
    records = list(records or [])
    moving = [record for record in records if canonical_group(record.get("group")) == old_group]
    if not moving:
        return {"ok": False, "error": "not_found"}
    if reserved:
        clashes = sorted({record.get("name") for record in moving if reserved(new_group, record.get("name"))}, key=str)
        if clashes:
            return {"ok": False, "error": "reserved", "clashes": clashes}
    if unique_names:
        taken = {record.get("name") for record in records if canonical_group(record.get("group")) == new_group}
        clashes = sorted({record.get("name") for record in moving if record.get("name") in taken}, key=str)
        if clashes:
            return {"ok": False, "error": "name_clash", "clashes": clashes}
    stamp = int(time.time()) if now is None else now
    out = []
    for record in records:
        if canonical_group(record.get("group")) == old_group:
            record = {**record, "group": new_group, "modified": stamp}
        out.append(record)
    return {"ok": True, "records": out, "ids": [record.get("id") for record in moving], "group": new_group}


def delete_group_records(records, group):
    """Every preset except those in ``group`` (matched exactly; never ``none``).
    -> ``{"ok": True, "records", "ids"}`` (the deleted ids), or ``invalid`` / ``not_found``."""
    group = canonical_group(group)
    if group == NONE_PRESET_GROUP:
        return {"ok": False, "error": "invalid"}
    records = list(records or [])
    doomed = [record for record in records if canonical_group(record.get("group")) == group]
    if not doomed:
        return {"ok": False, "error": "not_found"}
    keep = [record for record in records if canonical_group(record.get("group")) != group]
    return {"ok": True, "records": keep, "ids": [record.get("id") for record in doomed], "group": group}


def _save_group_change(store, data, result):
    if not result["ok"]:
        return result
    data["presets"] = result["records"]
    store.save(data)
    return {"ok": True, "group": result["group"], "count": len(result["ids"]), "ids": result["ids"]}


def rename_store_group(store, old, new, unique_names=False, reserved=None, to_none=False):
    """``rename_group_records`` on a preset store (``load()`` / ``save(data)``), saved in
    one transaction. -> ``{"ok": True, "group", "count", "ids"}`` or the refusal."""
    data = store.load()
    return _save_group_change(store, data, rename_group_records(
        data["presets"], old, new, unique_names=unique_names, reserved=reserved, to_none=to_none))


def ungroup_store_group(store, group, unique_names=False, reserved=None):
    """Move every preset in ``group`` to ``--none--`` (the group menu's Ungroup)."""
    return rename_store_group(store, group, NONE_PRESET_GROUP, unique_names=unique_names, reserved=reserved,
                              to_none=True)


def delete_store_group(store, group):
    """Delete ``group`` and every preset in it, in one save. ``group`` in the answer is the
    deleted group."""
    data = store.load()
    return _save_group_change(store, data, delete_group_records(data["presets"], group))


GROUP_ACTIONS = ("rename", "ungroup", "delete")


def run_group_action(store, action, payload):
    """One of the group menu's actions on ``store``, from a route's JSON body: rename
    ``{from, to}``, ungroup ``{group}``, delete ``{group}``."""
    payload = payload if isinstance(payload, dict) else {}
    if action == "rename":
        return store.rename_group(payload.get("from", ""), payload.get("to", ""))
    if action == "ungroup":
        return store.ungroup_group(payload.get("group", ""))
    if action == "delete":
        return store.delete_group(payload.get("group", ""))
    return {"ok": False, "error": "invalid"}


def group_action_status(result):
    """The HTTP status for a group action's answer (the group routes of every store)."""
    if result.get("ok"):
        return 200
    return {"not_found": 404, "name_clash": 409, "reserved": 409}.get(result.get("error"), 400)


def log_group_action(area, action, payload, result, what="preset group"):
    """One ASCII console line for a done group action (``area`` as in ``[KRC <area>]``)."""
    if not result.get("ok"):
        return
    payload = payload if isinstance(payload, dict) else {}
    count = f"{result['count']} preset(s)"
    if action == "rename":
        print(f"[KRC {area}] renamed {what} {canonical_group(payload.get('from'))!a} to {result['group']!a} ({count})")
    elif action == "ungroup":
        print(f"[KRC {area}] moved {what} {canonical_group(payload.get('group'))!a} to --none-- ({count})")
    elif action == "delete":
        print(f"[KRC {area}] deleted {what} {result['group']!a} and its {count}")


def group_action_answer(store, action, payload, area, what="preset group"):
    """A group route's whole job: run, log, -> ``(result, status)``."""
    result = run_group_action(store, action, payload)
    log_group_action(area, action, payload, result, what=what)
    return result, group_action_status(result)
