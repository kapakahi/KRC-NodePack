"""The external API's Loadout routes (KRC_EXTERNAL_API.md): Loadout Kit descriptors (a read,
capability "kits.descriptors") and LoRA Loadout / Loadout Kit preset writes (capability
"presets.loadout.write"), behind Read only and the "Loadout presets" permission
(ext_api.write_refusal("loadout")).

The writes go through the node's own stores (lora_loadout.presets.PresetStore and
loadout_kit.presets.KitPresetStore: canonical ids, group / label rules, reserved names), so
the presets, the change log ("presets:ll", "presets:kit:<id>") and Prompt Vault links behave
as when a node saves. Each preset has a ``version`` (``preset_version``: a hash of what
a client edits); a write must send the one it read and is refused 409 when it's stale,
checked inside the same database transaction as the write. Open nodes are told through the
same sync events a node's save sends (krc-lora-presets-changed / krc-loadout-presets-changed).

Payloads are checked strictly (a client sends what the node would): stack entries are
``{id, order, enabled, strength}`` (LoRA Loadout) or ``{id, order, enabled, <kit fields>}``
(kits), plus an optional display-only ``card`` snapshot. New ids must be in the library
(LoRAs; a kit's model folder or Prompt Vault); ids the stored preset already holds stay
allowed even when their file is gone, so a preset with a missing card can still be saved.
"""
import hashlib
import json
import math

from . import ext_api_policy as policy
from .ext_api_media_writes import Conflict, NotFound
from .ext_api_routes import BadRequest

LL_KIND = "ll"
LL_SLOTS = 6
LL_STACKS = ("A", "B")
LL_STRENGTH = (-10.0, 10.0)
CARD_KEYS = {"title": str, "cardColor": str, "favorite": bool, "nsfw": bool, "customBadge": str}


# ---- descriptors --------------------------------------------------------------------

def kit_descriptors():
    """GET /krc/ext/v1/kits: every registered kit's descriptor (the node builds from it)."""
    from .loadout_kit.kit import all_kits

    return {"kits": {kit_id: kit.descriptor() for kit_id, kit in sorted(all_kits().items())}}


def kit_descriptor(kit_id):
    from .loadout_kit.kit import get_kit

    kit = get_kit(str(kit_id or ""))
    if kit is None:
        raise NotFound("No Loadout Kit has that id (see /info kits).")
    return {"descriptor": kit.descriptor()}


# ---- versions -----------------------------------------------------------------------

def _without_cards(entries):
    return [{key: value for key, value in entry.items() if key != "card"} for entry in entries if isinstance(entry, dict)]


def preset_version(kind, record):
    """A short hash of what a client edits: group, name and the stacks (display-only card
    snapshots left out, as the node's own Modified signature does)."""
    if kind == LL_KIND:
        stacks = record.get("stacks") or {}
        seen = {"stacks": {key: _without_cards(stacks.get(key) or []) for key in LL_STACKS},
                "stackEnabled": record.get("stackEnabled") or {}}
    else:
        seen = {"stack": _without_cards(record.get("stack") or [])}
    seen.update(group=record.get("group") or "", name=record.get("name") or "")
    return hashlib.sha1(json.dumps(seen, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def is_loadout_kind(kind):
    return kind == LL_KIND or str(kind or "").startswith("kit:")


# ---- stores -------------------------------------------------------------------------

def _store(kind):
    """(store, kit or None) for a writable kind; 400 for any other kind."""
    if kind == LL_KIND:
        from .lora_loadout.presets import PresetStore
        return PresetStore(), None
    if str(kind).startswith("kit:"):
        from .loadout_kit.kit import get_kit
        kit = get_kit(kind[4:])
        if kit is None:
            raise NotFound(f"No Loadout Kit {kind[4:]!r} (see /info kits).")
        return kit.presets(), kit
    raise BadRequest("kind must be ll or kit:<id> (Media presets have their own routes; cs and wb presets are read-only)")


def _entry_body(record, kind):
    """A preset as /presets?full=1 lists it: {kind, id, group, name, modified, payload}."""
    payload = {key: value for key, value in record.items() if key not in ("id", "group", "name", "modified")}
    payload["version"] = preset_version(kind, record)
    return {"kind": kind, "id": record["id"], "group": record.get("group", ""), "name": record.get("name", ""),
            "modified": record.get("modified") or 0, "payload": payload}


def _answer(kind, record):
    from .db import connection as db
    from .db.presets import change_store

    return {"preset": _entry_body(record, kind), "revision": db.revision(change_store(kind))}


def _announce(kind):
    """The sync event a node's own save sends, from the server (pages refetch)."""
    from .server_sync import SYNC_EVENTS, publish_sync

    if kind == LL_KIND:
        publish_sync(SYNC_EVENTS["LORA_PRESETS_CHANGED"], {})
    else:
        publish_sync("krc-loadout-presets-changed", {"kit": kind[4:]})


# ---- payload checks -----------------------------------------------------------------

def _number(value, name):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
        raise BadRequest(f"{name} must be a number")
    return value


def _card(value, where):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) - set(CARD_KEYS):
        raise BadRequest(f"{where}.card must be an object with {', '.join(CARD_KEYS)}")
    for key, kind in CARD_KEYS.items():
        if key in value and not isinstance(value[key], kind):
            raise BadRequest(f"{where}.card.{key} has the wrong type")
    return dict(value)


def _entries(raw, where, slots, fields):
    """One stack: a list of entries, unique ``order`` 0..slots-1, at most ``slots``."""
    if not isinstance(raw, list):
        raise BadRequest(f"{where} must be a list")
    if len(raw) > slots:
        raise BadRequest(f"{where}: at most {slots} entries")
    allowed = {"id", "order", "enabled", "card", *fields}
    out, orders = [], set()
    for index, entry in enumerate(raw):
        at = f"{where}[{index}]"
        if not isinstance(entry, dict):
            raise BadRequest(f"{at} must be an object")
        unknown = sorted(set(entry) - allowed)
        if unknown:
            raise BadRequest(f"{at}: unknown key {unknown[0]!r} (one of {', '.join(sorted(allowed))})")
        card_id = entry.get("id")
        if not isinstance(card_id, str) or not card_id.strip():
            raise BadRequest(f"{at}.id must be a library id")
        order = entry.get("order")
        if isinstance(order, bool) or not isinstance(order, int) or not 0 <= order < slots:
            raise BadRequest(f"{at}.order must be a whole number 0 to {slots - 1}")
        if order in orders:
            raise BadRequest(f"{at}.order {order} is used twice")
        orders.add(order)
        if "enabled" in entry and not isinstance(entry["enabled"], bool):
            raise BadRequest(f"{at}.enabled must be true or false")
        clean = {"id": card_id.strip(), "order": order, "enabled": entry.get("enabled", True) is not False}
        for key, check in fields.items():
            clean[key] = check(entry.get(key), f"{at}.{key}")
        card = _card(entry.get("card"), at)
        if card:
            clean["card"] = card
        out.append(clean)
    return sorted(out, key=lambda item: item["order"])


def _ll_strength(value, name):
    if value is None:
        return 1.0
    number = float(_number(value, name))
    if not LL_STRENGTH[0] <= number <= LL_STRENGTH[1]:
        raise BadRequest(f"{name} must be from {LL_STRENGTH[0]:g} to {LL_STRENGTH[1]:g}")
    return round(number, 3)


def _kit_field_check(field):
    """A kit field (loadout_kit/fields.py) as a strict check: the right type, in range."""
    def check(value, name):
        if value is None:
            return field["default"]
        kind = field["type"]
        if kind in ("float", "int"):
            number = _number(value, name)
            if kind == "int" and float(number) != int(number):
                raise BadRequest(f"{name} must be a whole number")
            if not field["min"] <= number <= field["max"]:
                raise BadRequest(f"{name} must be from {field['min']:g} to {field['max']:g}")
            return float(number) if kind == "float" else int(number)
        if kind == "enum":
            if value not in field["options"]:
                raise BadRequest(f"{name} must be one of {', '.join(field['options'])}")
            return value
        if not isinstance(value, bool):
            raise BadRequest(f"{name} must be true or false")
        return value
    return check


def _payload(kind, kit, payload):
    """A preset payload checked against the node's shape -> (stacks / stack, stackEnabled)."""
    if not isinstance(payload, dict):
        raise BadRequest("payload must be an object")
    if kind == LL_KIND:
        unknown = sorted(set(payload) - {"stacks", "stackEnabled", "version"})
        if unknown:
            raise BadRequest(f"payload: unknown key {unknown[0]!r} (stacks, stackEnabled)")
        stacks = payload.get("stacks", {"A": [], "B": []})
        if not isinstance(stacks, dict) or set(stacks) - set(LL_STACKS):
            raise BadRequest('payload.stacks must be {"A": [...], "B": [...]}')
        checked = {key: _entries(stacks.get(key, []), f"payload.stacks.{key}", LL_SLOTS, {"strength": _ll_strength})
                   for key in LL_STACKS}
        enabled = payload.get("stackEnabled", {"A": True, "B": True})
        if not isinstance(enabled, dict) or set(enabled) - set(LL_STACKS) or not all(isinstance(v, bool) for v in enabled.values()):
            raise BadRequest('payload.stackEnabled must be {"A": bool, "B": bool}')
        return checked, {key: enabled.get(key, True) for key in LL_STACKS}
    unknown = sorted(set(payload) - {"stack", "version"})
    if unknown:
        raise BadRequest(f"payload: unknown key {unknown[0]!r} (stack)")
    fields = {field["key"]: _kit_field_check(field) for field in kit.fields}
    return _entries(payload.get("stack", []), "payload.stack", kit.slots, fields), None


def _ids(kind, stacks):
    if kind == LL_KIND:
        return [entry["id"] for key in LL_STACKS for entry in stacks[key]]
    return [entry["id"] for entry in stacks]


def _check_known(kind, kit, stacks, existing=None):
    """New ids must be in the library the stack draws from; ids the stored preset already
    holds may stay even when their card is gone (saved as Missing, as in the node)."""
    held = set(_ids(kind, (existing or {}).get("stacks") or {"A": [], "B": []}) if kind == LL_KIND
               else _ids(kind, (existing or {}).get("stack") or []))
    wanted = [card_id for card_id in dict.fromkeys(_ids(kind, stacks)) if card_id not in held]
    if not wanted:
        return
    if kind == LL_KIND:
        from .lora_loadout.library_index import LoraLibraryIndex
        index = LoraLibraryIndex()
        index.refresh(check_folders=False)
        # A caller restricted from LoRAs sees every new id as unknown (no probing by id).
        unknown = [card_id for card_id in wanted if index.get(card_id) is None or not policy.readable("models", "lora")]
    elif kit.source["kind"] == "prompt":
        readable = policy.readable_prompt_matches(wanted)
        unknown = [card_id for card_id in wanted if not readable.get(card_id)]
    else:
        from .lora_loadout.library_index import LoraLibraryIndex
        from .model_library.library_index import ModelLibraryIndex
        folder = kit.source.get("folder") or ""   # "" = any folder; "lora" = LoRA Loadout's
        indexes = []
        if folder in ("", "lora"):
            indexes.append(("lora", LoraLibraryIndex()))
        if folder != "lora":
            indexes.append(("", ModelLibraryIndex()))
        for _name_, index in indexes:
            index.refresh(check_folders=False)

        def known(card_id):
            for lineage, index in indexes:
                record = index.get(card_id)
                if record is not None and (not folder or lineage == "lora" or record.get("modelType") == folder):
                    kind_key = "lora" if lineage == "lora" else policy.model_type_key(record)
                    return policy.readable("models", kind_key)
            return False

        unknown = [card_id for card_id in wanted if not known(card_id)]
    if unknown:
        raise BadRequest(f"Not in the library this stack draws from: {unknown[0]}")


def _text(payload, key, required):
    value = payload.get(key)
    if value is None and not required:
        return None
    if not isinstance(value, str):
        raise BadRequest(f"{key} must be a string")
    return value


def _name(kind, group, name):
    from .preset_naming import canonical_label

    if not canonical_label(name):
        raise BadRequest("name can't be empty")
    reserved = _reserved(kind)
    if reserved(group, name):
        raise BadRequest(f"{name!r} is reserved (--empty--, --unsaved--, or empty in --none--)")


def _reserved(kind):
    if kind == LL_KIND:
        from .lora_loadout.presets import is_reserved_preset_name
    else:
        from .loadout_kit.presets import is_reserved_preset_name
    return is_reserved_preset_name


def _object(payload):
    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    return payload


def _version(payload):
    value = payload.get("version")
    if not isinstance(value, str) or not value:
        raise BadRequest("version is required: the preset's version from your last read (/presets?kind=…&full=1)")
    return value


def _save(kind, store, record_id, group, name, stacks, enabled):
    if kind == LL_KIND:
        return store.upsert(record_id, group, name, stacks=stacks, stack_enabled=enabled)
    return store.upsert(record_id, group, name, stacks)


def _current(kind, store, preset_id, expected):
    """The stored preset, after the version check (inside the caller's transaction)."""
    policy.require_preset(kind, preset_id, write=True, message="No preset of that kind has that id.")
    record = store.find_by_id(preset_id)
    if record is None:
        raise NotFound("No preset of that kind has that id.")
    if preset_version(kind, record) != expected:
        raise Conflict("That preset changed since you read it. Read it again, then retry.", _entry_body(record, kind))
    return record


# ---- writes -------------------------------------------------------------------------

def create_preset(kind, payload):
    """POST /krc/ext/v1/presets/{kind} {group?, name, payload?} -> 201 {preset, revision}."""
    from .db import connection as db

    payload = _object(payload)
    store, kit = _store(kind)
    policy.require_create(policy.preset_scope(kind), "presets of that kind")
    group = _text(payload, "group", False) or ""
    name = _text(payload, "name", True)
    _name(kind, group, name)
    stacks, enabled = _payload(kind, kit, payload.get("payload") or {})
    _check_known(kind, kit, stacks)   # before the transaction: a cold library may scan
    with db.write():
        record = _save(kind, store, "", group, name, stacks, enabled)
    if record is None:
        raise BadRequest("That name is reserved")
    policy.created(policy.preset_scope(kind), record["id"])
    _announce(kind)
    return _answer(kind, record)


def update_preset(kind, preset_id, payload):
    """POST /krc/ext/v1/presets/{kind}/{id}/update {version, group?, name?, payload?}: any of
    them; what's left out stays. -> {preset, revision}."""
    from .db import connection as db

    payload = _object(payload)
    store, kit = _store(kind)
    expected = _version(payload)
    group, name = _text(payload, "group", False), _text(payload, "name", False)
    new = payload.get("payload")
    if group is None and name is None and new is None:
        raise BadRequest("Nothing to change: send group, name or payload")
    checked = _payload(kind, kit, new) if new is not None else None
    if checked is not None:
        # Before the transaction (a cold library may scan); the version check below makes
        # sure the preset these "already held" ids came from is the one being replaced.
        _check_known(kind, kit, checked[0], _current(kind, store, preset_id, expected))
    with db.write():
        record = _current(kind, store, preset_id, expected)
        group = record.get("group", "") if group is None else group
        name = record.get("name", "") if name is None else name
        _name(kind, group, name)
        if checked is None:
            stacks = record.get("stacks") if kind == LL_KIND else record.get("stack")
            enabled = record.get("stackEnabled") if kind == LL_KIND else None
        else:
            stacks, enabled = checked
        saved = _save(kind, store, preset_id, group, name, stacks, enabled)
    if saved is None:
        raise BadRequest("That name is reserved")
    _announce(kind)
    return _answer(kind, saved)


def rename_preset(kind, preset_id, payload):
    """POST /krc/ext/v1/presets/{kind}/{id}/rename {version, name, group?}."""
    payload = _object(payload)
    _text(payload, "name", True)
    return update_preset(kind, preset_id, {key: payload[key] for key in ("version", "name", "group") if key in payload})


def delete_preset(kind, preset_id, payload):
    """POST /krc/ext/v1/presets/{kind}/{id}/delete {version}. Prompt Vault links to it, and
    nodes that had it active, show it missing (as when a node deletes it)."""
    from .db import connection as db
    from .db.presets import change_store

    payload = _object(payload)
    store, _kit = _store(kind)
    expected = _version(payload)
    with db.write():
        _current(kind, store, preset_id, expected)
        store.delete(preset_id)
    _announce(kind)
    return {"deleted": preset_id, "revision": db.revision(change_store(kind))}
