"""Who may do what through ext/v1 (2026-11-09): the one place authorization is decided.

Effective access is the intersection of three layers, and a profile never bypasses a global
restriction:

1. **Global** (ext_api.py): the External API switch, Read only, and each write area's switch.
2. **The API profile** (ext_api_profiles.py): enabled; its capabilities (``"all"`` or a list);
   its write areas (``"all"`` or a list); whether stateless endpoints may read ComfyUI files
   by name (``fileSources``).
3. **Its resources** (``policy.scopes``), per kind of resource:

   - ``mode: "all"`` -> every resource of that kind, present and future, at ``level``
     (read or write);
   - ``mode: "selected"`` -> only the ids in ``items`` (each read or write). Things the
     profile creates join its list (ext_api_profiles.grant_created); nothing anyone else
     creates appears in it;
   - ``mode: "none"`` -> none.

   Scope names: ``prompts`` (Prompt Vault profile ids: a prompt is reachable through its
   profile), ``mediaFolders`` (Media folder ids, plus ``unsorted:input`` and
   ``unsorted:output``; a Media item is reachable through its folder), ``models`` (Model
   Library types, e.g. ``lora``, ``checkpoints``), ``presets.<kind>`` (preset ids of that
   kind, e.g. ``presets.media``, ``presets.lora``). ``*`` covers kinds not listed.

A **Principal** is one authorized request's identity: its profile and key, read fresh for
every request (no cache), so a change applies to the next request.
"""
import contextvars
import hashlib
import json

from . import ext_api
from . import ext_api_profiles as profiles

UNSORTED_INPUT = "unsorted:input"
UNSORTED_OUTPUT = "unsorted:output"
_RANK = {None: 0, "read": 1, "write": 2}


class Principal:
    """The caller of one ext/v1 request."""

    def __init__(self, profile, key, label=""):
        self.profile_id = profile["id"]
        self.profile_name = profile.get("name", "")
        self.key_id = key["id"]
        self.policy = profiles.normalize_policy(profile.get("policy"))
        self.label = profiles.clean_label(label)

    # -- capabilities and write areas ------------------------------------------------------
    def capability_allowed(self, capability):
        caps = self.policy["capabilities"]
        return caps == "all" or capability in caps

    def area_permitted(self, area):
        """The profile's own permission for a write area (not the global switch)."""
        areas = self.policy["writeAreas"]
        return areas == "all" or area in areas

    @property
    def file_sources(self):
        return bool(self.policy.get("fileSources"))

    # -- resources -------------------------------------------------------------------------
    def scope(self, name):
        scopes = self.policy["scopes"]
        return scopes.get(name) or scopes["*"]

    def unrestricted(self, name):
        """Every resource of the kind, at least readable (no filtering needed)."""
        return self.scope(name)["mode"] == "all"

    def access(self, name, resource_id):
        """None, "read" or "write" for one resource."""
        entry = self.scope(name)
        if entry["mode"] == "all":
            return entry["level"]
        if entry["mode"] == "selected":
            return entry["items"].get(str(resource_id))
        return None

    def can_read(self, name, resource_id):
        return _RANK[self.access(name, resource_id)] >= 1

    def can_write(self, name, resource_id):
        return _RANK[self.access(name, resource_id)] >= 2

    def default(self, name):
        return self.scope(name).get("default") or ""

    def summary(self, name):
        """/info's view of one scope: the mode, and for selected the ids with levels."""
        entry = self.scope(name)
        out = {"mode": entry["mode"]}
        if entry["mode"] == "all":
            out["level"] = entry["level"]
        if entry["mode"] == "selected":
            out["items"] = dict(entry["items"])
        if entry.get("default"):
            out["default"] = entry["default"]
        out["create"] = bool(entry.get("create"))
        return out

    def revision(self):
        """Changes whenever anything that decides this caller's access changes: its policy,
        name or enabled state, or the global switches. Clients compare it to drop caches."""
        seen = {"profile": self.profile_id, "name": self.profile_name, "policy": self.policy,
                "global": {"readOnly": ext_api.read_only(),
                           "areas": {area: ext_api.area_allowed(area) for area in ext_api.WRITE_AREAS}}}
        return hashlib.sha1(json.dumps(seen, sort_keys=True).encode("utf-8")).hexdigest()[:16]


def authorize(authorization, label=""):
    """-> (Principal, None) or (None, (status, body)). The switch first (403), then the key
    (401: missing, wrong or revoked), then the profile (403 profile_disabled)."""
    if not ext_api.enabled():
        return None, (403, {"error": "external_api_disabled", "message": ext_api.DISABLED_MESSAGE})
    found, reason = profiles.authenticate(authorization)
    if found is None:
        if reason == "disabled":
            return None, (403, {"error": "profile_disabled",
                                "message": "This API profile is disabled. Enable it in KRC Portal ▸ API."})
        return None, (401, {"error": "external_api_key", "message": ext_api.KEY_MESSAGE})
    profile, key = found
    principal = Principal(profile, key, label)
    profiles.record_use(principal.profile_id, principal.key_id, principal.label)
    return principal, None


def write_refusal(area, principal):
    """Why a write of ``area`` is refused -> (status, body) or None: Read only (global) first,
    then the area's global switch, then the profile's write areas."""
    refused = ext_api.write_refusal(area)
    if refused:
        return refused
    if principal is not None and not principal.area_permitted(area):
        spec = ext_api.WRITE_AREAS[area]
        return 403, {"error": "area_not_permitted", "area": area,
                     "message": f"This API profile may not change {spec['label']}. Its owner can allow it in KRC Portal ▸ API."}
    return None


def capability_refusal(capability, principal):
    if principal is not None and not principal.capability_allowed(capability):
        return 403, {"error": "capability_not_permitted", "capability": capability,
                     "message": "This API profile may not use that. Its owner can allow it in KRC Portal ▸ API."}
    return None


NOT_FOUND = {"error": "not_found", "message": "Not found."}


def scope_names():
    """The resource kinds a policy can name (for /info and the Portal page): the fixed ones,
    then one per preset kind this install has."""
    names = ["prompts", "mediaFolders", "models"]
    try:
        from .ext_api_routes import _preset_stores
        names += [f"presets.{kind}" for kind in _preset_stores()]
    except Exception:  # noqa: BLE001
        pass
    if "presets.media" not in names:
        names.append("presets.media")
    return names


# ---- the request's caller, for the code that reads and writes the stores -----------------
# ``guarded`` binds it for the whole request (asyncio.to_thread copies it to worker threads).
# None = no API caller (KRC's own pages, tests calling a function directly): unrestricted.

_CURRENT = contextvars.ContextVar("krc_ext_principal", default=None)


def current():
    return _CURRENT.get()


def bind(principal):
    return _CURRENT.set(principal)


def unbind(token):
    _CURRENT.reset(token)


class Denied(Exception):
    """A request the policy refuses -> (status, body). ``guarded`` answers it as is."""

    def __init__(self, status, body):
        super().__init__(body.get("message", ""))
        self.status, self.body = status, body


def not_found(message="Not found."):
    """What an inaccessible resource answers: the same as one that doesn't exist."""
    return Denied(404, {"error": "not_found", "message": message})


def read_only_resource():
    return Denied(403, {"error": "resource_read_only",
                        "message": "This API profile may read that, not change it. Its owner can allow it in KRC Portal ▸ API."})


def no_create(what):
    return Denied(403, {"error": "create_not_permitted",
                        "message": f"This API profile may not make new {what}. Its owner can allow it in KRC Portal ▸ API."})


def unrestricted(scope):
    p = current()
    return p is None or p.unrestricted(scope)


def readable(scope, resource_id):
    p = current()
    return p is None or p.can_read(scope, resource_id)


def writable(scope, resource_id):
    p = current()
    return p is None or p.can_write(scope, resource_id)


def require_read(scope, resource_id, message="Not found."):
    if not readable(scope, resource_id):
        raise not_found(message)


def require_write(scope, resource_id, message="Not found."):
    """Unreadable -> 404 (as missing); readable but not writable -> 403."""
    require_read(scope, resource_id, message)
    if not writable(scope, resource_id):
        raise read_only_resource()


def require_create(scope, what):
    p = current()
    if p is not None and not p.scope(scope).get("create"):
        raise no_create(what)


def created(scope, resource_id):
    """A new resource made by the caller joins its own list (selected mode)."""
    p = current()
    if p is not None and not p.unrestricted(scope):
        profiles.grant_created(p.profile_id, scope, str(resource_id))


def require_file_sources():
    p = current()
    if p is not None and not p.file_sources:
        raise Denied(403, {"error": "file_sources_not_permitted",
                           "message": "This API profile may not read ComfyUI files by name. Use a Media item."})


# ---- Prompt Vault profiles -----------------------------------------------------------------

UNKNOWN_PROFILE = "Unknown prompt profile."


def prompt_profile(requested, *, write=False):
    """The Prompt Vault profile a prompt request works in. Given: it must be accessible (else
    400, as an unknown one). Omitted: Default for an unrestricted caller; otherwise the
    policy's default if accessible, else the first accessible profile; none -> 403."""
    from .prompt_profiles import list_profiles

    requested = str(requested or "").strip()
    p = current()
    if p is None:
        return requested or "default"
    if requested:
        if not p.can_read("prompts", requested):
            raise Denied(400, {"error": "bad_request", "message": UNKNOWN_PROFILE})
        if write and not p.can_write("prompts", requested):
            raise read_only_resource()
        return requested
    ids = [entry["id"] for entry in list_profiles()]
    preferred = p.default("prompts")
    ordered = ([preferred] if preferred in ids else []) + [pid for pid in ids if pid != preferred]
    if p.unrestricted("prompts"):
        ordered = ["default"] + [pid for pid in ordered if pid != "default"]
    for pid in ordered:
        if (p.can_write if write else p.can_read)("prompts", pid):
            return pid
    raise Denied(403, {"error": "no_access", "message": "This API profile has no Prompt Vault profile to use."})


def scrub_prompt_links(entry):
    """A prompt as the caller may see it: the names Prompt Vault caches next to its preset
    links are blanked where the caller can't read that preset (the link ids stay: they're
    the prompt's own data, and resolving them goes through /presets, which applies the
    policy). Mutates and returns ``entry``."""
    if current() is None or not isinstance(entry, dict):
        return entry
    linked = entry.get("llPreset") or entry.get("ll_preset")
    if linked and not preset_readable("ll", linked):
        for key in ("llPresetLabel", "ll_preset_label"):
            if key in entry:
                entry[key] = ""
    kits = entry.get("kitPresets")
    if isinstance(kits, dict):
        for kit_id, link in kits.items():
            if isinstance(link, dict) and link.get("id") and not preset_readable(f"kit:{kit_id}", link["id"]):
                link["label"] = ""
    return entry


def scrub_library(library_response):
    """scrub_prompt_links over a {category: {name: entry}} response."""
    if current() is None:
        return library_response
    for names in (library_response or {}).values():
        if isinstance(names, dict):
            for entry in names.values():
                scrub_prompt_links(entry)
    return library_response


def readable_prompt_matches(record_ids):
    """For a restricted caller: {id: [profile ids it may read that hold that id]}."""
    from .prompt_vault_store import prompt_owners

    p = current()
    owners = prompt_owners(record_ids)
    return {record_id: sorted({o["profileId"] for o in found if p is None or p.can_read("prompts", o["profileId"])})
            for record_id, found in owners.items()}


# ---- Media ---------------------------------------------------------------------------------

def media_folder_key(record):
    """The mediaFolders scope id an item (or folder) belongs to: its folder id, or Unsorted
    of its storage (unsorted:input / unsorted:output)."""
    folder = str(record.get("folder") or "")
    if folder:
        return folder
    return UNSORTED_OUTPUT if record.get("storage") == "output" else UNSORTED_INPUT


def media_item_readable(item):
    return readable("mediaFolders", media_folder_key(item))


def media_item_writable(item):
    return writable("mediaFolders", media_folder_key(item))


def media_folder_readable(folder):
    return readable("mediaFolders", folder["id"])


def require_media_item(item, *, write=False):
    if item is None or not media_item_readable(item):
        raise not_found("No Media item has that id.")
    if write and not media_item_writable(item):
        raise read_only_resource()


def upload_folder(requested, storage="input"):
    """Where an upload goes. Given: it must be writable. Omitted: Unsorted for an unrestricted
    caller (as before), else the policy's default folder if writable, else Unsorted if
    writable; otherwise 403 (name a folder this profile may write)."""
    requested = str(requested or "")
    p = current()
    unsorted = UNSORTED_OUTPUT if storage == "output" else UNSORTED_INPUT
    if requested:
        require_write("mediaFolders", requested, "No Media folder has that id.")
        return requested
    if p is None or (p.unrestricted("mediaFolders") and p.can_write("mediaFolders", unsorted)):
        return ""
    preferred = p.default("mediaFolders")
    if preferred and p.can_write("mediaFolders", preferred):
        return "" if preferred in (UNSORTED_INPUT, UNSORTED_OUTPUT) else preferred
    if p.can_write("mediaFolders", unsorted):
        return ""
    raise Denied(403, {"error": "no_access", "message": "This API profile has no Media folder to upload into. Name a folder it may write."})


# ---- presets ---------------------------------------------------------------------------------

def preset_scope(kind):
    return f"presets.{kind}"


def preset_readable(kind, preset_id):
    return readable(preset_scope(kind), preset_id)


def require_preset(kind, preset_id, *, write=False, message="No preset has that id."):
    (require_write if write else require_read)(preset_scope(kind), preset_id, message)


# ---- models ----------------------------------------------------------------------------------

def model_type_key(row):
    """The models scope id of a Model Library row: its type folder ("lora" for LoRAs)."""
    kind = str(row.get("modelType") or row.get("type") or "")
    return "lora" if kind in ("loras", "lora") else kind


def model_row_readable(row):
    return readable("models", model_type_key(row))



# ---- /changes --------------------------------------------------------------------------------

_PRESET_STORES = {"llPresets": "ll", "csPresets": "cs", "wbPresets": "wb", "mediaPresets": "media"}


def filter_changes(rows):
    """/changes rows a restricted caller may see. Saves of things it can't read are left out
    (no names, ids or timing of other workspaces); a ``delete`` row of an id it can't place
    any more keeps only that opaque id (so a client drops what it cached); ``restore`` rows
    stay (refetch the store, which is filtered). Category rows (``category:<name>``) only for
    categories in its prompt profiles; Collections, Word Banks and model metadata only when
    their scope is unrestricted (otherwise watch /revisions and refetch the list)."""
    p = current()
    if p is None:
        return rows
    from .media import media_store as store

    prompt_ids = [row["item"] for row in rows if row.get("store") == "prompts" and row.get("item")
                  and not str(row["item"]).startswith("category:")]
    readable_prompts = readable_prompt_matches(prompt_ids) if prompt_ids and not p.unrestricted("prompts") else {}
    categories = None

    def category_visible(name):
        nonlocal categories
        if categories is None:
            from .prompt_profiles import list_profiles
            from .prompt_vault_store import load_prompts_with_revision
            categories = set()
            for entry in list_profiles():
                if p.can_read("prompts", entry["id"]):
                    try:
                        categories |= set(load_prompts_with_revision(entry["id"])[1])
                    except ValueError:
                        pass
        return name in categories

    def visible(row):
        name, item, op = row.get("store"), str(row.get("item") or ""), row.get("op")
        if op == "restore" or not item:
            return True
        if name == "prompts":
            if p.unrestricted("prompts"):
                return True
            if item.startswith("category:"):
                return category_visible(item[len("category:"):])
            return bool(readable_prompts.get(item)) or op == "delete"
        if name == "promptProfiles":
            return p.can_read("prompts", item)
        if name in _PRESET_STORES or name == "kitPresets":
            kind = _PRESET_STORES.get(name) or f"kit:{row.get('kit', '')}"
            return p.can_read(preset_scope(kind), item)
        if name == "media":
            if p.unrestricted("mediaFolders"):
                return True
            if item.startswith("folder:"):
                return p.can_read("mediaFolders", item[len("folder:"):])
            try:
                record = store.get(item)
            except store.MediaError:
                record = None
            return op == "delete" if record is None else p.can_read("mediaFolders", media_folder_key(record))
        if name == "loraMetadata":
            return p.can_read("models", "lora")
        if name in ("modelMetadata", "collections"):
            return p.unrestricted("models")
        if name == "wordBanks":
            return p.unrestricted("presets.wb")
        return p.unrestricted(name)

    return [row for row in rows if visible(row)]
