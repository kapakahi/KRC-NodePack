"""
KRC NodePack — shared helpers
==============================
Central home for utilities and base classes shared across KRC NodePack nodes.

Currently intentionally minimal: the consolidated nodes are largely independent
and their image-conversion paths differ enough (single-frame vs. batch,
JPEG-base64 vs. PNG) that forcing them through a shared helper would change
behavior. This module exists as the agreed place to put genuinely shared code
as it emerges, without re-deriving where it should live.
"""

__version__ = "1.1.0"
