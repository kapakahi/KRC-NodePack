"""Server -> page sync events (public API 1.11, PUBLIC_API_PACKS_GAMEPLAN.md stage 2).

``publish_sync(event, payload)`` sends one ComfyUI server message, ``krc-sync``, to every
open page; NodePack's listener there (web/js/shared/server_sync.js) republishes it on the
browser's sync bus as if a page had published it (``source: "server"``, ``refetch: true``),
so every node subscribed to that event reacts. For a pack's Python (a route, a run, a
background job) to say "my presets changed", or NodePack's own events such as
LIBRARY_CHANGED (SYNC_EVENTS).

Event names start with ``krc-`` (a pack's own: ``krc-<pack>-…``, the ownership table's
rule), so a server message can never dispatch a browser event of another kind. The payload
is a JSON object of at most MAX_PAYLOAD_BYTES. Never raises: -> True when sent.
"""
import json
import re

SERVER_SYNC_MESSAGE = "krc-sync"
EVENT_RE = re.compile(r"^krc-[a-z0-9][a-z0-9-]{0,62}$")
MAX_PAYLOAD_BYTES = 64 * 1024
LANES = ("content", "metadata", "structure")

# NodePack's sync bus events (KRC_SYNC_EVENTS in web/js/shared/sync_bus.js; the dev check
# keeps the two identical), for publish_sync(SYNC_EVENTS["LIBRARY_CHANGED"]).
SYNC_EVENTS = {
    "LORA_METADATA_CHANGED": "krc-lora-metadata-changed",
    "PROMPTS_CHANGED": "krc-prompts-changed",
    "LIBRARY_CHANGED": "krc-library-changed",
    "LIBRARY_HEALED": "krc-library-healed",
    "IDENTITY_CHANGED": "krc-identity-changed",
    "COLLECTIONS_CHANGED": "krc-collections-changed",
    "LORA_PRESETS_CHANGED": "krc-lora-presets-changed",
    "WORDBANK_PRESETS_CHANGED": "krc-wordbank-presets-changed",
    "CONFIG_SWITCHER_PRESETS_CHANGED": "krc-config-switcher-presets-changed",
    "WORDBANK_BANKS_CHANGED": "krc-wordbank-banks-changed",
    "PROMPT_LIBRARY_UPDATED": "krc-prompt-library-updated",
}

_refused = set()


def _refuse(event, why):
    key = (str(event)[:80], why)
    if key not in _refused:
        _refused.add(key)
        print(f"[KRC Sync] refused a server event {str(event)[:80]!r}: {why}")
    return False


def publish_sync(event, payload=None, *, lane="structure"):
    """Tell every open page that ``event`` happened. ``payload``: a JSON object merged
    into the event's detail. ``lane``: "content" / "metadata" / "structure". -> bool."""
    event = str(event or "")
    if not EVENT_RE.match(event):
        return _refuse(event, "the name must look like krc-<name> (lowercase, digits, dashes)")
    payload = payload if payload is not None else {}
    if not isinstance(payload, dict):
        return _refuse(event, "the payload must be a JSON object")
    try:
        size = len(json.dumps(payload, allow_nan=False))
    except (TypeError, ValueError):
        return _refuse(event, "the payload isn't JSON")
    if size > MAX_PAYLOAD_BYTES:
        return _refuse(event, f"the payload is over {MAX_PAYLOAD_BYTES // 1024} KB")
    try:
        from server import PromptServer
        # send_sync is safe from any thread (it queues the message on the server loop).
        PromptServer.instance.send_sync(SERVER_SYNC_MESSAGE, {
            "event": event, "payload": payload, "lane": lane if lane in LANES else "structure",
        })
    except Exception as exc:  # noqa: BLE001 - outside ComfyUI, or the server is gone
        print(f"[KRC Sync] couldn't send {event}: {exc}")
        return False
    return True
