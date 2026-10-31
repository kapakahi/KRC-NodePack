"""Single source of truth for card-color ids, shared across the backend.

The palette itself — ids, labels and hex — lives in one file:
``web/js/shared/card_colors.js`` (the ``CARD_COLOR_PALETTE`` array). That is the
only file to edit to add, rename or recolor a card color.

The backend only needs the *set of valid ids* (to reject unknown folder / preset
color picks before persisting them). Rather than hand-maintaining a second list
that silently drifts out of sync — as it did once already (gold/purple/copper vs.
yellow/black/orange) — we parse the ids straight out of that JS file, so adding a
color there flows to the backend automatically. Import this ``CARD_COLOR_IDS``
wherever a pick needs validating.
"""

import re
from pathlib import Path

# utils/library/card_colors.py -> parents[2] is the repo root.
_CARD_COLORS_JS = Path(__file__).resolve().parents[2] / "web" / "js" / "shared" / "card_colors.js"

# Used only if the JS file can't be read (moved/renamed). Keeps the backend
# working rather than dropping every pick; mirror it when the JS palette changes
# so a fallback is never wildly stale, but the JS file is the real source.
_FALLBACK_IDS = frozenset({"yellow", "green", "black", "blue", "orange", "purple", "gray", "red"})


def _load_card_color_ids():
    try:
        text = _CARD_COLORS_JS.read_text(encoding="utf-8")
    except OSError:
        return _FALLBACK_IDS
    # Scope to the CARD_COLOR_PALETTE array so we only pick up palette entry ids
    # (not CARD_COLOR_NONE or any other `id:` that might appear elsewhere).
    block = re.search(r"CARD_COLOR_PALETTE\s*=\s*\[(.*?)\]", text, re.S)
    if not block:
        return _FALLBACK_IDS
    ids = frozenset(re.findall(r'id:\s*"([^"]+)"', block.group(1)))
    return ids or _FALLBACK_IDS


# Parsed once at import (the palette is static per running process; a palette
# edit is a dev change that restarts the server anyway).
CARD_COLOR_IDS = _load_card_color_ids()
