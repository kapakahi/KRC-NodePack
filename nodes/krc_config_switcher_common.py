"""Shared helpers for ConfigSwitcher nodes."""

import re

_INT_RE = re.compile(r"-?\d+")
_TRUE = {"true", "1", "on", "yes"}
_NUMBER_OUTPUT_FORMATS = {"auto", "integer", "float"}

# Hard ceiling on Config Switcher Link output sockets. ComfyUI's Python node
# metadata is static, while the frontend reveals/labels only the chosen fields.
MAX_CONFIG_OUTPUTS = 30


class AnyType(str):
    """A type string that compares equal to every other type.

    ComfyUI checks output/input type compatibility with a `!=` comparison; by
    always reporting "not unequal", this lets an output connect to inputs of any
    declared type, including combo/dropdown widgets. The frontend also treats
    the literal "*" as a wildcard.
    """

    def __ne__(self, _other):
        return False


ANY = AnyType("*")


def coerce_boolean_value(value):
    """Toggle fields emit a real boolean (the output-format modes were removed — a
    two-option Combo covers stringy toggle roles)."""
    return str(value).strip().lower() in _TRUE


def coerce_typed_value(value, ftype, field=None):
    """Convert a stored ConfigSwitcher value by its declared field type."""
    if ftype == "boolean":
        return coerce_boolean_value(value)
    # SEED emits an exact int (never through float(): big seeds would lose digits),
    # clamped to 0..2**64-1; empty or junk is 0.
    if ftype == "seed":
        digits = "".join(ch for ch in str(value if value is not None else "") if ch.isdigit())
        return min(int(digits or "0"), 2 ** 64 - 1)
    if value is None:
        return None
    s = str(value).strip()
    if s == "":
        return None
    # Raw STRING (and combo) emit plain text — no number/bool coercion. Explicit so
    # the contract is clear and stays put if the trailing default ever changes.
    if ftype == "string":
        return str(value)
    # PROMPT stores the snapshotted prompt text as its value, so it emits plain text
    # exactly like a raw STRING (the field's card/dropdown is editor-only metadata).
    if ftype == "prompt":
        return str(value)
    if ftype == "number":
        raw_format = field.get("numberOutput", "auto") if isinstance(field, dict) else "auto"
        fmt = raw_format if raw_format in _NUMBER_OUTPUT_FORMATS else "auto"
        if fmt == "integer":
            try:
                return int(float(s))
            except ValueError:
                return 0
        if fmt == "float":
            try:
                return float(s)
            except ValueError:
                return 0.0
        if _INT_RE.fullmatch(s):
            return int(s)
        try:
            return float(s)
        except ValueError:
            return 0
    return str(value)
