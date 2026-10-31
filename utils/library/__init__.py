"""Shared KRC library bases.

Neutral home for the Python backend engines behind LoRA Loadout (LL) and Model
Library (ML). Each base holds the logic that is identical across the two nodes;
the per-node divergence (storage dir / filename, field set, route prefix) is
supplied by the node as a thin descriptor / subclass.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (Section C). Populated stage by stage:
- B1 identity store  -> identity.py
"""
