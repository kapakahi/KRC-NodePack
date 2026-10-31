"""Notify other pages after a successful card route has finished committing.

The originating page applies its own response; other pages reconcile through the
same record/library invalidations used by browser cards and external consumers.
"""
import json
from functools import wraps

from .server_sync import SYNC_EVENTS, publish_sync


def notify_card_write(kind):
    def decorate(handler):
        @wraps(handler)
        async def wrapped(request):
            response = await handler(request)
            if getattr(response, "status", 500) >= 300:
                return response
            try:
                body = response.body
                body = body if isinstance(body, dict) else json.loads(body)
            except (TypeError, ValueError):
                return response
            if not isinstance(body, dict) or body.get("error") or body.get("success") is False or body.get("ok") is False:
                return response
            origin = getattr(request, "headers", {}).get("X-KRC-Origin", "")
            payload = {"originPage": origin if isinstance(origin, str) and len(origin) <= 128 else ""}
            if kind == "prompt":
                # Includes rename/move/deletion; receivers preserve drafts by ID.
                publish_sync(SYNC_EVENTS["PROMPTS_CHANGED"], {**payload, "bulk": True})
            else:
                match = getattr(request, "match_info", {})
                identity = body.get("identity") if isinstance(body.get("identity"), dict) else {}
                if identity.get("oldId") and identity.get("newId"):
                    publish_sync(SYNC_EVENTS["IDENTITY_CHANGED"], {**payload, "identity": identity})
                item_id = identity.get("newId") or body.get("libraryId") or match.get("library_id") or match.get("sha256")
                if not item_id:
                    # The bare LoRA metadata route carries its id in the JSON body.
                    try:
                        posted = await request.json()
                    except (TypeError, ValueError):
                        posted = {}
                    item_id = posted.get("sha256") if isinstance(posted, dict) else None
                if item_id:
                    publish_sync(SYNC_EVENTS["LORA_METADATA_CHANGED"], {
                        **payload, "record": True, "sha256": item_id, "affected": [item_id], "fields": ["record"],
                    }, lane="metadata")
            return response
        return wrapped
    return decorate
