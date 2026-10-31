"""Route behind the public Card API's JS ``resolveCards`` (web/js/shared/card_api.js).

POST /krc/cards/resolve {"kind": "model" | "prompt", "ids": [...]} -> {"cards": {id: ...}}
with the same per-id shape as krc_public_api.resolve_models / resolve_prompts. The route
itself is NodePack-internal: other packs call resolveCards, never this URL.
"""

try:
    from server import PromptServer
except Exception:  # noqa: BLE001 - outside ComfyUI (static checks)
    PromptServer = None

MAX_IDS = 500
_ROUTES_REGISTERED = False


def register_card_api_routes():
    global _ROUTES_REGISTERED
    if PromptServer is None or _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    from aiohttp import web

    from .. import krc_public_api as api

    @PromptServer.instance.routes.post("/krc/cards/resolve")
    async def krc_cards_resolve(request):
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            return web.json_response({"error": "bad-json"}, status=400)
        if not isinstance(payload, dict):
            return web.json_response({"error": "body must be an object"}, status=400)
        kind = str(payload.get("kind") or "")
        ids = (payload or {}).get("ids") or []
        if not isinstance(ids, list):
            return web.json_response({"error": "ids must be a list"}, status=400)
        if len(ids) > MAX_IDS:
            return web.json_response({"error": f"At most {MAX_IDS} ids per call"}, status=400)
        try:
            if kind == "model":
                cards = await api.resolve_models_async(ids)
            elif kind == "prompt":
                cards = await api.resolve_prompts_async(ids)
            else:
                return web.json_response({"error": "kind must be model or prompt"}, status=400)
        except Exception as error:  # noqa: BLE001
            print(f"[KRC Card API] resolve failed: {error}")
            return web.json_response({"error": str(error)}, status=500)
        return web.json_response({"cards": cards})
