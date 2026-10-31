"""Loadout Kit routes, shared by every kit (the kit id is in the path):

    GET    /krc/loadout/kits                     {kit id: descriptor} for every kit
    GET    /krc/loadout/{kit}/descriptor         one kit's descriptor
    GET    /krc/loadout/{kit}/presets            {"presets": [...]}
    POST   /krc/loadout/{kit}/presets            upsert {id, group, name, stack}
    POST   /krc/loadout/{kit}/presets/rename     {id, group, name, stack?}
    POST   /krc/loadout/{kit}/presets/rename-group  {from, to}
    POST   /krc/loadout/{kit}/presets/ungroup-group {group}   (to --none--)
    POST   /krc/loadout/{kit}/presets/delete-group  {group}
    DELETE /krc/loadout/{kit}/presets            {id}

A kit's presets move in the KRC bundle (section "kit_presets/<kit id>", transfer.py).
Same behaviour and status codes as RefMod Loadout's preset routes. NodePack-internal:
other packs reach them through the JS kit, never by URL.
"""

try:
    from server import PromptServer
except Exception:  # noqa: BLE001 - outside ComfyUI (static checks)
    PromptServer = None


from ..preset_naming import GROUP_ACTIONS, group_action_answer
from .kit import all_kits, get_kit

_ROUTES_REGISTERED = False

# Live preset data must never come from a browser/proxy cache (see LoRA Loadout routes).
_NO_STORE = {"Cache-Control": "no-store"}


def register_loadout_kit_routes():
    global _ROUTES_REGISTERED
    if PromptServer is None or _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True

    from aiohttp import web

    routes = PromptServer.instance.routes

    def unknown(kit_id):
        return web.json_response({"ok": False, "error": f"unknown loadout kit {kit_id!r}"}, status=404)

    @routes.get("/krc/loadout/kits")
    async def loadout_kits(_request):
        return web.json_response({kit_id: kit.descriptor() for kit_id, kit in all_kits().items()}, headers=_NO_STORE)

    @routes.get("/krc/loadout/{kit}/descriptor")
    async def loadout_descriptor(request):
        kit = get_kit(request.match_info["kit"])
        if kit is None:
            return unknown(request.match_info["kit"])
        return web.json_response(kit.descriptor(), headers=_NO_STORE)

    @routes.get("/krc/loadout/{kit}/presets")
    async def loadout_get_presets(request):
        kit = get_kit(request.match_info["kit"])
        if kit is None:
            return unknown(request.match_info["kit"])
        return web.json_response(kit.presets().load(), headers=_NO_STORE)

    @routes.post("/krc/loadout/{kit}/presets")
    async def loadout_save_preset(request):
        kit = get_kit(request.match_info["kit"])
        if kit is None:
            return unknown(request.match_info["kit"])
        payload = await request.json()
        preset = kit.presets().upsert(
            payload.get("id", ""),
            payload.get("group", ""),
            payload.get("name", ""),
            payload.get("stack", []),
        )
        if preset is None:
            return web.json_response({"ok": False, "error": "reserved"}, status=400)
        return web.json_response(preset)

    @routes.post("/krc/loadout/{kit}/presets/rename")
    async def loadout_rename_preset(request):
        kit = get_kit(request.match_info["kit"])
        if kit is None:
            return unknown(request.match_info["kit"])
        payload = await request.json()
        result = kit.presets().rename(
            payload.get("id", ""),
            payload.get("group", ""),
            payload.get("name", ""),
            payload.get("stack"),
        )
        if result.get("ok"):
            status = 200
        elif result.get("error") == "not_found":
            status = 404
        else:
            status = 400
        return web.json_response(result, status=status)

    def group_route(action):
        async def handler(request):
            kit = get_kit(request.match_info["kit"])
            if kit is None:
                return unknown(request.match_info["kit"])
            payload = await request.json()
            result, status = group_action_answer(kit.presets(), action, payload, "Loadout Kit",
                                                 what=f"{kit.id} preset group")
            return web.json_response(result, status=status)
        return handler

    for action in GROUP_ACTIONS:
        routes.post(f"/krc/loadout/{{kit}}/presets/{action}-group")(group_route(action))

    @routes.delete("/krc/loadout/{kit}/presets")
    async def loadout_delete_preset(request):
        kit = get_kit(request.match_info["kit"])
        if kit is None:
            return unknown(request.match_info["kit"])
        payload = await request.json()
        return web.json_response({"ok": kit.presets().delete(payload.get("id", ""))})


