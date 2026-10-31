"""Loadout Kit: build a card-stack node from a descriptor (Card API Layer 2).

Python half: fields.py (per-slot field descriptors), presets.py (per-kit preset store),
kit.py (LoadoutKit runtime), routes.py (descriptor + preset routes). Exposed to other
packs through krc_public_api.py with the JS half (LOADOUT_KIT_GAMEPLAN.md, step 2).
"""

from .fields import kit_field
from .kit import LoadoutKit, Loadout, get_kit

__all__ = ["LoadoutKit", "Loadout", "get_kit", "kit_field"]
