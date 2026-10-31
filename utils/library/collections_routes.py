"""Cross-node HTTP routes for the shared Collections store.

Collections span both library nodes, so these routes live in the shared home rather than under
``lora_loadout``/``model_library``. ``register_collection_routes()`` is idempotent and is called
from BOTH node files (either may load first / alone); the guard makes the double-call a no-op.

Endpoints (all under ``/krc/collections``):
  GET    /krc/collections                    -> { collections: [...], membership: {id:[cid]} }
  POST   /krc/collections                     body { name?, members?, pinned? }  -> create
  POST   /krc/collections/{id}/rename         body { name }
  POST   /krc/collections/{id}/pin            body { pinned }
  POST   /krc/collections/{id}/add-member     body { memberId }
  POST   /krc/collections/{id}/remove-member  body { memberId }
  DELETE /krc/collections/{id}

Every mutation echoes the full fresh state ({collections, membership}) so the frontend can
replace its chip strip + reverse index in one shot and broadcast COLLECTIONS_CHANGED.
"""

import json

try:
    from server import PromptServer
except Exception:  # pragma: no cover - server missing off-runtime
    PromptServer = None

from aiohttp import web

from .collections import CollectionStore

_ROUTES_REGISTERED = False


async def _read_json(request):
    try:
        payload = await request.json()
    except (ValueError, json.JSONDecodeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _state(store):
    return {"collections": store.ordered(), "membership": store.membership_index()}


def register_collection_routes():
    global _ROUTES_REGISTERED

    if PromptServer is None or _ROUTES_REGISTERED:
        return

    _ROUTES_REGISTERED = True

    routes = PromptServer.instance.routes

    @routes.get("/krc/collections")
    async def list_collections(request):
        store = CollectionStore()
        return web.json_response({"ok": True, **_state(store)})

    @routes.post("/krc/collections")
    async def create_collection(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.create(
            name=payload.get("name", ""),
            members=payload.get("members"),
            pinned=bool(payload.get("pinned")),
        )
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.post("/krc/collections/{id}/rename")
    async def rename_collection(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.rename(request.match_info["id"], payload.get("name", ""))
        if record is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.post("/krc/collections/{id}/pin")
    async def pin_collection(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.set_pinned(request.match_info["id"], bool(payload.get("pinned")))
        if record is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.post("/krc/collections/{id}/color")
    async def color_collection(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.set_color(request.match_info["id"], payload.get("cardColor", ""))
        if record is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.post("/krc/collections/{id}/add-member")
    async def add_member(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.add_member(request.match_info["id"], payload.get("memberId", ""))
        if record is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.post("/krc/collections/{id}/remove-member")
    async def remove_member(request):
        payload = await _read_json(request)
        store = CollectionStore()
        record = store.remove_member(request.match_info["id"], payload.get("memberId", ""))
        if record is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, "collection": record, **_state(store)})

    @routes.delete("/krc/collections/{id}")
    async def delete_collection(request):
        store = CollectionStore()
        removed = store.delete(request.match_info["id"])
        if removed is None:
            return web.json_response({"ok": False, "error": "not_found"}, status=404)
        return web.json_response({"ok": True, **_state(store)})
