"""Prompt profile identity and explicit context, independent of ComfyUI users.

No mutable active profile on the server. Legacy calls target Default; selectors will
send their resolved profile id. Linked model/kit presets remain shared.
"""
import sqlite3
import uuid

from .db import connection as db

DEFAULT_PROFILE_ID = "default"
FOLLOW_GLOBAL = "global"
STORE = "prompt_profiles"


class ProfileNotFound(ValueError):
    """An explicit destination is missing; never fall back silently."""


def require_profile(profile_id, conn=None):
    """Validate an explicit id in the caller's transaction; return the profile record."""
    if not isinstance(profile_id, str) or not profile_id.strip():
        raise ProfileNotFound("Missing prompt profile")
    conn = conn if conn is not None else db.connection()
    row = conn.execute("SELECT id, name, created_ms FROM prompt_profiles WHERE id = ?", (profile_id,)).fetchone()
    if row is None:
        raise ProfileNotFound(f"Prompt profile not found: {profile_id}")
    return {"id": row[0], "name": row[1], "createdMs": row[2]}


def resolve_profile_id(global_id=DEFAULT_PROFILE_ID, override=FOLLOW_GLOBAL, *, conn=None):
    """Resolve Portal/node inheritance directly from Global, without side effects."""
    target = global_id if override in (None, "", FOLLOW_GLOBAL) else override
    return require_profile(target, conn)["id"]


def list_profiles():
    return [{"id": row[0], "name": row[1], "createdMs": row[2]} for row in db.connection().execute(
        "SELECT id, name, created_ms FROM prompt_profiles ORDER BY id != ?, name COLLATE NOCASE, id",
        (DEFAULT_PROFILE_ID,),
    )]


def _name(value):
    if not isinstance(value, str) or not 1 <= len(value.strip()) <= 64:
        raise ValueError("Profile name must contain 1–64 characters")
    return value.strip()


def create_profile(name):
    return _create_profile(name, uuid.uuid4().hex)


def _create_profile(name, profile_id):
    name = _name(name)
    with db.write() as conn:
        try:
            conn.execute("INSERT INTO prompt_profiles (id, name, created_ms) VALUES (?, ?, ?)",
                         (profile_id, name, db.now_ms()))
        except sqlite3.IntegrityError as exc:
            raise ValueError("A profile with that name already exists") from exc
        db.note_change(conn, STORE, profile_id, "create")
        return require_profile(profile_id, conn)


def rename_profile(profile_id, name):
    name = _name(name)
    with db.write() as conn:
        profile = require_profile(profile_id, conn)
        if profile_id == DEFAULT_PROFILE_ID and name != "Default":
            raise ValueError("Default profile cannot be renamed")
        if profile["name"] != name:
            try:
                conn.execute("UPDATE prompt_profiles SET name = ? WHERE id = ?", (name, profile_id))
            except sqlite3.IntegrityError as exc:
                raise ValueError("A profile with that name already exists") from exc
            db.note_change(conn, STORE, profile_id, "rename")
        return require_profile(profile_id, conn)


def delete_profile(profile_id, *, confirmed=False):
    """Delete only this profile's records; references elsewhere become missing."""
    from .prompt_vault_store import save_prompts

    with db.write() as conn:
        require_profile(profile_id, conn)
        if profile_id == DEFAULT_PROFILE_ID:
            raise ValueError("Default profile cannot be deleted")
        if not confirmed:
            raise ValueError("Confirm profile deletion before continuing")
        save_prompts({}, profile_id=profile_id)
        conn.execute("DELETE FROM prompt_profiles WHERE id = ?", (profile_id,))
        db.note_change(conn, STORE, profile_id, "delete")
