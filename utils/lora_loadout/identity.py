"""LoRA Loadout identity store (thin descriptor over the shared base).

All store logic lives in ``utils/library/identity.py``; this module only binds
the LoRA Loadout lineage ("loras" in krc.db) and re-exports the shared helpers so existing
``from .identity import ...`` call sites are unchanged.
"""

from pathlib import Path

from ..db.library import LORAS
from ..krc_paths import get_krc_node_dir
from ..library.identity import (  # noqa: F401  (re-exported for call sites)
    IdentityStore as _BaseIdentityStore,
    compute_sha256,
    file_signature,
    is_local_library_id,
)


KRC_DIR_NAME = "lora_loadout"
IDENTITY_FILENAME = "lora_loadout_identity.json"


def get_identity_path():
    """The pre-database identity file, read once by the stage-3 import."""
    fallback = Path(__file__).resolve().parents[2] / ".krc_user" / "default" / KRC_DIR_NAME
    return get_krc_node_dir(KRC_DIR_NAME, fallback=fallback) / IDENTITY_FILENAME


class IdentityStore(_BaseIdentityStore):
    LINEAGE = LORAS
