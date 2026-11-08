"""KRC external API: the on/off switch, the access key, and the check every ``/krc/ext/v1``
route goes through (KRC_EXTERNAL_API_GAMEPLAN.md stage 1).

- **Off until the user turns it on** (settings key ENABLED_KEY). Nothing stored, an
  unreadable value or an unreadable database all mean off.
- **The access key** (settings key KEY_KEY) is made the first time the switch is turned
  on, survives turning it off and on, and is replaced only by "Make a new key". Every
  ``ext/v1`` call sends it as ``Authorization: Bearer <key>``. It pairs an app with this
  install; it doesn't protect against someone who can already use ComfyUI itself, which
  has no login (the Options help text says so).
- **Shown once** (stage 16): ``state()`` gives only a hint (the last 4 characters); the full
  key is returned once, by the call that made it (``set_enabled`` / ``new_key``).
- **dbId** (settings key DB_ID_KEY) is a random id made with the database, so an app can
  tell one KRC install from another. It's never sent anywhere.

- **Read only** (settings key READ_ONLY_KEY, 2026-11-07): the master switch over every
  ext/v1 write. ON until the user turns it off (nothing stored = on), and it wins over the
  per-area permissions below. Turning it on only refuses new writes; a Media conversion
  already running finishes. Only the Options page changes it (an internal, same-site route).
- **Permission areas** (WRITE_AREAS, 2026-11-07): one registry, each area off until the user
  turns it on, all under Read only. /info lists them (``permissionAreas``) so a client can
  show any area without knowing it in advance; the Options page draws a switch per area;
  every write route names its area (ext_api_routes.write_gate). Today a grant is per
  install; ``area_allowed(area, key=...)`` is the one place a later per-key grant would
  plug in (every check already goes through it with the key that was sent).

Console lines never print the key.
"""
import hmac
import secrets
import uuid

from .db import connection as db

ENABLED_KEY = "ext_api.enabled"
KEY_KEY = "ext_api.key"
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

DISABLED_MESSAGE = "Turn on External API in KRC Portal ▸ Options ▸ Network."
KEY_MESSAGE = "Paste the key from KRC Portal ▸ Options ▸ Network."
READ_ONLY_MESSAGE = "External API is read only. Turn Read only off in KRC Portal ▸ Options ▸ Network to allow changes."


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


def area_allowed(area, key=None):
    """Whether writes of ``area`` (a WRITE_AREAS id) are allowed. Off when nothing is stored,
    and fails closed. (Read only is checked separately.) ``key``: the access key the request
    sent; grants are per install today, so it isn't consulted yet: a per-key grant would."""
    return _flag(WRITE_AREAS[area]["setting"], False)


def area_writes_enabled(area):
    return area_allowed(area)


def set_area_writes(area, value):
    if area not in WRITE_AREAS:
        raise KeyError(area)
    return _set_flag(WRITE_AREAS[area]["setting"], value, False, f"Writes to {WRITE_AREAS[area]['label']}:")


def permission_areas(key=None):
    """/info's permissionAreas (and the Options page's switches): every area in order."""
    return [{"id": area, "label": spec["label"], "description": spec["description"], "enabled": area_allowed(area, key),
             "capabilities": list(spec["capabilities"])} for area, spec in WRITE_AREAS.items()]


def permissions(key=None):
    """/info's flat permissions: readOnly and one boolean per area (older clients)."""
    return {"readOnly": read_only(), **{spec["flag"]: area_allowed(area, key) for area, spec in WRITE_AREAS.items()}}


def media_writes_enabled():
    return area_writes_enabled("media")


def set_media_writes(value):
    return set_area_writes("media", value)


def access_key():
    """The current key, or "" when none was made yet (or it can't be read)."""
    try:
        value = db.get_setting(db.connection(), KEY_KEY, "")
    except Exception:  # noqa: BLE001
        return ""
    return value if isinstance(value, str) else ""


def _make_key():
    return secrets.token_urlsafe(32)


def set_enabled(value):
    """Turn the external API on or off. Turning it on makes the key if there isn't one.
    Logs once per actual change. -> state(), plus ``key`` when this call made it (the only
    time it's returned)."""
    value = bool(value)
    made = ""
    with db.write() as conn:
        before = db.get_setting(conn, ENABLED_KEY, DEFAULT_ENABLED) is True
        db.set_setting(conn, ENABLED_KEY, value)
        if value and not db.get_setting(conn, KEY_KEY, ""):
            made = _make_key()
            db.set_setting(conn, KEY_KEY, made)
    if before != value:
        print(f"[KRC External API] {'enabled' if value else 'disabled'}")
    return {**state(), "key": made} if made else state()


def new_key():
    """Replace the key; apps using the old one stop working at once. -> state(), plus the
    new ``key`` (the only time it's returned)."""
    made = _make_key()
    with db.write() as conn:
        db.set_setting(conn, KEY_KEY, made)
    print("[KRC External API] new key")
    return {**state(), "key": made}


def state():
    """What the Options page shows: {"enabled", "hasKey", "keyHint", "readOnly", <each area's
    flat flag>, "areas": [...]}. Never the key itself. Internal route only."""
    key = access_key()
    return {"enabled": enabled(), "hasKey": bool(key), "keyHint": key[-4:] if key else "",
            **permissions(), "areas": permission_areas()}


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


def _bearer(authorization):
    scheme, _, token = str(authorization or "").strip().partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def write_refusal(area, key=None):
    """Why a write of ``area`` is refused after the switch and key passed -> (status, body),
    or None. Read only first (it wins), then the area's own permission: 403 with the
    area's code (area_disabled, or the first two areas' own), ``area`` and a message."""
    if read_only():
        return 403, {"error": "read_only", "message": READ_ONLY_MESSAGE}
    spec = WRITE_AREAS[area]
    if not area_allowed(area, key):
        return 403, {"error": spec["error"], "area": area,
                     "message": f"Turn on {spec['label']} under External API in KRC Portal ▸ Options ▸ Network."}
    return None


def media_write_refusal():
    return write_refusal("media")


def refusal(authorization):
    """Why an ext/v1 call is refused -> (status, body), or None when it may go ahead.
    Off -> 403 external_api_disabled; on, with a missing or wrong key -> 401."""
    if not enabled():
        return 403, {"error": "external_api_disabled", "message": DISABLED_MESSAGE}
    key = access_key()
    sent = _bearer(authorization)
    if not key or not sent or not hmac.compare_digest(sent.encode("utf-8"), key.encode("utf-8")):
        return 401, {"error": "external_api_key", "message": KEY_MESSAGE}
    return None
