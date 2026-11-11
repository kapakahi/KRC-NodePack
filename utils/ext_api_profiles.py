"""KRC external API profiles (2026-11-09): who is calling, with which key, allowed what.

An **API profile** is an authenticated identity for ext/v1: a stable id, a display name, an
enabled flag, **one key** and its own policy (one key per profile, as most API services do:
one profile per app). It is not a login system: a profile is whoever holds its key. It's separate from Prompt Vault profiles (those are prompt
containers; a policy can name them as resources).

Storage: one krc.db setting, ``ext_api.profiles`` (DOC_KEY):

    {"version": 1, "revision": n,
     "profiles": [{"id", "name", "enabled", "created", "policy": {...},
                   "key": {"id", "hash", "hint", "created", "legacy"?} | null}]}

- **The key** is ``krc_<key id>_<secret>`` (the id only finds it on a request). Only
  ``sha256:<hex>`` of the whole key is stored; the key is returned once, by the call that
  made it. ``hint`` is its last 4 characters. A key made before profiles (no prefix,
  ``legacy``) is found by comparing hashes.
- **Disable** a profile: its key is refused at once (403 profile_disabled); enabling it
  again restores it. **Regenerate** the key: a new one replaces it and the old one stops
  at once (with every file link it made). Delete the profile to end it for good.
- No authorization cache: every request reads this setting (one row), so a change applies
  to the very next request, with no restart and no delay.
- **Migration** (once, in the first read): the single pre-profile key (``ext_api.key``,
  stored in the clear) becomes the key "Original key" of a profile "Default" (id
  ``default``) with unrestricted access, so current clients keep working unchanged; the
  clear-text copy is deleted.
- **Usage** (lightweight): the last authenticated request per profile and an optional
  client label (``X-KRC-Client``, unverified, never used for
  identity). Kept in memory and written at most once a minute (USAGE_FLUSH_SECONDS) to
  ``ext_api.usage``. Refused requests don't count.

Policies (``policy``; see normalize_policy) are enforced by ext_api_policy.py.
Console lines never print a key or a hash.
"""
import hashlib
import hmac
import json
import re
import secrets
import threading
import time
import uuid

from .db import connection as db

DOC_KEY = "ext_api.profiles"
USAGE_KEY = "ext_api.usage"
LEGACY_KEY_KEY = "ext_api.key"
DEFAULT_PROFILE_ID = "default"
DOC_VERSION = 1
NAME_MAX = 60
LABEL_MAX = 48
MAX_PROFILES = 64
USAGE_FLUSH_SECONDS = 60
RECENT_SECONDS = 15 * 60          # "Recently active" within this
KEY_PREFIX = "krc_"
_KEY_RE = re.compile(r"^krc_([0-9a-f]{10})_[A-Za-z0-9_-]{20,}$")
_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,40}$")
TAG = "[KRC External API]"

LEVELS = ("read", "write")
MODES = ("all", "selected", "none")


class ProfileError(ValueError):
    """A request the profile store refuses; the message is for the Portal page."""


# ---- policies ------------------------------------------------------------------------------

def unrestricted_policy():
    """Everything the global switches allow (the migrated Default profile)."""
    return {"capabilities": "all", "fileSources": True, "scopes": {"*": {"mode": "all", "level": "write"}}}


def restricted_policy():
    """A new profile: nothing until the owner grants it."""
    return {"capabilities": "all", "fileSources": False, "scopes": {"*": {"mode": "none", "level": "read"}}}


# Kinds whose resources can be picked one by one (the workspaces that keep people apart).
# Every other kind is all-or-nothing: None, Read or Read/Write for all of it.
PICK_SCOPES = ("prompts", "mediaFolders")
# Kinds the API can't change: Read at most (none today: Config Switcher and Word Bank presets
# became writable 2026-11-10, values only).
READ_ONLY_SCOPES = ()


def _clean_scope(raw, name="*"):
    raw = raw if isinstance(raw, dict) else {}
    mode = raw.get("mode") if raw.get("mode") in MODES else "none"
    level = raw.get("level") if raw.get("level") in LEVELS else "read"
    items = {}
    for key, value in (raw.get("items") or {}).items() if isinstance(raw.get("items"), dict) else ():
        if isinstance(key, str) and key and len(key) <= 200 and value in LEVELS:
            items[key] = value
    default = raw.get("default") if isinstance(raw.get("default"), str) else ""
    if name not in PICK_SCOPES:
        # All-or-nothing: a stored pick list becomes All at its highest level (None if empty).
        if mode == "selected":
            mode, level = ("all", "write" if "write" in items.values() else "read") if items else ("none", "read")
        items, default = {}, ""
    if name in READ_ONLY_SCOPES:
        level = "read"
    # May make new ones (Media folders; presets of the kind): with write access. What a
    # Selected profile makes joins its own picks.
    create = (mode == "all" and level == "write") or (mode == "selected" and "write" in items.values())
    return {"mode": mode, "level": level, "items": items, "default": default[:200], "create": create}


def normalize_policy(raw):
    """A policy as stored. ``capabilities``: "all" or a list (honoured by the server; KRC
    Portal sets "all"); ``fileSources``: whether the Resizer may read ComfyUI images by file
    name ("ComfyUI images"); ``scopes``: per resource kind -> {mode, level, items, default,
    create}. ``prompts`` and ``mediaFolders`` may be ``selected`` (``items``: {id: read |
    write}, ``default``: where new things go); every other kind (``models``,
    ``presets.<kind>``; ``*`` = any kind not listed) is ``all`` (``level`` read | write) or
    ``none``; Config Switcher and Word Bank presets are read at most. What a profile may write
    follows from its scopes (ext_api_policy.Principal.area_permitted)."""
    raw = raw if isinstance(raw, dict) else {}
    caps = raw.get("capabilities")
    caps = "all" if caps == "all" else sorted({c for c in caps if isinstance(c, str)}) if isinstance(caps, list) else "all"
    scopes = {}
    for key, value in (raw.get("scopes") or {}).items() if isinstance(raw.get("scopes"), dict) else ():
        if isinstance(key, str) and key and len(key) <= 80:
            scopes[key] = _clean_scope(value, key)
    scopes.setdefault("*", _clean_scope({"mode": "none"}))
    return {"capabilities": caps, "fileSources": raw.get("fileSources") is True, "scopes": scopes}


# ---- the document --------------------------------------------------------------------------

def _hash(key):
    return "sha256:" + hashlib.sha256(str(key).encode("utf-8")).hexdigest()


def _new_key_id():
    return secrets.token_hex(5)


def _make_key(key_id):
    return f"{KEY_PREFIX}{key_id}_{secrets.token_urlsafe(32)}"


def _empty_doc():
    return {"version": DOC_VERSION, "revision": 0, "profiles": []}


def _migrate(conn, doc):
    """The pre-profile key -> profile Default (unrestricted), once. -> the document."""
    legacy = db.get_setting(conn, LEGACY_KEY_KEY, "")
    doc = _empty_doc()
    profile = {"id": DEFAULT_PROFILE_ID, "name": "Default", "enabled": True, "created": int(time.time() * 1000),
               "policy": normalize_policy(unrestricted_policy()), "key": None}
    if isinstance(legacy, str) and legacy:
        profile["key"] = {"id": _new_key_id(), "hash": _hash(legacy), "hint": legacy[-4:],
                          "created": profile["created"], "legacy": True}
    doc["profiles"].append(profile)
    doc["revision"] = 1
    db.set_setting(conn, DOC_KEY, doc)
    if isinstance(legacy, str) and legacy:
        db.set_setting(conn, LEGACY_KEY_KEY, "")
        print(f"{TAG} the access key now belongs to API profile Default")
    return doc


def _valid_doc(doc):
    return isinstance(doc, dict) and isinstance(doc.get("profiles"), list)


def _one_key(doc):
    """Profiles stored with a key list (before one key per profile) keep their newest key."""
    for profile in doc["profiles"]:
        if "keys" in profile:
            keys = [key for key in profile.pop("keys") or [] if isinstance(key, dict)]
            profile["key"] = keys[-1] if keys else None
            if profile["key"]:
                profile["key"].pop("name", None)
    return doc


def load():
    """The profiles document (migrated on first use). Fails closed: unreadable -> no profiles."""
    try:
        doc = db.get_setting(db.connection(), DOC_KEY, None)
        if _valid_doc(doc):
            return _one_key(doc)
        with db.write() as conn:
            doc = db.get_setting(conn, DOC_KEY, None)
            return _one_key(doc) if _valid_doc(doc) else _migrate(conn, doc)
    except Exception as exc:  # noqa: BLE001 - fail closed
        print(f"{TAG} couldn't read the API profiles: {type(exc).__name__}")
        return _empty_doc()


def _change(mutate):
    """Read-modify-write under one transaction; bumps the revision. -> mutate's result."""
    with db.write() as conn:
        doc = db.get_setting(conn, DOC_KEY, None)
        doc = _one_key(doc) if _valid_doc(doc) else _migrate(conn, doc)
        result = mutate(doc)
        doc["revision"] = int(doc.get("revision") or 0) + 1
        db.set_setting(conn, DOC_KEY, doc)
    return result


def _find(doc, profile_id):
    profile = next((p for p in doc["profiles"] if p.get("id") == profile_id), None)
    if profile is None:
        raise ProfileError("That API profile no longer exists.")
    return profile


def _clean_name(name, limit, what):
    clean = re.sub(r"\s+", " ", re.sub(r"[\x00-\x1f\x7f]", "", str(name or ""))).strip()[:limit]
    if not clean:
        raise ProfileError(f"{what} can't be empty.")
    return clean


def revision():
    return int(load().get("revision") or 0)


# ---- admin (the Portal's API page, through same-site internal routes only) -----------------



def activity(last_used, now=None):
    """"recent" (within RECENT_SECONDS), "used" or "never": never "connected" or "online"."""
    if not last_used:
        return "never"
    return "recent" if (now or time.time() * 1000) - last_used <= RECENT_SECONDS * 1000 else "used"


def profile_view(profile, usage=None):
    """A profile as the Portal shows it: never a key or a hash."""
    usage = usage if usage is not None else usage_snapshot()
    seen = usage.get("profiles", {}).get(profile["id"], {})
    return {"id": profile["id"], "name": profile["name"], "enabled": bool(profile.get("enabled")),
            "created": profile.get("created", 0), "policy": normalize_policy(profile.get("policy")),
            "key": ({"hint": profile["key"].get("hint", ""), "created": profile["key"].get("created", 0)}
                    if profile.get("key") else None),
            "usage": {"lastUsed": seen.get("at", 0), "label": seen.get("label", ""), "activity": activity(seen.get("at", 0))}}


def list_profiles():
    usage = usage_snapshot()
    doc = load()
    return {"revision": int(doc.get("revision") or 0), "recentSeconds": RECENT_SECONDS,
            "profiles": [profile_view(p, usage) for p in doc["profiles"]]}


def create_profile(name, policy=None, profile_id=None):
    clean = _clean_name(name, NAME_MAX, "A profile name")

    def mutate(doc):
        if len(doc["profiles"]) >= MAX_PROFILES:
            raise ProfileError(f"At most {MAX_PROFILES} API profiles.")
        if any(p["name"].lower() == clean.lower() for p in doc["profiles"]):
            raise ProfileError(f'Another API profile is already called "{clean}".')
        new_id = profile_id or f"p_{uuid.uuid4().hex[:12]}"
        if not _ID_RE.match(new_id) or any(p["id"] == new_id for p in doc["profiles"]):
            raise ProfileError("That profile id is taken.")
        profile = {"id": new_id, "name": clean, "enabled": True, "created": int(time.time() * 1000),
                   "policy": normalize_policy(policy if policy is not None else restricted_policy()), "key": None}
        doc["profiles"].append(profile)
        return profile

    profile = _change(mutate)
    print(f"{TAG} API profile {profile['id']} created")
    return profile_view(profile)


def update_profile(profile_id, *, name=None, enabled=None, policy=None):
    """Rename (the id, key and policy stay), enable / disable, or replace the policy."""
    clean = _clean_name(name, NAME_MAX, "A profile name") if name is not None else None
    if enabled is not None and not isinstance(enabled, bool):
        raise ProfileError("enabled must be true or false.")

    def mutate(doc):
        profile = _find(doc, profile_id)
        if clean is not None:
            if any(p["id"] != profile_id and p["name"].lower() == clean.lower() for p in doc["profiles"]):
                raise ProfileError(f'Another API profile is already called "{clean}".')
            profile["name"] = clean
        if enabled is not None:
            profile["enabled"] = enabled
        if policy is not None:
            profile["policy"] = normalize_policy(policy)
        return profile

    profile = _change(mutate)
    if enabled is not None:
        print(f"{TAG} API profile {profile_id} {'enabled' if enabled else 'disabled'}")
    return profile_view(profile)


def delete_profile(profile_id):
    def mutate(doc):
        _find(doc, profile_id)
        doc["profiles"] = [p for p in doc["profiles"] if p["id"] != profile_id]

    _change(mutate)
    print(f"{TAG} API profile {profile_id} deleted (its key stops working)")
    return {"deleted": profile_id}


def regenerate_key(profile_id):
    """A new key for the profile, replacing its key (the old one, and every file link it
    made, stops at once). -> {"key": <shown once>, "profile": view}."""
    key_id = _new_key_id()
    key = _make_key(key_id)

    def mutate(doc):
        profile = _find(doc, profile_id)
        profile["key"] = {"id": key_id, "hash": _hash(key), "hint": key[-4:], "created": int(time.time() * 1000)}
        return profile

    profile = _change(mutate)
    print(f"{TAG} API profile {profile_id}: new key")
    return {"key": key, "profile": profile_view(profile)}


def grant_created(profile_id, scope, resource_id):
    """A restricted profile made ``resource_id``: it joins that profile's selected list as
    write (no other profile gains it). Profiles whose scope is "all" need nothing."""
    def mutate(doc):
        profile = next((p for p in doc["profiles"] if p.get("id") == profile_id), None)
        if profile is None:
            return
        policy = normalize_policy(profile.get("policy"))
        entry = policy["scopes"].get(scope) or dict(policy["scopes"]["*"], items={}, default="")
        if entry["mode"] == "all":
            return
        entry = {**entry, "mode": "selected", "items": {**entry["items"], resource_id: "write"}}
        policy["scopes"][scope] = entry
        profile["policy"] = policy

    _change(mutate)


# ---- authentication ------------------------------------------------------------------------

def _bearer(authorization):
    scheme, _, token = str(authorization or "").strip().partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def authenticate(authorization):
    """The bearer key -> (profile, key) or (None, reason): reason "key" (missing, wrong or
    revoked) or "disabled" (a disabled profile's key). Constant-time hash compares."""
    sent = _bearer(authorization)
    if not sent or len(sent) > 200:
        return None, "key"
    digest = _hash(sent)
    match = _KEY_RE.match(sent)
    for profile in load()["profiles"]:
        key = profile.get("key")
        if not key or (match and key["id"] != match.group(1) and not key.get("legacy")):
            continue
        if hmac.compare_digest(str(key.get("hash", "")), digest):
            if not profile.get("enabled"):
                return None, "disabled"
            return (profile, key), ""
    return None, "key"


def has_keys():
    return any(profile.get("key") for profile in load()["profiles"])


# ---- usage ---------------------------------------------------------------------------------

_usage_lock = threading.Lock()
_usage = None            # {"profiles": {id: {at, label}}}
_usage_dirty = False
_usage_flushed = 0.0
_usage_db = None


def clean_label(value):
    """An unverified client label: printable, single spaces, at most LABEL_MAX characters."""
    text = re.sub(r"[\x00-\x1f\x7f<>]", "", str(value or ""))
    return re.sub(r"\s+", " ", text).strip()[:LABEL_MAX]


def _usage_state():
    global _usage, _usage_db
    path = str(db.db_path())
    if _usage is None or _usage_db != path:
        try:
            stored = db.get_setting(db.connection(), USAGE_KEY, None)
        except Exception:  # noqa: BLE001
            stored = None
        stored = stored if isinstance(stored, dict) else {}
        _usage = {"profiles": dict(stored.get("profiles") or {})}
        _usage_db = path
    return _usage


def usage_snapshot():
    with _usage_lock:
        state = _usage_state()
        return json.loads(json.dumps(state))


def record_use(profile_id, key_id, label="", now=None):
    """An authorized request: in memory now, on disk at most once a minute. (``key_id`` is
    kept for callers; usage is per profile.)"""
    global _usage_dirty
    at = int((now if now is not None else time.time()) * 1000)
    with _usage_lock:
        state = _usage_state()
        clean = clean_label(label)
        previous = state["profiles"].get(profile_id) or {}
        state["profiles"][profile_id] = {"at": at, "label": clean or previous.get("label", "")}
        _usage_dirty = True
    flush_usage(now=now)


def flush_usage(force=False, now=None):
    """Writes the usage when it changed and a minute passed (or ``force``). -> wrote?"""
    global _usage_dirty, _usage_flushed
    current = now if now is not None else time.time()
    with _usage_lock:
        if not _usage_dirty or (not force and current - _usage_flushed < USAGE_FLUSH_SECONDS):
            return False
        snapshot = json.loads(json.dumps(_usage_state()))
        _usage_dirty = False
        _usage_flushed = current
    try:
        with db.write() as conn:
            db.set_setting(conn, USAGE_KEY, snapshot)
    except Exception as exc:  # noqa: BLE001 - usage is best effort
        print(f"{TAG} couldn't save API usage: {type(exc).__name__}")
        return False
    return True


def reset_usage_cache():
    """Tests: forget the in-memory usage (the next read loads it from the database)."""
    global _usage, _usage_dirty, _usage_flushed, _usage_db
    with _usage_lock:
        _usage, _usage_dirty, _usage_flushed, _usage_db = None, False, 0.0, None
