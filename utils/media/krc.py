"""Media's door to the rest of KRC NodePack: its public API (krc_public_api.py).

Media was built as a separate pack on that API alone (KRC Media IO, moved in 2026-10-29,
MEDIA_INTO_NODEPACK_GAMEPLAN.md), and keeps calling through it, so the API stays used by a
real consumer. Imported on first use: the API module imports much of the pack.
"""

_api = None


def api():
    """KRC NodePack's public API module."""
    global _api
    if _api is None:
        from ... import krc_public_api

        _api = krc_public_api
    return _api
