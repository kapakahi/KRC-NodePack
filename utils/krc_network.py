"""
KRC global network-access consent — the master switch.

Default ON (nothing stored yet = enabled); turning it off makes KRC do no outbound
network calls. The UI is a
ComfyUI setting (KRC.Network.AllowInternet, registered in web/js/krc_theme.js); the
client POSTs changes to /krc/network/consent so the server-side egress guard can read
the value for route-driven fetches. Mirrors the krc_video_settings sync pattern.

Stored in krc.db (settings key CONSENT_KEY, KRC_SQLITE_GAMEPLAN.md stage 4). Nothing
stored follows the default; an unreadable value or database fails closed (disabled).
Nothing in the pack should open a socket without first checking network_enabled().
"""
from pathlib import Path

from .db import library as library_db
from .krc_paths import get_krc_nodes_dir

CONSENT_FILENAME = "network_consent.json"  # pre-database file (stage-4 import)
CONSENT_KEY = "network.consent"
# Mirror of NETWORK_CONSENT_DEFAULT (web/js/shared/network_consent.js).
NETWORK_DEFAULT = True
_FALLBACK_USER_DIR = Path(__file__).resolve().parents[1] / ".krc_user" / "default"


def legacy_consent_path():
    """The pre-database consent file, read once by the stage-4 import."""
    return get_krc_nodes_dir(fallback=_FALLBACK_USER_DIR) / CONSENT_FILENAME


def network_enabled():
    """Whether internet access is allowed. Nothing stored yet → the default (on);
    an unreadable value or database → disabled (fail-closed)."""
    try:
        data = library_db.document_get(CONSENT_KEY)
    except Exception:  # noqa: BLE001 - fail closed
        return False
    if data is None:
        return NETWORK_DEFAULT
    return bool(data.get("allowInternet", NETWORK_DEFAULT)) if isinstance(data, dict) else False


def set_network_enabled(value):
    """Persist the consent flag (synced from the ComfyUI setting). Returns the value."""
    library_db.document_put(CONSENT_KEY, {"allowInternet": bool(value)})
    return bool(value)
