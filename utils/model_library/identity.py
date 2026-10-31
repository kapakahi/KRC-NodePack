"""Model Library identity store (thin descriptor over the shared base).

All store logic lives in ``utils/library/identity.py``; this module only binds
the Model Library lineage ("models" in krc.db) and re-exports the shared helpers so existing
``from .identity import ...`` call sites are unchanged.
"""

from ..db.library import MODELS
from ..library.identity import (  # noqa: F401  (re-exported for call sites)
    IdentityStore as _BaseIdentityStore,
    compute_sha256,
    file_signature,
    is_local_library_id,
)
from .metadata import get_krc_model_base_dir


IDENTITY_FILENAME = "model_library_identity.json"


def get_identity_path():
    """The pre-database identity file, read once by the stage-3 import."""
    return get_krc_model_base_dir() / IDENTITY_FILENAME


class IdentityStore(_BaseIdentityStore):
    LINEAGE = MODELS
