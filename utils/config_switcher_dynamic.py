"""Config Switcher DYNAMIC COMBO (CS_DYNAMIC_COMBO_GAMEPLAN.md): the pure rules, the server
half. Mirror of web/js/config_switcher/dynamic_combo.js; keep the two in step.

A DYNAMIC COMBO field drives a V3 DynamicCombo input. Its captured schema is stored on the
field (`dynamicCombo`, D4):
  {inputId, options: [{key, unsupported, settings: [{name, type, default, min, max, step,
   multiline, options}]}]}
Each config stores the picked key under the field id and each setting under
`<id>:<option>:<setting>`, remembered per option (D8). Keys are always built from the
schema, never parsed. The run sends `{<inputId>: <key>, <setting>: <value>, ...}` with
every setting of the picked option, typed, in range and on step (D7). `dynamicHidden`
lists supported option keys hidden from the dropdown (D14): a pick on one falls back like
an unsupported pick.
"""

import math

DYNAMIC_COMBO_TYPE = "dynamic_combo"
SETTING_TYPES = ("FLOAT", "INT", "BOOLEAN", "STRING", "COMBO")
_TRUE_WORDS = {"true", "1", "yes", "on"}
_FALSE_WORDS = {"false", "0", "no", "off"}


def setting_key(field_id, option_key, setting_name):
    return f"{field_id}:{option_key}:{setting_name}"


def _finite(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value) if math.isfinite(value) else None
    if value is None or str(value).strip() == "":
        return None
    try:
        number = float(str(value).strip())
    except ValueError:
        return None
    return number if math.isfinite(number) else None


def _clean_strings(values):
    out = []
    for value in values if isinstance(values, list) else []:
        text = str(value if value is not None else "").strip()
        if text and text not in out:
            out.append(text)
    return out


def clean_setting(raw):
    """One setting as stored: its name, a supported type and that type's spec; None if unusable."""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()
    setting_type = str(raw.get("type") or "").upper()
    if not name or setting_type not in SETTING_TYPES:
        return None
    setting = {"name": name, "type": setting_type}
    if setting_type in ("FLOAT", "INT"):
        for key in ("default", "min", "max", "step"):
            number = _finite(raw.get(key))
            if number is not None:
                setting[key] = int(number) if setting_type == "INT" else number
        if "step" in setting and setting["step"] <= 0:
            del setting["step"]
    elif setting_type == "BOOLEAN":
        if isinstance(raw.get("default"), bool):
            setting["default"] = raw["default"]
    elif setting_type == "STRING":
        if raw.get("default") is not None:
            setting["default"] = str(raw["default"])
        if raw.get("multiline") is True:
            setting["multiline"] = True
    else:
        setting["options"] = _clean_strings(raw.get("options"))
        if not setting["options"]:
            return None
        if raw.get("default") is not None and str(raw["default"]) in setting["options"]:
            setting["default"] = str(raw["default"])
    return setting


def clean_dynamic_schema(raw):
    """The stored schema, cleaned; None without an input id or a single option."""
    if not isinstance(raw, dict):
        return None
    input_id = str(raw.get("inputId") or "").strip()
    seen = set()
    options = []
    for option in raw.get("options") if isinstance(raw.get("options"), list) else []:
        if not isinstance(option, dict):
            continue
        key = str(option.get("key") or "").strip()
        if not key or key in seen:
            continue
        seen.add(key)
        unsupported = str(option.get("unsupported") or "").strip()
        names = set()
        settings = []
        for item in [] if unsupported else (option.get("settings") if isinstance(option.get("settings"), list) else []):
            setting = clean_setting(item)
            if not setting or setting["name"] in names:
                continue
            names.add(setting["name"])
            settings.append(setting)
        options.append({"key": key, "unsupported": unsupported, "settings": settings})
    return {"inputId": input_id, "options": options} if input_id and options else None


def supported_options(schema):
    return [option for option in (schema or {}).get("options", []) if not option.get("unsupported")]


def clean_dynamic_hidden(schema, hidden):
    """The hidden option keys, cleaned against the schema; never every supported option."""
    supported = [option["key"] for option in supported_options(schema)]
    keys = []
    for key in hidden if isinstance(hidden, list) else []:
        key = str(key)
        if key in supported and key not in keys:
            keys.append(key)
    return [] if len(keys) >= len(supported) else keys


def visible_options(field):
    hidden = set(clean_dynamic_hidden(field.get("dynamicCombo"), field.get("dynamicHidden")))
    return [option for option in supported_options(field.get("dynamicCombo")) if option["key"] not in hidden]


def dynamic_value_keys(field):
    """Every value key the field owns, as one set (D15): the pick, then each supported
    option's settings."""
    field_id = field.get("id")
    keys = [field_id]
    for option in supported_options(field.get("dynamicCombo")):
        for setting in option["settings"]:
            keys.append(setting_key(field_id, option["key"], setting["name"]))
    return keys


def picked_option(field, values):
    options = visible_options(field)
    stored = str((values or {}).get(field.get("id")) or "")
    for option in options:
        if option["key"] == stored:
            return option
    return options[0] if options else None


def _clamp_and_snap(number, setting):
    value = number
    if "min" in setting:
        value = max(value, setting["min"])
    if "max" in setting:
        value = min(value, setting["max"])
    step = setting.get("step")
    if step:
        base = setting.get("min", 0)
        value = base + math.floor((value - base) / step + 0.5) * step
        if "max" in setting and value > setting["max"]:
            value -= step
        if "min" in setting and value < setting["min"]:
            value += step
    return value


def coerce_setting(setting, raw):
    """One setting's value as the node gets it (D7); missing or invalid -> the default (or
    the type's zero / first option)."""
    missing = raw is None
    setting_type = setting["type"]
    if setting_type == "FLOAT":
        number = None if missing else _finite(raw)
        if number is None:
            number = setting.get("default", setting.get("min", 0.0))
        return round(float(_clamp_and_snap(float(number), setting)), 10)
    if setting_type == "INT":
        parsed = None if missing else _finite(raw)
        number = setting.get("default", setting.get("min", 0)) if parsed is None else math.trunc(parsed)
        return int(math.trunc(_clamp_and_snap(number, setting)))
    if setting_type == "BOOLEAN":
        word = str(raw if raw is not None else "").strip().lower()
        if raw is True or word in _TRUE_WORDS:
            return True
        if raw is False or word in _FALSE_WORDS:
            return False
        return setting.get("default", False)
    if setting_type == "STRING":
        return setting.get("default", "") if missing else str(raw)
    text = "" if missing else str(raw)
    if text in setting["options"]:
        return text
    return setting.get("default", setting["options"][0])


def resolve_dynamic_value(field, values):
    """The dict the node gets for one config (D7), or None when no option is supported."""
    option = picked_option(field, values)
    if option is None:
        return None
    values = values or {}
    out = {field["dynamicCombo"]["inputId"]: option["key"]}
    for setting in option["settings"]:
        out[setting["name"]] = coerce_setting(setting, values.get(setting_key(field["id"], option["key"], setting["name"])))
    return out
