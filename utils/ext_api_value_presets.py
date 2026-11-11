"""Config Switcher and Word Bank preset writes for the external API (2026-11-10;
KRC_EXTERNAL_API.md "Config Switcher and Word Bank preset writes"). Capabilities
"presets.cs.write" and "presets.wb.write", areas configSwitcherPresets / wordBankPresets.

A workflow the app's user can't see is built on these presets, so the API changes only what
a run reads as values, never their shape:

- **Config Switcher:** the parameters (fields) are locked: none added, removed, reordered or
  redefined (type, label, choices, ranges). An update may change config values, add, rename
  or delete configs (named value sets; at least one stays), the active and default config,
  shared values, and the preset's name and group. Values are cleaned as the node cleans
  them (ConfigSwitcherPresetStore).
- **Word Bank:** the rows are locked: none added, removed or reordered, and a row's
  category stays. An update may change each row's value and lock, and the name and group.
- Presets aren't created or deleted through the API (403 operation_not_permitted).

Every update needs ``version`` (value_preset_version: /presets?full=1 lists it) and answers
409 with the current preset when it changed since.
"""
import hashlib
import json

from . import ext_api_policy as policy
from .ext_api_media_writes import Conflict, NotFound
from .ext_api_routes import BadRequest

KINDS = ("cs", "wb")
MAX_CONFIGS = 64
CONFIG_NAME_MAX = 60
VALUE_MAX = 10000
CS_PAYLOAD = ("configs", "active_config", "default_config", "shared_values")
WB_PAYLOAD = ("rows",)
# Read-back keys a client may send unchanged with a round-tripped payload.
ECHO_KEYS = ("fields", "schema", "version", "modified")


def value_preset_version(kind, record):
    """A short hash of everything a client sees of a Config Switcher / Word Bank preset."""
    if kind == "cs":
        seen = {key: record.get(key) for key in ("fields", "configs", "shared_values", "active_config", "default_config")}
    else:
        seen = {"rows": record.get("rows") or []}
    seen.update(group=record.get("group") or "", name=record.get("name") or "")
    return hashlib.sha1(json.dumps(seen, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()[:16]


def _store(kind):
    if kind == "cs":
        from .config_switcher_presets import ConfigSwitcherPresetStore
        return ConfigSwitcherPresetStore()
    from .word_bank_presets import WordBankPresetStore
    return WordBankPresetStore()


def _entry_body(kind, record):
    payload = {key: value for key, value in record.items() if key not in ("id", "group", "name", "modified")}
    payload["version"] = value_preset_version(kind, record)
    return {"kind": kind, "id": record["id"], "group": record.get("group", ""), "name": record.get("name", ""),
            "modified": record.get("modified") or 0, "payload": payload}


def _answer(kind, record):
    from .db import connection as db
    from .db.presets import change_store

    return {"preset": _entry_body(kind, record), "revision": db.revision(change_store(kind))}


def _announce(kind):
    from .server_sync import SYNC_EVENTS, publish_sync

    publish_sync(SYNC_EVENTS["CONFIG_SWITCHER_PRESETS_CHANGED" if kind == "cs" else "WORDBANK_PRESETS_CHANGED"], {})


def not_permitted(kind, action):
    noun = "Config Switcher" if kind == "cs" else "Word Bank"
    return policy.Denied(403, {"error": "operation_not_permitted",
                               "message": f"{noun} presets can't be {action} through the API: their shape belongs to "
                                          "workflows the app can't see. Edit an existing preset's values instead."})


def _object(payload):
    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    return payload


def _text(payload, key):
    value = payload.get(key)
    if value is not None and not isinstance(value, str):
        raise BadRequest(f"{key} must be a string")
    return value


def _current(kind, store, preset_id, expected):
    policy.require_preset(kind, preset_id, write=True, message="No preset of that kind has that id.")
    record = next((item for item in store.load().get("presets") or [] if item.get("id") == preset_id), None)
    if record is None:
        raise NotFound("No preset of that kind has that id.")
    if value_preset_version(kind, record) != expected:
        raise Conflict("That preset changed since you read it. Read it again, then retry.", _entry_body(kind, record))
    return record


def _check_name(store, preset_id, group, name):
    from .preset_naming import canonical_group, canonical_label

    group, name = canonical_group(group), canonical_label(name)
    if not name:
        raise BadRequest("A preset name can't be empty")
    if any(item.get("id") != preset_id and canonical_group(item.get("group")) == group and item.get("name") == name
           for item in store.load().get("presets") or []):
        raise BadRequest("Another preset already has that group and name")
    return group, name


def _cs_values(record, payload):
    """The new configs / shared values / active and default config, checked against the
    locked parameters."""
    field_ids = [field["id"] for field in record.get("fields") or []]
    shared_ids = {field["id"] for field in record.get("fields") or [] if field.get("shared")}
    unknown_keys = sorted(set(payload) - set(CS_PAYLOAD) - set(ECHO_KEYS))
    if unknown_keys:
        raise BadRequest(f"Unknown payload key {unknown_keys[0]!r} (one of {', '.join(CS_PAYLOAD)})")
    if "fields" in payload and payload["fields"] != record.get("fields"):
        raise BadRequest("Parameters can't be added, removed, reordered or changed through the API: send them unchanged, "
                         "or leave fields out")
    configs = payload.get("configs", record.get("configs") or {})
    if not isinstance(configs, dict) or not configs:
        raise BadRequest("configs must be an object of at least one named config: {\"<name>\": {\"<parameter id>\": value}}")
    if len(configs) > MAX_CONFIGS:
        raise BadRequest(f"At most {MAX_CONFIGS} configs")
    for name, values in configs.items():
        if not isinstance(name, str) or not name.strip() or len(name) > CONFIG_NAME_MAX:
            raise BadRequest(f"Config names are 1 to {CONFIG_NAME_MAX} characters")
        if not isinstance(values, dict):
            raise BadRequest(f"Config {name!r} must be an object of parameter id -> value")
        extra = sorted(set(values) - set(field_ids))
        if extra:
            raise BadRequest(f"Config {name!r} names an unknown parameter {extra[0]!r}: parameters can't be added "
                             "through the API")
    shared = payload.get("shared_values", record.get("shared_values") or {})
    if not isinstance(shared, dict) or set(shared) - shared_ids:
        raise BadRequest("shared_values may only hold the preset's shared parameters")
    active = payload.get("active_config", record.get("active_config") or "")
    default = payload.get("default_config", record.get("default_config") or "")
    for key, value in (("active_config", active), ("default_config", default)):
        if not isinstance(value, str) or (value and value not in configs):
            raise BadRequest(f"{key} must name one of the configs (or be \"\")")
    if len(json.dumps(configs)) > 4 * 1024 * 1024:
        raise BadRequest("configs are too large")
    return configs, shared, active, default


def _wb_rows(record, payload):
    unknown_keys = sorted(set(payload) - set(WB_PAYLOAD) - set(ECHO_KEYS))
    if unknown_keys:
        raise BadRequest(f"Unknown payload key {unknown_keys[0]!r} (rows)")
    stored = record.get("rows") or []
    rows = payload.get("rows", stored)
    if not isinstance(rows, list) or len(rows) != len(stored):
        raise BadRequest(f"rows must keep the preset's {len(stored)} rows, in order: rows can't be added, removed or "
                         "reordered through the API")
    out = []
    for index, (row, old) in enumerate(zip(rows, stored)):
        if not isinstance(row, dict) or set(row) - {"categoryId", "category", "value", "locked"}:
            raise BadRequest(f"Row {index}: an object of categoryId, category, value, locked")
        for key in ("categoryId", "category"):
            if key in row and row[key] != old.get(key):
                raise BadRequest(f"Row {index}: its {key} can't change (rows can't be reordered or replaced)")
        value = row.get("value", old.get("value", ""))
        locked = row.get("locked", old.get("locked", False))
        if not isinstance(value, str) or len(value) > VALUE_MAX:
            raise BadRequest(f"Row {index}: value must be a string (at most {VALUE_MAX} characters)")
        if not isinstance(locked, bool):
            raise BadRequest(f"Row {index}: locked must be true or false")
        out.append({**old, "value": value, "locked": locked})
    return out


def update_preset(kind, preset_id, payload):
    """POST /krc/ext/v1/presets/{cs|wb}/{id}/update {version, group?, name?, payload?}."""
    from .db import connection as db

    payload = _object(payload)
    unknown = sorted(set(payload) - {"version", "group", "name", "payload"})
    if unknown:
        raise BadRequest(f"Unknown field {unknown[0]!r} (version, group, name, payload)")
    expected = payload.get("version")
    if not isinstance(expected, str) or not expected:
        raise BadRequest("version is required: the preset's version from your last read (/presets?full=1)")
    group, name = _text(payload, "group"), _text(payload, "name")
    body = payload.get("payload")
    if group is None and name is None and body is None:
        raise BadRequest("Nothing to change: send group, name or payload")
    if body is not None and not isinstance(body, dict):
        raise BadRequest("payload must be an object")
    store = _store(kind)
    with db.write():
        record = _current(kind, store, preset_id, expected)
        group, name = _check_name(store, preset_id, record.get("group", "") if group is None else group,
                                  record.get("name", "") if name is None else name)
        try:
            if kind == "cs":
                configs, shared, active, default = _cs_values(record, body or {})
                saved = store.upsert(preset_id, group, name, fields=record.get("fields"), configs=configs,
                                     active_config=active, default_config=default, shared_values=shared)
            else:
                rows = _wb_rows(record, body or {})
                saved = store.upsert_by_id(preset_id, group, name, rows)
        except ValueError as exc:   # e.g. a preset saved by a newer KRC
            raise BadRequest(str(exc)) from None
    if saved is None:
        raise BadRequest("A preset name can't be empty")
    _announce(kind)
    return _answer(kind, saved)


def rename_preset(kind, preset_id, payload):
    """POST /krc/ext/v1/presets/{cs|wb}/{id}/rename {version, name, group?}."""
    payload = _object(payload)
    if not isinstance(payload.get("name"), str):
        raise BadRequest("name must be a string")
    return update_preset(kind, preset_id, {key: payload[key] for key in ("version", "name", "group") if key in payload})
