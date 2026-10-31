"""LoRA Loadout HuggingFace egress — moved to the shared boundary at
``utils/library/hf_client.py`` (B6). Re-exported so existing
``from .hf_client import ...`` call sites are unchanged."""

from ..library.hf_client import (  # noqa: F401
    fetch_model_card,
)
