"""KRC external API: the on/off switch, the access key, and the check every ``/krc/ext/v1``
route goes through (KRC_EXTERNAL_API_GAMEPLAN.md stage 1).

- **Off until the user turns it on** (settings key ENABLED_KEY). Nothing stored, an
  unreadable value or an unreadable database all mean off.
- **Keys belong to API profiles** (ext_api_profiles.py, 2026-11-09): each profile has its
  own keys, policy and enabled flag; ext_api_policy.authorize checks every request. The
  first time the switch is turned on with no key anywhere, profile Default gets one. Every
  ``ext/v1`` call sends a key as ``Authorization: Bearer <key>``. Keys don't protect against
  someone who can already use ComfyUI itself, which has no login.
- **Shown once**: ``state()`` gives only a hint (the last 4 characters); a full key is
  returned once, by the call that made it. Only its hash is stored.
- **dbId** (settings key DB_ID_KEY) is a random id made with the database, so an app can
  tell one KRC install from another. It's never sent anywhere.

- **Read only** (settings key READ_ONLY_KEY, 2026-11-07): the master switch over every
  ext/v1 write. ON until the user turns it off (nothing stored = on), and it wins over the
  per-area permissions below. Turning it on only refuses new writes; a Media conversion
  already running finishes. Only the Options page changes it (an internal, same-site route).
- **Permission areas** (WRITE_AREAS, 2026-11-07): one registry, each area off until the user
  turns it on, all under Read only. /info lists them (``permissionAreas``) so a client can
  show any area without knowing it in advance; the Options page draws a switch per area;
  every write route names its area (ext_api_routes.write_gate). These are the global
  switches; each API profile's own write areas are checked after them
  (ext_api_policy.write_refusal), so a profile never gets past a global switch.

Console lines never print the key.
"""
import uuid

from .db import connection as db

ENABLED_KEY = "ext_api.enabled"
DB_ID_KEY = "db.id"
MEDIA_WRITES_KEY = "ext_api.media_writes"
LOADOUT_WRITES_KEY = "ext_api.loadout_writes"
READ_ONLY_KEY = "ext_api.read_only"
DEFAULT_ENABLED = False
DEFAULT_MEDIA_WRITES = False
DEFAULT_READ_ONLY = True

# The permission areas, in Options order. ``flag``: the area's flat boolean in /info
# permissions (older clients); ``error``: its refusal code (the first two keep their own
# codes, newer ones answer area_disabled); ``capabilities``: the write capabilities it gates.
WRITE_AREAS = {
    "media": {
        "setting": MEDIA_WRITES_KEY, "flag": "mediaWrites", "error": "media_writes_disabled", "label": "Media",
        "description": "Upload, rename, move, mark and delete Media; manage its folders; make, fill and delete Media presets.",
        "capabilities": ["media.upload", "presets.media.write", "media.items.write", "media.folders.write"],
    },
    "cardMarks": {
        "setting": "ext_api.card_marks_writes", "flag": "cardMarksWrites", "error": "area_disabled", "label": "Card marks",
        "description": "Colour, custom badge, favourite, pin and NSFW on Prompt Vault prompts and Model Library models and LoRAs.",
        "capabilities": ["cards.marks.write"],
    },
    "promptCategories": {
        "setting": "ext_api.prompt_categories_writes", "flag": "promptCategoriesWrites", "error": "area_disabled",
        "label": "Prompt categories",
        "description": "Make, rename, merge, pin, colour, mark NSFW, delete and purge Prompt Vault categories.",
        "capabilities": ["prompts.categories.write"],
    },
    "promptEditing": {
        "setting": "ext_api.prompt_editing_writes", "flag": "promptEditingWrites", "error": "area_disabled",
        "label": "Prompt editing",
        "description": "Make, edit, duplicate and delete Prompt Vault prompts (name, category, type, Prompt A and B, presets, thumbnail).",
        "capabilities": ["prompts.write"],
    },
    "loadoutPresets": {
        "setting": LOADOUT_WRITES_KEY, "flag": "loadoutWrites", "error": "loadout_writes_disabled", "label": "Loadout presets",
        "description": "Make, edit and delete LoRA Loadout and Loadout Kit (e.g. RefMod) presets.",
        "capabilities": ["presets.loadout.write"],
    },
}
EXT_API_VERSION = 1

DISABLED_MESSAGE = "Turn on External API in KRC Portal ▸ API."
KEY_MESSAGE = "Paste a key from KRC Portal ▸ API (the key may have been revoked)."
READ_ONLY_MESSAGE = "External API is read only. Turn Read only off in KRC Portal ▸ API to allow changes."


def enabled():
    """Whether the external API is on. Off when nothing is stored, and fails closed."""
    try:
        return db.get_setting(db.connection(), ENABLED_KEY, DEFAULT_ENABLED) is True
    except Exception:  # noqa: BLE001 - fail closed
        return False


def _flag(key, default):
    """A stored on/off setting; anything unreadable reads as ``default``'s safe side:
    permissions fail closed (off), Read only fails closed (on)."""
    try:
        value = db.get_setting(db.connection(), key, default)
    except Exception:  # noqa: BLE001 - fail closed
        return default if key == READ_ONLY_KEY else False
    return value if isinstance(value, bool) else default


def _set_flag(key, value, default, label):
    value = bool(value)
    with db.write() as conn:
        stored = db.get_setting(conn, key, default)
        before = stored if isinstance(stored, bool) else default
        db.set_setting(conn, key, value)
    if before != value:
        print(f"[KRC External API] {label} {'on' if value else 'off'}")
    return state()


def read_only():
    """Whether every ext/v1 write is refused. On when nothing is stored."""
    return _flag(READ_ONLY_KEY, DEFAULT_READ_ONLY)


def set_read_only(value):
    return _set_flag(READ_ONLY_KEY, value, DEFAULT_READ_ONLY, "Read only")


def area_allowed(area, principal=None):
    """Whether writes of ``area`` (a WRITE_AREAS id) are allowed: the global switch (off when
    nothing is stored; fails closed), and with ``principal`` (ext_api_policy.Principal) the
    API profile's own permission too. Read only is checked separately."""
    allowed = _flag(WRITE_AREAS[area]["setting"], False)
    return allowed and (principal is None or principal.area_permitted(area))


def area_writes_enabled(area):
    return area_allowed(area)


def set_area_writes(area, value):
    if area not in WRITE_AREAS:
        raise KeyError(area)
    return _set_flag(WRITE_AREAS[area]["setting"], value, False, f"Writes to {WRITE_AREAS[area]['label']}:")


def permission_areas(principal=None):
    """/info's permissionAreas (and the Portal's switches): every area in order. ``enabled``
    is the effective answer; with a principal, ``global`` and ``profile`` say which layer
    refuses (a global switch always wins)."""
    out = []
    for area, spec in WRITE_AREAS.items():
        entry = {"id": area, "label": spec["label"], "description": spec["description"],
                 "enabled": area_allowed(area, principal), "capabilities": list(spec["capabilities"])}
        if principal is not None:
            entry.update({"global": area_allowed(area), "profile": principal.area_permitted(area)})
        out.append(entry)
    return out


def permissions(principal=None):
    """/info's flat permissions: readOnly and one boolean per area (older clients)."""
    return {"readOnly": read_only(), **{spec["flag"]: area_allowed(area, principal) for area, spec in WRITE_AREAS.items()}}


def media_writes_enabled():
    return area_writes_enabled("media")


def set_media_writes(value):
    return set_area_writes("media", value)


def _default_key():
    """A (new) key for profile Default (made with it if it's gone). -> the key, shown once."""
    from . import ext_api_profiles as profiles
    if not any(p["id"] == profiles.DEFAULT_PROFILE_ID for p in profiles.load()["profiles"]):
        profiles.create_profile("Default", profiles.unrestricted_policy(), profile_id=profiles.DEFAULT_PROFILE_ID)
    return profiles.regenerate_key(profiles.DEFAULT_PROFILE_ID)["key"]


def set_enabled(value):
    """Turn the external API on or off. Turning it on with no key in any API profile makes
    one for profile Default. Logs once per actual change. -> state(), plus ``key`` when this
    call made it (the only time it's returned)."""
    from . import ext_api_profiles as profiles
    value = bool(value)
    with db.write() as conn:
        before = db.get_setting(conn, ENABLED_KEY, DEFAULT_ENABLED) is True
        db.set_setting(conn, ENABLED_KEY, value)
    made = _default_key() if value and not profiles.has_keys() else ""
    if before != value:
        print(f"[KRC External API] {'enabled' if value else 'disabled'}")
    return {**state(), "key": made} if made else state()


def new_key():
    """The older "Make a new key" route: regenerates profile Default's key (apps using the
    old one stop at once). Other profiles are untouched. -> state(), plus the new ``key``
    (the only time it's returned)."""
    made = _default_key()
    return {**state(), "key": made}


def state():
    """What the Portal shows: {"enabled", "hasKey", "keyHint" (profile Default's key),
    "readOnly", <each area's flat flag>, "areas": [...], "profilesRevision"}. Never a key."""
    from . import ext_api_profiles as profiles
    doc = profiles.load()
    default = next((p for p in doc["profiles"] if p["id"] == profiles.DEFAULT_PROFILE_ID), None)
    key = (default or {}).get("key") or {}
    return {"enabled": enabled(), "hasKey": profiles.has_keys(), "keyHint": key.get("hint", ""),
            **permissions(), "areas": permission_areas(), "profilesRevision": int(doc.get("revision") or 0)}


def db_id():
    """This database's random id, made the first time it's asked for."""
    conn = db.connection()
    value = db.get_setting(conn, DB_ID_KEY, "")
    if isinstance(value, str) and value:
        return value
    with db.write() as conn:
        value = db.get_setting(conn, DB_ID_KEY, "")
        if not (isinstance(value, str) and value):
            value = uuid.uuid4().hex
            db.set_setting(conn, DB_ID_KEY, value)
    return value


def write_refusal(area):
    """Why a write of ``area`` is refused by the global switches -> (status, body), or None.
    Read only first (it wins), then the area's own switch: 403 with the area's code
    (area_disabled, or the first two areas' own), ``area`` and a message. The API profile's
    own permission is checked after this (ext_api_policy.write_refusal)."""
    if read_only():
        return 403, {"error": "read_only", "message": READ_ONLY_MESSAGE}
    spec = WRITE_AREAS[area]
    if not area_allowed(area):
        return 403, {"error": spec["error"], "area": area,
                     "message": f"Turn on {spec['label']} under External API in KRC Portal ▸ API."}
    return None


def media_write_refusal():
    return write_refusal("media")


def refusal(authorization):
    """Why an ext/v1 call is refused -> (status, body), or None (ext_api_policy.authorize
    without the principal; kept for callers that only need yes / no)."""
    from .ext_api_policy import authorize
    return authorize(authorization)[1]
