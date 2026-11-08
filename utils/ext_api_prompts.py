"""The external API's Prompt Vault writes and card marks (KRC_EXTERNAL_API.md), each behind
Read only and its permission area (ext_api.WRITE_AREAS): "cardMarks" (prompt and model / LoRA
marks), "promptCategories" (category chips), "promptEditing" (the Prompt Vault node's Editor
side). Plus the reads they need: GET /prompt-categories and each prompt's ``version``.

Every write goes through the node's own code, inside one database transaction:
- prompts: prompt_vault_routes._save_prompt_response in its id-based ("update" / "create")
  mode, the Card API's: a rename or move keeps the id, a name clash is refused, quick marks
  never re-stamp dateModified; duplicate = the profile copy (prompt_profile_copy); thumbnails
  and deletes use the store's own methods, as the node's routes do;
- categories: the same steps as the node's category routes (create, meta, rename / merge,
  delete to Unsorted, purge);
- model / LoRA marks: model_library.bulk_attributes.update_model_marks (the shared writers).

Versions: a prompt's ``version`` hashes its category, name and record (dates left out); a
category's hashes its name and chip marks; a model's ``marksVersion`` its five marks. Each is
checked inside the write's transaction; stale -> Conflict (409 with the current record).

Open nodes hear it as they hear the Portal: PROMPTS_CHANGED (Prompt Vault nodes, Config
Switcher prompt cards, the Portal) and LORA_METADATA_CHANGED for model / LoRA marks.
Per profile: ``profile`` (Default when omitted), as the prompt reads.
"""
import hashlib
import json

from .ext_api_media_writes import Conflict, NotFound
from .ext_api_routes import BadRequest

MARK_KEYS = ("favorite", "pinned", "nsfw", "cardColor", "customBadge")
EDIT_KEYS = ("name", "category", "text", "promptB", "appendPromptB", "model", "notes", "llPreset", "kitPresets")
EMPTY_LINK = "none:empty"
EMPTY_LABEL = "--empty--"


def _hash(value):
    return hashlib.sha1(json.dumps(value, sort_keys=True, ensure_ascii=False, default=str).encode("utf-8")).hexdigest()[:16]


def prompt_version(category, name, record):
    """A prompt's version: its category, name and stored record, dates left out."""
    body = {key: value for key, value in (record or {}).items() if key not in ("dateAdded", "dateModified")}
    return _hash({"category": category, "name": name, "record": body})


def category_version(name, meta):
    meta = meta if isinstance(meta, dict) else {}
    return _hash({"name": name, "pinned": bool(meta.get("pinned")), "cardColor": str(meta.get("cardColor") or ""),
                  "nsfw": bool(meta.get("nsfw"))})


# ---- reads ----------------------------------------------------------------------------

def add_versions(response, library):
    """Put ``version`` on every prompt of a get-prompts shaped response (in place)."""
    for category, bucket in (response or {}).items():
        if not isinstance(bucket, dict):
            continue
        for name, record in bucket.items():
            stored = (library.get(category) or {}).get(name)
            if name != "__meta__" and isinstance(record, dict) and isinstance(stored, dict):
                record["version"] = prompt_version(category, name, stored)
    return response


def category_list(profile_id="default"):
    """GET /krc/ext/v1/prompt-categories: a profile's category chips, in the library's order
    (Unsorted first, then by name; the node draws pinned ones first)."""
    from .prompt_vault_search import UNASSIGNED_LABEL
    from .prompt_vault_store import UNASSIGNED_CATEGORY, load_prompts_with_revision

    try:
        revision, library = load_prompts_with_revision(profile_id)
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    out = []
    for name, bucket in library.items():
        bucket = bucket if isinstance(bucket, dict) else {}
        meta = bucket.get("__meta__") if isinstance(bucket.get("__meta__"), dict) else {}
        out.append({"name": name, "label": UNASSIGNED_LABEL if name == UNASSIGNED_CATEGORY else name,
                    "builtIn": name == UNASSIGNED_CATEGORY, "pinned": bool(meta.get("pinned")),
                    "cardColor": str(meta.get("cardColor") or ""), "nsfw": bool(meta.get("nsfw")),
                    "count": sum(1 for key in bucket if key != "__meta__"), "version": category_version(name, meta)})
    return {"revision": revision, "profileId": profile_id, "categories": out}


# ---- shared ---------------------------------------------------------------------------

def _store(profile_id):
    from ..nodes.krc_prompt_vault import KRCPromptVault
    from .prompt_profile_store import ProfileStore

    try:
        return ProfileStore(KRCPromptVault, str(profile_id or "default"))
    except ValueError as exc:
        raise BadRequest(str(exc)) from None


def _object(payload):
    if not isinstance(payload, dict):
        raise BadRequest("The body must be a JSON object")
    return payload


def _version(payload, key="version"):
    value = payload.get(key)
    if not isinstance(value, str) or not value:
        raise BadRequest(f"{key} is required: the one from your last read")
    return value


def _body(response):
    body = response.body
    return body if isinstance(body, dict) else json.loads(body)


def _announce_prompts():
    from .server_sync import SYNC_EVENTS, publish_sync

    publish_sync(SYNC_EVENTS["PROMPTS_CHANGED"], {"bulk": True, "originPage": ""})


def _revision():
    from .db import connection as db
    return db.revision("prompts")


def _locate(prompts, prompt_id):
    """(category, name) of the one prompt with this id in the profile; 404 / 400."""
    found = [(category, name) for category, bucket in prompts.items() if isinstance(bucket, dict)
             for name, record in bucket.items() if name != "__meta__" and isinstance(record, dict) and record.get("id") == prompt_id]
    if not found:
        raise NotFound("No prompt in that profile has that id.")
    if len(found) > 1:
        raise BadRequest("Several prompts in that profile share that id (an old copy); edit it in Prompt Vault")
    return found[0]


def _detail(category, name, record, profile_id):
    from .prompt_vault_serialization import prompt_detail

    detail = prompt_detail(category, name, record)
    detail["profileId"] = profile_id
    detail["version"] = prompt_version(category, name, record)
    return detail


def _current(store, prompt_id, expected, profile_id):
    """(prompts, category, name) after the version check (inside the caller's transaction)."""
    prompts = store.load_prompts()
    category, name = _locate(prompts, prompt_id)
    record = prompts[category][name]
    if expected is not None and prompt_version(category, name, record) != expected:
        raise Conflict("That prompt changed since you read it. Read it again, then retry.",
                       _detail(category, name, record, profile_id), "prompt")
    return prompts, category, name


def _answer(store, prompt_id, profile_id):
    prompts = store.load_prompts()
    category, name = _locate(prompts, prompt_id)
    return {"prompt": _detail(category, name, prompts[category][name], profile_id), "revision": _revision()}


def _save(store, data):
    """prompt_vault_routes._save_prompt_response (the Card API's mode) -> its body; its
    refusals become 400."""
    from .prompt_vault_routes import _save_prompt_response

    result = _body(_save_prompt_response(store, data))
    if not result.get("success"):
        raise BadRequest(result.get("error") or "Prompt Vault refused the save")
    return result


def _marks_fields(payload):
    from .library.card_colors import CARD_COLOR_IDS

    out = {}
    for key in MARK_KEYS:
        if key not in payload:
            continue
        value = payload[key]
        if key in ("favorite", "pinned", "nsfw"):
            if not isinstance(value, bool):
                raise BadRequest(f"{key} must be true or false")
        elif not isinstance(value, str):
            raise BadRequest(f"{key} must be a string")
        elif key == "cardColor" and value.strip() and value.strip().lower() not in CARD_COLOR_IDS:
            raise BadRequest("Unknown card colour")
        out[key] = value.strip() if isinstance(value, str) else value
    return out


def _only(payload, allowed, what):
    unknown = sorted(set(payload) - set(allowed) - {"version"})
    if unknown:
        raise BadRequest(f"Unknown {what} field {unknown[0]!r} (one of {', '.join(allowed)})")


# ---- card marks -----------------------------------------------------------------------

def prompt_marks(profile_id, prompt_id, payload):
    """POST /krc/ext/v1/prompts/{id}/marks?profile= {version, <marks>} -> {prompt, revision}."""
    from .db import connection as db

    payload = _object(payload)
    _only(payload, MARK_KEYS, "mark")
    marks = _marks_fields(payload)
    if not marks:
        raise BadRequest(f"Nothing to change: send one of {', '.join(MARK_KEYS)}")
    expected = _version(payload)
    store = _store(profile_id)
    with db.write():
        _current(store, prompt_id, expected, profile_id)
        _save(store, {"mode": "update", "id": prompt_id, **marks})
    _announce_prompts()
    return _answer(store, prompt_id, profile_id)


async def model_marks(model_id, payload):
    """POST /krc/ext/v1/models/{id}/marks {marksVersion, <marks>} -> {id, marks, marksVersion}."""
    from .model_library.bulk_attributes import MarksConflict, update_model_marks

    payload = _object(payload)
    unknown = sorted(set(payload) - set(MARK_KEYS) - {"marksVersion"})
    if unknown:
        raise BadRequest(f"Unknown mark field {unknown[0]!r} (one of {', '.join(MARK_KEYS)})")
    marks = _marks_fields(payload)
    if not marks:
        raise BadRequest(f"Nothing to change: send one of {', '.join(MARK_KEYS)}")
    expected = _version(payload, "marksVersion")
    try:
        result = await update_model_marks(str(model_id or ""), marks, if_version=expected)
    except MarksConflict as exc:
        from .model_library.bulk_attributes import marks_version
        raise Conflict(str(exc), {"id": model_id, "marks": exc.current, "marksVersion": marks_version(exc.current)}, "model") from None
    except LookupError as exc:
        raise NotFound(str(exc)) from None
    except ValueError as exc:
        raise BadRequest(str(exc)) from None
    return {"id": result["id"], "marks": result["marks"], "marksVersion": result["marksVersion"], "updated": result["updated"]}


# ---- categories -----------------------------------------------------------------------

CATEGORY_MARKS = ("pinned", "cardColor", "nsfw")


def _category_answer(store, name, profile_id):
    prompts = store.load_prompts()
    meta = (prompts.get(name) or {}).get("__meta__") if isinstance(prompts.get(name), dict) else {}
    entry = next((item for item in category_list(profile_id)["categories"] if item["name"] == name), None)
    return {"category": entry or {"name": name, "version": category_version(name, meta)}, "revision": _revision()}


def _category_current(store, payload, profile_id):
    """(prompts, name) of the category the body names, after its version check."""
    from .prompt_vault_store import UNASSIGNED_CATEGORY

    name = store._normalize_category_name(payload.get("category") if isinstance(payload.get("category"), str) else "")
    if not name:
        raise BadRequest("category is required (its name)")
    expected = _version(payload)
    prompts = store.load_prompts()
    if name not in prompts:
        raise NotFound("No category of that name in that profile.")
    meta = prompts[name].get("__meta__") if isinstance(prompts[name], dict) else {}
    if category_version(name, meta) != expected:
        current = next((item for item in category_list(profile_id)["categories"] if item["name"] == name), None)
        raise Conflict("That category changed since you read it. Read it again, then retry.", current, "category")
    return prompts, name, name == UNASSIGNED_CATEGORY


def category_create(profile_id, payload):
    """POST /krc/ext/v1/prompt-categories/create {name, nsfw?} -> 201 {category, revision}."""
    from .db import connection as db

    payload = _object(payload)
    unknown = sorted(set(payload) - {"name", "nsfw"})
    if unknown:
        raise BadRequest(f"Unknown field {unknown[0]!r} (name, nsfw)")
    if not isinstance(payload.get("name"), str):
        raise BadRequest("name must be a string")
    if "nsfw" in payload and not isinstance(payload["nsfw"], bool):
        raise BadRequest("nsfw must be true or false")
    store = _store(profile_id)
    name = store._normalize_category_name(payload["name"])
    if not name:
        raise BadRequest("name can't be empty")
    with db.write():
        prompts = store.load_prompts()
        existing = {key.lower(): key for key in prompts}
        if name.lower() in existing:
            raise BadRequest(f"Category already exists as '{existing[name.lower()]}'")
        prompts[name] = {"__meta__": {"nsfw": True}} if payload.get("nsfw") else {}
        store.save_prompts(prompts)
    _announce_prompts()
    return _category_answer(store, name, profile_id)


def category_update(profile_id, payload):
    """POST /krc/ext/v1/prompt-categories/update {category, version, pinned?, cardColor?, nsfw?}."""
    from .db import connection as db

    payload = _object(payload)
    unknown = sorted(set(payload) - set(CATEGORY_MARKS) - {"category", "version"})
    if unknown:
        raise BadRequest(f"Unknown field {unknown[0]!r} (pinned, cardColor, nsfw)")
    marks = _marks_fields({key: payload[key] for key in CATEGORY_MARKS if key in payload})
    if not marks:
        raise BadRequest("Nothing to change: send pinned, cardColor or nsfw")
    store = _store(profile_id)
    with db.write():
        prompts, name, _builtin = _category_current(store, payload, profile_id)
        meta = dict(prompts[name].get("__meta__") or {}) if isinstance(prompts[name].get("__meta__"), dict) else {}
        for key, value in marks.items():
            if value:
                meta[key] = True if key != "cardColor" else value
            else:
                meta.pop(key, None)
        if meta:
            prompts[name]["__meta__"] = meta
        else:
            prompts[name].pop("__meta__", None)
        store.save_prompts(prompts)
    _announce_prompts()
    return _category_answer(store, name, profile_id)


def category_rename(profile_id, payload):
    """POST /krc/ext/v1/prompt-categories/rename {category, version, name, merge?}: its prompts
    go with it (ids kept). Into an existing name only with "merge": true (clashing prompt
    names get a suffix, as in the node)."""
    from .db import connection as db

    payload = _object(payload)
    if not isinstance(payload.get("name"), str):
        raise BadRequest("name must be a string")
    if "merge" in payload and not isinstance(payload["merge"], bool):
        raise BadRequest("merge must be true or false")
    store = _store(profile_id)
    new = store._normalize_category_name(payload["name"])
    if not new:
        raise BadRequest("name can't be empty")
    with db.write():
        prompts, name, builtin = _category_current(store, payload, profile_id)
        if builtin:
            raise BadRequest("Unsorted can't be renamed")
        existing = {key.lower(): key for key in prompts}.get(new.lower())
        if existing and existing != name:
            if not payload.get("merge"):
                raise BadRequest(f"Category already exists as '{existing}' (send \"merge\": true to merge)")
            prompts[existing] = store._merge_category_data(prompts[existing], prompts[name], name)
            del prompts[name]
            new = existing
        elif new != name:
            prompts[new] = prompts.pop(name)
        store.save_prompts(prompts)
    _announce_prompts()
    return _category_answer(store, new, profile_id)


def category_delete(profile_id, payload):
    """POST /krc/ext/v1/prompt-categories/delete {category, version}: the chip goes, its
    prompts move to Unsorted (clashing names get a suffix), as the node's Delete."""
    from .db import connection as db
    from .prompt_vault_store import UNASSIGNED_CATEGORY

    payload = _object(payload)
    store = _store(profile_id)
    with db.write():
        prompts, name, builtin = _category_current(store, payload, profile_id)
        if builtin:
            raise BadRequest("Unsorted can't be deleted")
        moved = sum(1 for key in prompts[name] if key != "__meta__")
        prompts.setdefault(UNASSIGNED_CATEGORY, {})
        prompts[UNASSIGNED_CATEGORY] = store._merge_category_data(prompts[UNASSIGNED_CATEGORY], prompts[name], name)
        del prompts[name]
        store.save_prompts(prompts)
    _announce_prompts()
    return {"deleted": name, "moved": moved, "revision": _revision()}


def category_purge(profile_id, payload):
    """POST /krc/ext/v1/prompt-categories/purge {category, version, confirmed: true}: the chip
    AND its prompts (and their thumbnails), as the node's PURGE."""
    from .db import connection as db

    payload = _object(payload)
    if payload.get("confirmed") is not True:
        raise BadRequest('Purging a category deletes it and every prompt in it: send "confirmed": true')
    store = _store(profile_id)
    with db.write():
        prompts, name, builtin = _category_current(store, payload, profile_id)
        if builtin:
            raise BadRequest("Unsorted can't be purged")
        removed = sum(1 for key in prompts[name] if key != "__meta__")
        del prompts[name]
        store.save_prompts(prompts)
        store.gc_orphan_thumbnails(prompts)
    _announce_prompts()
    return {"deleted": name, "removed": removed, "revision": _revision()}


# ---- prompt editing -------------------------------------------------------------------

def _preset_label(kind, preset_id):
    """The name Prompt Vault caches next to a preset link (shown when it goes missing)."""
    if preset_id == EMPTY_LINK:
        return EMPTY_LABEL
    if kind == "ll":
        from .lora_loadout.presets import PresetStore
        found = PresetStore().find_by_id(preset_id)
    else:
        from .loadout_kit.kit import get_kit
        kit = get_kit(kind)
        if kit is None:
            raise BadRequest(f"No Loadout Kit {kind!r} (see /info kits)")
        found = kit.presets().find_by_id(preset_id)
    if found is None:
        raise BadRequest(f"No {'LoRA Loadout' if kind == 'll' else kind} preset has the id {preset_id!r}")
    return found.get("name", "")


def _edit_fields(payload):
    """The Editor-side fields of a body -> _save_prompt_response's keys."""
    out = {}
    for key in ("name", "category", "text", "promptB", "model", "notes"):
        if key in payload:
            if not isinstance(payload[key], str):
                raise BadRequest(f"{key} must be a string")
            out[key] = payload[key]
    if "appendPromptB" in payload:
        if not isinstance(payload["appendPromptB"], bool):
            raise BadRequest("appendPromptB must be true or false")
        out["appendPromptB"] = payload["appendPromptB"]
    if "llPreset" in payload:
        value = payload["llPreset"]
        if not isinstance(value, str):
            raise BadRequest("llPreset must be a preset id, \"none:empty\" or \"\"")
        value = value.strip()
        out["ll_preset"] = value
        out["ll_preset_label"] = _preset_label("ll", value) if value else ""
    if "kitPresets" in payload:
        links = payload["kitPresets"]
        if not isinstance(links, dict):
            raise BadRequest("kitPresets must be {kit id: preset id | \"none:empty\" | \"\"}")
        out["kitPresets"] = {}
        for kit_id, preset_id in links.items():
            if not isinstance(preset_id, str):
                raise BadRequest(f"kitPresets.{kit_id} must be a preset id string")
            if preset_id.strip():
                out["kitPresets"][kit_id] = {"id": preset_id.strip(), "label": _preset_label(kit_id, preset_id.strip())}
    return out


def prompt_create(profile_id, payload):
    """POST /krc/ext/v1/prompts/create?profile= {category, name, text?, promptB?, appendPromptB?,
    model?, notes?, llPreset?, kitPresets?} -> 201 {prompt, revision}. A category that doesn't
    exist yet is made (as the Card API does)."""
    payload = _object(payload)
    _only(payload, EDIT_KEYS, "prompt")
    fields = _edit_fields(payload)
    if not fields.get("category", "").strip() or not fields.get("name", "").strip():
        raise BadRequest("category and name are required")
    store = _store(profile_id)
    result = _save(store, {"mode": "create", **fields})
    _announce_prompts()
    return _answer(store, result["id"], profile_id)


def prompt_update(profile_id, prompt_id, payload):
    """POST /krc/ext/v1/prompts/{id}/update?profile= {version, <Editor fields>}: what's left out
    stays; a new name / category renames / moves it, keeping its id."""
    from .db import connection as db

    payload = _object(payload)
    _only(payload, EDIT_KEYS, "prompt")
    fields = _edit_fields(payload)
    if not fields:
        raise BadRequest(f"Nothing to change: send one of {', '.join(EDIT_KEYS)}")
    expected = _version(payload)
    store = _store(profile_id)
    with db.write():
        _current(store, prompt_id, expected, profile_id)
        _save(store, {"mode": "update", "id": prompt_id, **fields})
    _announce_prompts()
    return _answer(store, prompt_id, profile_id)


def prompt_duplicate(profile_id, prompt_id, payload):
    """POST /krc/ext/v1/prompts/{id}/duplicate?profile= {name?, category?, toProfile?}: a copy
    with a new id (thumbnail too), as the Editor's Duplicate / Copy to profile. The name
    defaults to "<name> copy" (numbered when taken)."""
    from .prompt_profile_copy import copy_prompt_response
    from .prompt_vault_routes import _save_prompt_response

    payload = _object(payload)
    unknown = sorted(set(payload) - {"name", "category", "toProfile"})
    if unknown:
        raise BadRequest(f"Unknown field {unknown[0]!r} (name, category, toProfile)")
    for key in ("name", "category", "toProfile"):
        if key in payload and not isinstance(payload[key], str):
            raise BadRequest(f"{key} must be a string")
    source_store = _store(profile_id)
    prompts = source_store.load_prompts()
    category, name = _locate(prompts, prompt_id)
    target_profile = payload.get("toProfile") or profile_id
    target = _store(target_profile)
    target_prompts = target.load_prompts()
    new_category = target._normalize_category_name(payload.get("category") or category)
    new_name = (payload.get("name") or "").strip()
    if not new_name:
        taken = {key.lower() for key in (target_prompts.get(new_category) or {})}
        new_name, number = f"{name} copy", 2
        while new_name.lower() in taken:
            new_name, number = f"{name} copy {number}", number + 1
    record = prompts[category][name]
    data = {"source_id": prompt_id, "source_category": category, "source_name": name, "category": new_category,
            "name": new_name, "text": record.get("prompt", ""), "promptB": record.get("promptB", ""),
            "appendPromptB": bool(record.get("appendPromptB")), "model": record.get("model", ""),
            "notes": record.get("notes", ""), "ll_preset": record.get("ll_preset", ""),
            "ll_preset_label": record.get("ll_preset_label", ""), "kitPresets": record.get("kitPresets") or {}}
    result = _body(copy_prompt_response(target, data, _save_prompt_response))
    if not result.get("success"):
        raise BadRequest(result.get("error") or "Prompt Vault refused the copy")
    _announce_prompts()
    return _answer(target, result["id"], target_profile)


def prompt_delete(profile_id, prompt_id, payload):
    """POST /krc/ext/v1/prompts/{id}/delete?profile= {version}: the prompt and its thumbnail."""
    from .db import connection as db

    payload = _object(payload)
    expected = _version(payload)
    store = _store(profile_id)
    with db.write():
        prompts, category, name = _current(store, prompt_id, expected, profile_id)
        del prompts[category][name]
        store.save_prompts(prompts)
        store.gc_orphan_thumbnails(prompts)
    _announce_prompts()
    return {"deleted": prompt_id, "revision": _revision()}


def prompt_thumbnail(profile_id, prompt_id, payload, clear=False):
    """POST /krc/ext/v1/prompts/{id}/thumbnail?profile= {version, image: "data:image/…;base64,…"}
    sets a still thumbnail (stored as a constrained WebP); /thumbnail/clear {version} removes it."""
    import uuid

    from .db import connection as db
    from .prompt_vault_routes import _modified_at

    payload = _object(payload)
    expected = _version(payload)
    store = _store(profile_id)
    raw = None
    if not clear:
        image = payload.get("image")
        if not isinstance(image, str) or not image.startswith("data:image/"):
            raise BadRequest('image must be a data URL ("data:image/png;base64,…")')
        raw = store._decode_data_url(image)
        if not raw:
            raise BadRequest("Unreadable image data")
    with db.write():
        prompts, category, name = _current(store, prompt_id, expected, profile_id)
        record = prompts[category][name]
        if clear:
            store.delete_thumbnail(record.get("id"))
            for key in ("hasThumb", "thumbType", "thumbHasPoster"):
                record.pop(key, None)
        else:
            store.delete_thumbnail(record.get("id"))   # a still replaces any video thumbnail
            if store.save_thumbnail_bytes(record["id"], raw) is None:
                raise BadRequest("Unreadable image")
            record["hasThumb"] = True
            record.pop("thumbType", None)
            record.pop("thumbHasPoster", None)
        now = _modified_at(record)
        record["dateAdded"] = record.get("dateAdded") or now
        record["dateModified"] = now
        record["thumbnailVersion"] = uuid.uuid4().hex
        store.save_prompts(prompts)
    _announce_prompts()
    return _answer(store, prompt_id, profile_id)
