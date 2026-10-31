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

Console lines never print the key.
"""
import hmac
import secrets
import uuid

from .db import connection as db

ENABLED_KEY = "ext_api.enabled"
KEY_KEY = "ext_api.key"
DB_ID_KEY = "db.id"
DEFAULT_ENABLED = False
EXT_API_VERSION = 1

DISABLED_MESSAGE = "Turn on External API in KRC Portal ▸ Options ▸ Network."
KEY_MESSAGE = "Paste the key from KRC Portal ▸ Options ▸ Network."


def enabled():
    """Whether the external API is on. Off when nothing is stored, and fails closed."""
    try:
        return db.get_setting(db.connection(), ENABLED_KEY, DEFAULT_ENABLED) is True
    except Exception:  # noqa: BLE001 - fail closed
        return False


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
    """What the Options page shows: {"enabled", "hasKey", "keyHint"}. Never the key itself.
    Internal route only."""
    key = access_key()
    return {"enabled": enabled(), "hasKey": bool(key), "keyHint": key[-4:] if key else ""}


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
