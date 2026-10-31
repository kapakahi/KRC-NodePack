"""Prompt profile management and per-request storage binding. No ambient scope."""
import functools

import server

from . import prompt_profiles as profiles
from .prompt_profile_store import ProfileStore
from .db import connection as db




def bind_profile(handler, store, *, identity=False):
    @functools.wraps(handler)
    async def scoped(request):
        try:
            query = getattr(request, "query", {})
            profile_id = profiles.DEFAULT_PROFILE_ID if identity and query.get("id") else query.get("profile", profiles.DEFAULT_PROFILE_ID)
            bound = ProfileStore(store, profile_id)
        except ValueError as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
        return await handler(request, bound)
    return scoped


def _changed():
    server.PromptServer.instance.send_sync("krc-prompt-profiles-changed", {})


def register_profile_routes():
    routes = server.PromptServer.instance.routes

    @routes.get("/krc/prompt-vault/profiles")
    async def get_profiles(_request):
        with db.read() as conn:
            records = profiles.list_profiles()
            counts = dict(conn.execute("SELECT profile_id, COUNT(*) FROM prompts GROUP BY profile_id"))
            for record in records:
                record["promptCount"] = counts.get(record["id"], 0)
        return server.web.json_response({"profiles": records})

    @routes.post("/krc/prompt-vault/profiles/save")
    async def save_profile(request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("Expected a profile object")
            record = profiles.rename_profile(data["id"], data.get("name")) if data.get("id") else profiles.create_profile(data.get("name"))
            _changed()
            return server.web.json_response({"success": True, "profile": record})
        except (ValueError, TypeError) as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)

    @routes.post("/krc/prompt-vault/profiles/delete")
    async def delete_profile(request):
        try:
            data = await request.json()
            if not isinstance(data, dict):
                raise ValueError("Expected a profile object")
            profiles.delete_profile(data.get("id"), confirmed=data.get("confirmed") is True)
            # Files are cleaned only after the deletion transaction commits.
            from .prompt_vault_thumbnails import gc_orphan_thumbnails
            # Serialize with uploads: never collect a file another writer has placed
            # on disk but has not yet committed into the catalog.
            with db.write():
                gc_orphan_thumbnails({})
            _changed()
            server.PromptServer.instance.send_sync("krc-prompts-changed", {})
            return server.web.json_response({"success": True})
        except (ValueError, TypeError) as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
