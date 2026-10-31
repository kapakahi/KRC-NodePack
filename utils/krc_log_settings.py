"""
KRC "Log loaded LoRA names" — a global option (2026-10-29; was a per-node widget).

The UI is the hidden ComfyUI setting KRC.LogLoraNames on the KRC Portal's Options page;
the client POSTs it to /krc/lora-loadout/log-names on change and at startup (the
krc_network consent pattern), and LoRA Loadout and its Loader read it here at run time.
Stored in krc.db (settings key LOG_KEY). Nothing stored, or an unreadable value, logs
counts only.
"""
from .db import library as library_db

LOG_KEY = "lora.log_names"


def log_lora_names_enabled():
    try:
        data = library_db.document_get(LOG_KEY)
    except Exception:  # noqa: BLE001 - logging detail is never worth failing a run
        return False
    return bool(data.get("enabled")) if isinstance(data, dict) else False


def set_log_lora_names(value):
    library_db.document_put(LOG_KEY, {"enabled": bool(value)})
    return bool(value)
