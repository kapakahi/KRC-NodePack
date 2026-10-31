"""Loadout Kit field descriptors: the per-slot values a kit's strip shows and its
loader receives (RefMod's strength / copies / components / visual / audio).

A field is a plain JSON-able dict, so the JS kit reads the same definition from the
descriptor route (one source of truth). Coercion clamps / falls back exactly like the
RefMod Loadout node did, so a stored or hand-edited value can never reach a loader out
of range.
"""

import math
import re

FIELD_TYPES = ("float", "int", "enum", "bool")

# Keys a stack entry already uses for itself; a field may not shadow them.
RESERVED_KEYS = frozenset({"id", "sha256", "order", "enabled", "slot", "path", "text", "name", "category"})

_KEY_RE = re.compile(r"^[a-z][a-z0-9_]{0,39}$")


def kit_field(key, type, minimum=None, maximum=None, *, default=None, step=None, options=None,
              label="", title="", dim_when=None):
    """One per-slot field.

    - ``float`` / ``int``: ``minimum`` and ``maximum`` are required; ``default`` falls back
      to ``minimum``; ``step`` (float only) sets the editor step and the shown decimals
      (default 0.01).
    - ``enum``: ``options`` (non-empty list of strings); ``default`` falls back to the first.
    - ``bool``: ``default`` falls back to False.
    - ``label``: the short letter shown before the pill ("S:"); ``title``: the tooltip.
    - ``dim_when``: ``{other_field_key: [values]}`` dims this field (it stays editable and
      in place) while another field — an ``enum`` or ``bool`` — holds one of those values
      (booleans are stored as "true" / "false", matching the JS side).
    """
    key = str(key or "")
    if not _KEY_RE.match(key) or key in RESERVED_KEYS:
        raise ValueError(f"kit_field: invalid or reserved key {key!r}")
    if type not in FIELD_TYPES:
        raise ValueError(f"kit_field {key!r}: type must be one of {FIELD_TYPES}")
    field = {"key": key, "type": type, "label": str(label or ""), "title": str(title or key)}
    if type in ("float", "int"):
        if minimum is None or maximum is None:
            raise ValueError(f"kit_field {key!r}: {type} needs minimum and maximum")
        cast = float if type == "float" else int
        lo, hi = cast(minimum), cast(maximum)
        if not lo <= hi or (type == "float" and not (math.isfinite(lo) and math.isfinite(hi))):
            raise ValueError(f"kit_field {key!r}: bad range {minimum}..{maximum}")
        field.update({"min": lo, "max": hi})
        if type == "float":
            field["step"] = float(step) if step is not None else 0.01
            if not math.isfinite(field["step"]) or field["step"] <= 0:
                raise ValueError(f"kit_field {key!r}: step must be positive")
        initial = cast(lo if default is None else default)
        if type == "float" and not math.isfinite(initial):
            raise ValueError(f"kit_field {key!r}: default must be finite")
        field["default"] = _clamp(initial, lo, hi)
    elif type == "enum":
        choices = [str(option) for option in (options or [])]
        if not choices or len(set(choices)) != len(choices):
            raise ValueError(f"kit_field {key!r}: enum needs distinct options")
        field["options"] = choices
        field["default"] = str(default) if default is not None and str(default) in choices else choices[0]
    else:
        field["default"] = bool(default)
    if dim_when:
        if not isinstance(dim_when, dict):
            raise ValueError(f"kit_field {key!r}: dim_when must be a dict")
        field["dimWhen"] = {str(other): [_dim_value(value) for value in values] for other, values in dim_when.items()}
    return field


def _dim_value(value):
    return ("true" if value else "false") if isinstance(value, bool) else str(value)


def validate_fields(fields):
    """A kit's field list: dicts from :func:`kit_field`, unique keys, ``dim_when`` naming
    other fields of the same kit. Returns a copied list."""
    out = [dict(field) for field in (fields or [])]
    keys = [field.get("key") for field in out]
    if any(not isinstance(field, dict) or field.get("type") not in FIELD_TYPES for field in out):
        raise ValueError("loadout kit: fields must come from kit_field()")
    if len(set(keys)) != len(keys):
        raise ValueError("loadout kit: duplicate field keys")
    by_key = {field["key"]: field for field in out}
    for field in out:
        for other in (field.get("dimWhen") or {}):
            if other not in by_key or other == field["key"]:
                raise ValueError(f"loadout kit: field {field['key']!r} dim_when names unknown field {other!r}")
            if by_key[other]["type"] not in ("enum", "bool"):
                raise ValueError(f"loadout kit: field {field['key']!r} dim_when must name an enum or bool field")
    return out


def _clamp(value, lo, hi):
    return max(lo, min(hi, value))


def coerce_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in ("", "0", "false", "no", "off", "none")
    return bool(value)


def coerce_field(field, value):
    """A stored / incoming value -> a valid value for this field (default when unusable)."""
    kind = field["type"]
    if kind == "float":
        try:
            number = float(value)
        except (TypeError, ValueError):
            return field["default"]
        if not math.isfinite(number):
            return field["default"]
        return _clamp(number, field["min"], field["max"])
    if kind == "int":
        try:
            number = int(round(float(value)))
        except (TypeError, ValueError, OverflowError):
            return field["default"]
        return _clamp(number, field["min"], field["max"])
    if kind == "enum":
        return value if value in field["options"] else field["default"]
    return field["default"] if value is None else coerce_bool(value)
