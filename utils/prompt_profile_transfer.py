"""Explicit profile context for Prompt Vault bundle transfers."""
import json
import re
import uuid

from .archive_guard import ArchiveGuardError, read_json_entry
from .db import connection as db
from .prompt_profile_store import ProfileStore
from . import prompt_profiles as profiles
from . import prompt_vault_store as storage

PROFILE_FILE = "profile.json"


def archive_profile(archive):
    if PROFILE_FILE not in archive.namelist():
        return None
    value = read_json_entry(archive, PROFILE_FILE)
    if not isinstance(value, dict) or not isinstance(value.get("name"), str):
        raise ArchiveGuardError("Prompt profile information is invalid")
    profile_id = str(value.get("id") or "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", profile_id):
        profile_id = ""
    return {"id": profile_id, "name": value["name"][:64]}


def export_store(store, archive, selection):
    profile_id = (selection or {}).get("profileId", profiles.DEFAULT_PROFILE_ID)
    scoped = ProfileStore(store, profile_id)
    archive.writestr(PROFILE_FILE, json.dumps(profiles.require_profile(profile_id), ensure_ascii=False))
    return scoped


def undo_slices(profile_id):
    # SQL is generated only from a validated local ID, never accepted from a bundle.
    quoted = "'" + profile_id.replace("'", "''") + "'"
    return (("usage", "domain = 'prompts' AND item_id IN (SELECT id FROM main.prompts WHERE profile_id = " + quoted
             + " UNION SELECT id FROM snap.prompts WHERE profile_id = " + quoted + ")"),
            ("prompt_profiles", "id = " + quoted),
            ("prompt_categories", "profile_id = " + quoted), ("prompts", "profile_id = " + quoted))


def plan_profile_section(store, archive, mode, options, stager, planner):
    context = options.get("promptProfile")
    if context is None:
        return planner(store, archive, mode, options, stager)
    if not isinstance(context, dict) or context.get("action", "merge") not in ("merge", "replace", "new"):
        raise ValueError("Choose merge, replace or new profile")
    action = context.get("action", "merge")
    is_new = action == "new"
    name = profiles._name(context.get("name")) if is_new else None
    incoming_profile = archive_profile(archive) or {}
    imported_id = incoming_profile.get("id")
    if imported_id in ("default", "global"):
        imported_id = None
    occupied = {entry["id"] for entry in profiles.list_profiles()}
    profile_id = (imported_id if imported_id and imported_id not in occupied else uuid.uuid4().hex) if is_new else profiles.require_profile(context.get("id"))["id"]
    if is_new and any(entry["name"].casefold() == name.casefold() for entry in profiles.list_profiles()):
        raise ValueError("A profile with that name already exists")

    class Destination(ProfileStore):
        def __init__(self):
            self.store, self.profile_id = store, profile_id

        def load_prompts(self):
            if is_new and not db.connection().execute("SELECT 1 FROM prompt_profiles WHERE id = ?", (profile_id,)).fetchone():
                return {}
            return storage.load_prompts(profile_id)

        def save_prompts(self, data, source=""):
            return storage.save_prompts(data, source=source, profile_id=profile_id)

    destination = Destination()
    snapshot = destination.load_prompts()
    plan = planner(destination, archive, "merge", {**options, "_profileImport": True,
                   "_replaceProfile": action == "replace"}, stager)
    apply = plan.apply

    def guarded_apply():
        if is_new:
            profiles._create_profile(name, profile_id)
        else:
            profiles.require_profile(profile_id)
        if destination.load_prompts() != snapshot:
            raise ValueError("The destination profile changed during import. Preview and import again.")
        result = apply()
        return {**result, "profileId": profile_id, "profileName": profiles.require_profile(profile_id)["name"]}

    previous_after = plan.after

    def after():
        try:
            # Uploads place files under this same writer lock. Never collect a file
            # placed by another writer before its prompt reference is committed.
            with db.write():
                if previous_after:
                    previous_after()
        finally:
            # The import already committed, even if best-effort cleanup fails.
            announce_profiles()

    plan.apply = guarded_apply
    plan.slices = undo_slices(profile_id)
    plan.after = after
    return plan


def announce_profiles():
    # Also used after Undo: selectors must learn about created/removed profiles.
    try:
        import server
        instance = server.PromptServer.instance
    except (ImportError, AttributeError):
        return
    instance.send_sync("krc-prompt-profiles-changed", {})
    instance.send_sync("krc-prompts-changed", {})
