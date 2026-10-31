"""The preset link: what Prompt Vault's ``preset`` output sends to the loadouts.

PRESET_LINK_GAMEPLAN.md (dev repo). A ``KRC_PRESET`` wire carries preset **ids**, never
names, one entry per loadout it drives:

    {"v": 1, "missing": "keep" | "clear",
     "targets": {"lora": {"id", "rev"}, "<kit id>": {"id", "rev"}}}

A target's ``id`` is a preset id, or ``""`` for the blank slate (--empty--). No entry for
a target means "no opinion": that loadout keeps its stacks. ``rev`` is the preset's
``modified`` stamp (0 for empty or unknown), so a re-saved preset changes the link.
``missing`` says what a loadout does with an id it can't find: keep its stacks, or clear.

Readers are lenient about shape and strict about content: anything that isn't a version-1
link reads as no link, a malformed target as no entry. Mirrored in
web/js/shared/preset_link.js.
"""
import json
import math
import re

PRESET_LINK_TYPE = "KRC_PRESET"
PRESET_LINK_VERSION = 1

# LoRA Loadout's target (both nodes). Every other target is a Loadout Kit id, which can
# never be "lora" (utils/loadout_kit/kit.py reserves it).
LORA_TARGET = "lora"

MISSING_KEEP = "keep"
MISSING_CLEAR = "clear"
_MISSING = (MISSING_KEEP, MISSING_CLEAR)

# The stored "--empty--" link in a Prompt Vault record (``ll_preset`` / ``kitPresets``).
# Storage only: on the wire it is the id "".
STORED_EMPTY = "none:empty"

_TARGET_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
# Preset ids are uuid4 hex; anything printable ASCII without spaces, up to 200, is
# accepted. ASCII only, so Python and JS agree on trimming and length.
_ID_RE = re.compile(r"^[\x21-\x7e]{0,200}$")
_ASCII_SPACE = " \t\r\n"
# Above this a JS number can't hold the stamp exactly.
_REV_MAX = 2 ** 53 - 1


def _clean_id(value):
    """A target id (``""`` = empty), or None when it can't be one."""
    if not isinstance(value, str):
        return None
    value = value.strip(_ASCII_SPACE)
    return value if _ID_RE.match(value) else None


def _clean_rev(value):
    """A whole number in 0..2**53-1. Only real numbers count (no strings, no bools), so
    Python and JS read every value the same way."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if isinstance(value, float) and not math.isfinite(value):
        return 0
    rev = int(value)
    return rev if 0 < rev <= _REV_MAX else 0


def _clean_entry(entry):
    if not isinstance(entry, dict):
        return None
    preset_id = _clean_id(entry.get("id"))
    if preset_id is None:
        return None
    return {"id": preset_id, "rev": _clean_rev(entry.get("rev")) if preset_id else 0}


def build_link(targets, missing=MISSING_KEEP):
    """``targets`` -> a link. ``targets`` is ``{key: {"id", "rev"}}``; an entry whose id is
    None is left out (no opinion). Invalid keys and ids are dropped."""
    out = {}
    for key, entry in (targets.items() if isinstance(targets, dict) else ()):
        if not isinstance(key, str) or not _TARGET_RE.match(key):
            continue
        clean = _clean_entry(entry)
        if clean is not None:
            out[key] = clean
    return {
        "v": PRESET_LINK_VERSION,
        "missing": missing if missing in _MISSING else MISSING_KEEP,
        "targets": out,
    }


def normalize_link(value):
    """A link in canonical form, or None when ``value`` isn't a version-1 link."""
    if not isinstance(value, dict):
        return None
    version = value.get("v")
    if isinstance(version, bool) or version != PRESET_LINK_VERSION:
        return None
    targets = value.get("targets")
    if not isinstance(targets, dict):
        return None
    return build_link(targets, value.get("missing"))


def read_entry(link, key):
    """``{"id", "rev"}`` for ``key``, or None (no entry, or not a link)."""
    link = normalize_link(link)
    if link is None:
        return None
    return link["targets"].get(key)


def read_target(link, key):
    """The preset id ``key`` should load: an id, ``""`` for empty, or None for no opinion."""
    entry = read_entry(link, key)
    return entry["id"] if entry else None


def link_missing(link):
    """What a loadout does with an id it can't find: ``keep`` (also for no link) or ``clear``."""
    link = normalize_link(link)
    return link["missing"] if link else MISSING_KEEP


def link_signature(link):
    """A stable string for a link (``IS_CHANGED``); ``""`` when it isn't one. Byte-identical
    to the JS twin's."""
    link = normalize_link(link)
    if link is None:
        return ""
    return json.dumps(link, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def stored_target_id(value):
    """A Prompt Vault record's stored link -> the target id: None for no link (``""``),
    ``""`` for --empty--, else the preset id."""
    if not isinstance(value, str):
        return None
    value = value.strip(_ASCII_SPACE)
    if not value:
        return None
    if value == STORED_EMPTY:
        return ""
    return _clean_id(value)
