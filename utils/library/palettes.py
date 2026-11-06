"""KRC's colour palettes for the backend: the list, and the palettes the user picked.

The list lives in one file, ``web/js/shared/palettes.js`` (``PALETTES``, ``DEFAULT_PALETTE_ID``,
``PORTAL_NATIVE_FALLBACK_ID``). As with card colours (card_colors.py), it's parsed from there
so the backend never keeps a second copy that drifts.

The picks are ComfyUI settings the page saves for the user (``KRC.Theme``, the global palette;
``KRC.PortalTheme``, the KRC Portal's). ComfyUI keeps them in
``user/default/comfy.settings.json``; the external API reads them from there (ext/v1 /info).
"""

import json
import re
from pathlib import Path

from ..krc_paths import get_default_user_dir

_PALETTES_JS = Path(__file__).resolve().parents[2] / "web" / "js" / "shared" / "palettes.js"

GLOBAL_SETTING = "KRC.Theme"
PORTAL_SETTING = "KRC.PortalTheme"
DEFAULT_ID = "default"      # the base purple palette (no data-krc-theme attribute)
NATIVE_ID = "native"        # see the native fallback below

# Used only if palettes.js can't be read; mirrors it.
_FALLBACK = (
    [("blue", "KRC Blue"), ("default", "KRC Purple"), ("red", "KRC Red"), ("yellow", "KRC Yellow"),
     ("gray", "KRC Gray"), ("dark", "KRC Dark"), ("high-contrast", "KRC High Contrast"), ("native", "Native")],
    "gray",
    "gray",
)


def _load():
    try:
        text = _PALETTES_JS.read_text(encoding="utf-8")
    except OSError:
        return _FALLBACK
    block = re.search(r"export const PALETTES\s*=\s*\[(.*?)\];", text, re.S)
    entries = re.findall(r'\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\}', block.group(1)) if block else []
    default = re.search(r'export const DEFAULT_PALETTE_ID\s*=\s*"([^"]+)"', text)
    native_fallback = re.search(r'export const PORTAL_NATIVE_FALLBACK_ID\s*=\s*"([^"]+)"', text)
    if not entries:
        return _FALLBACK
    return (entries, default.group(1) if default else _FALLBACK[1],
            native_fallback.group(1) if native_fallback else _FALLBACK[2])


_ENTRIES, DEFAULT_PALETTE_ID, NATIVE_FALLBACK_ID = _load()
PALETTE_IDS = frozenset(entry_id for entry_id, _label in _ENTRIES)


def palette_list():
    """[{"id", "label"}] in display order (palettes.js PALETTES)."""
    return [{"id": entry_id, "label": label} for entry_id, label in _ENTRIES]


def read_settings(path=None):
    path = Path(path) if path else get_default_user_dir() / "comfy.settings.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def global_palette(settings=None):
    """The global palette as the page applies it (krc_theme.js applyPalette): never set ->
    DEFAULT_PALETTE_ID; "" or an unknown id -> "default" (the base palette)."""
    settings = read_settings() if settings is None else settings
    if GLOBAL_SETTING not in settings:
        return DEFAULT_PALETTE_ID
    value = str(settings.get(GLOBAL_SETTING) or "")
    return value if value in PALETTE_IDS else DEFAULT_ID


def portal_palette(settings=None):
    """The KRC Portal's palette as it shows (palettes.js portalPaletteId): its own pick, else
    the global palette; never Native (Native has no node colour behind it: the fallback)."""
    settings = read_settings() if settings is None else settings
    choice = str(settings.get(PORTAL_SETTING) or "")
    if choice in PALETTE_IDS and choice != NATIVE_ID:
        return choice
    current = global_palette(settings)
    return NATIVE_FALLBACK_ID if current == NATIVE_ID else current
