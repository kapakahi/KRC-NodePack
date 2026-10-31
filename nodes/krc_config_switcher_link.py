"""KRC Config Switcher Link — expose a config payload as graph outputs."""

import json

from ..utils.config_switcher_dynamic import clean_dynamic_schema, resolve_dynamic_value
from .krc_config_switcher_common import ANY, MAX_CONFIG_OUTPUTS, coerce_typed_value


class KRCConfigSwitcherLink:
    DESCRIPTION = (
        "Expose fields from a connected KRC Config Switcher as output sockets. "
        "Use the frontend Update links button after changing parameters."
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "link_data": ("STRING", {"default": "[]"}),
            },
            "optional": {
                "config": ("KRC_CONFIG",),
            },
        }

    RETURN_TYPES = (ANY,) * MAX_CONFIG_OUTPUTS
    RETURN_NAMES = tuple(f"out_{i}" for i in range(MAX_CONFIG_OUTPUTS))
    FUNCTION = "run"
    CATEGORY = "KRC NodePack"

    def run(self, link_data="[]", config=None):
        fields = self._decode_link_fields(link_data)
        payload = config if isinstance(config, dict) else {}
        live_fields = payload.get("fields") if isinstance(payload.get("fields"), list) else []
        values = payload.get("values") if isinstance(payload.get("values"), dict) else {}
        live_by_id = {
            str(field.get("id")): field
            for field in live_fields
            if isinstance(field, dict) and field.get("id") is not None
        }

        out = [None] * MAX_CONFIG_OUTPUTS
        for i, link in enumerate(fields[:MAX_CONFIG_OUTPUTS]):
            if not isinstance(link, dict):
                continue
            field_id = str(link.get("id") or "")
            if not field_id:
                continue
            field = live_by_id.get(field_id, link)
            ftype = field.get("type", link.get("type", "string"))
            if ftype == "dynamic_combo":
                # The dict the DynamicCombo input expects, from the config's whole set
                # (CS_DYNAMIC_COMBO_GAMEPLAN.md D7).
                schema = clean_dynamic_schema(field.get("dynamicCombo"))
                out[i] = resolve_dynamic_value({**field, "dynamicCombo": schema}, values) if schema else None
                continue
            out[i] = coerce_typed_value(values.get(field_id), ftype, field)

        return {
            "ui": {
                "text": [self._status_text(fields, payload)],
            },
            "result": tuple(out),
        }

    def _decode_link_fields(self, raw):
        if isinstance(raw, list):
            return raw
        try:
            decoded = json.loads(raw or "[]")
        except (TypeError, json.JSONDecodeError):
            return []
        return decoded if isinstance(decoded, list) else []

    def _status_text(self, fields, payload):
        if not isinstance(payload, dict) or not payload:
            return "No Config Switcher connected"
        active = payload.get("active_config") or "scratch"
        return f"{min(len(fields), MAX_CONFIG_OUTPUTS)} fields · {active}"


NODE_CLASS_MAPPINGS = {
    "KRC Config Switcher Link": KRCConfigSwitcherLink,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Config Switcher Link": "KRC Config Switcher Link",
}
