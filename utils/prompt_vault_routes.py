import os
import shutil
import tempfile
import uuid
from pathlib import Path
from datetime import datetime, timedelta, timezone

import server

from . import krc_video
from .upload_limits import VIDEO_UPLOAD_MAX, UploadTooLarge, check_declared_size, copy_part
from .krc_paths import read_max_pinned
from .library.response_work import prepare_library_response
from .library.thumbnail_sizes import parse_width, thumbnail_to_serve
from .library.thumbnails import thumbnail_cache_headers
from .krc_video_settings import load_settings
from .bundle.sections import register_section
from .prompt_vault_archive import bundle_sections as prompt_vault_bundle_sections
from .prompt_vault_serialization import parse_fields, prompt_detail, prompt_details, select_fields
from .bulk_selection import validate_card_ids
from .prompt_vault_search import prompt_text_matches
from .custom_badge import normalize_custom_badge
from .bulk_attributes import update_prompt_attributes
from .card_sync import notify_card_write
from .prompt_vault_bulk import prompt_bulk_operation
from .db import connection as db
from .prompt_profile_routes import bind_profile, register_profile_routes
from .prompt_profile_copy import copy_prompt_response
from .prompt_profiles import DEFAULT_PROFILE_ID
from .prompt_vault_store import (
    UNASSIGNED_CATEGORY,
    load_prompts_with_revision,
    normalize_kit_presets,
    prompts_by_id,
    prompts_by_ids,
)


PROMPT_VAULT_API_PREFIX = "/krc/prompt-vault"
MAX_PINNED = read_max_pinned()
_ROUTES_REGISTERED = False


def _modified_at(record=None):
    """Millisecond dates remain distinguishable even for rapid consecutive writes."""
    now = datetime.now(timezone.utc)
    try:
        previous = datetime.fromisoformat((record or {}).get("dateModified", "").replace("Z", "+00:00"))
        now = max(now, previous + timedelta(milliseconds=1))
    except (TypeError, ValueError):
        pass
    return now.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _find_prompt_by_id(prompts, record_id):
    """(category, name) of the record with this id, or None."""
    for category, bucket in prompts.items():
        if not isinstance(bucket, dict):
            continue
        for name, record in bucket.items():
            if name != "__meta__" and isinstance(record, dict) and record.get("id") == record_id:
                return category, name
    return None


def prepare_api_save(prompts, data, normalize_category):
    """Card API saves (JS savePrompt) on /save-prompt, chosen by ``data["mode"]``:

    - "update": the record is found by ``id`` wherever it lives. A different category or
      name renames / moves it (a clash with ANOTHER prompt is refused, never overwritten);
      category, name and text left out keep their stored values (other fields already do).
    - "create": a new prompt with a fresh id, refused when the name is taken.

    Prompt Vault's own saves send no mode and keep the category + name rule (its copies
    carry a source id, so id can't mean "move" for them). A category matches an existing
    one case-insensitively. Mutates ``data`` (fills category / name / text) and, for a
    move, ``prompts``. -> (error or None, moved)"""
    mode = data.get("mode")
    located = None
    if mode == "update":
        record_id = str(data.get("id") or "").strip()
        located = _find_prompt_by_id(prompts, record_id) if record_id else None
        if located is None:
            return "Prompt not found", False
    elif mode != "create":
        return f"Unknown save mode '{mode}'", False
    category = normalize_category(data.get("category") or (located[0] if located else ""))
    name = str(data.get("name") or (located[1] if located else "")).strip()
    if not category or not name:
        return "Category and name are required", False
    if name == "__meta__":
        return "That prompt name is reserved", False
    category = next((key for key in prompts if key.lower() == category.lower()), category)
    bucket = prompts.get(category) if isinstance(prompts.get(category), dict) else {}
    clash = next(
        (key for key in bucket if key != "__meta__" and key.lower() == name.lower() and (category, key) != located),
        None,
    )
    if clash is not None:
        return f"A prompt named '{clash}' already exists in '{category}'", False
    data["category"] = category
    data["name"] = name
    if mode == "create":
        data["id"] = ""
        return None, False
    old_category, old_name = located
    record = prompts[old_category][old_name]
    if "text" not in data:
        data["text"] = record.get("prompt", "")
    moved = (old_category, old_name) != (category, name)
    if moved:
        del prompts[old_category][old_name]
        prompts.setdefault(category, {})[name] = record
    return None, moved


def _save_prompt_response(prompt_store, data, *, source_record=None, category_meta=None):
    # The library's read-modify-save in one transaction (no await inside), so a
    # bundle import or another thread's write can't land in between and be lost.
    with db.write():
        prompts = None
        moved = False
        if data.get("mode"):
            prompts = prompt_store.load_prompts()
            error, moved = prepare_api_save(prompts, data, prompt_store._normalize_category_name)
            if error:
                return server.web.json_response({"success": False, "error": error})
        category = prompt_store._normalize_category_name(data.get("category", ""))
        name = data.get("name", "").strip()
        text = data.get("text", "").strip()

        if not category or not name:
            return server.web.json_response({"success": False, "error": "Category and name are required"})

        if prompts is None:
            prompts = prompt_store.load_prompts()

        if category not in prompts:
            prompts[category] = {"__meta__": category_meta} if category_meta else {}

        existing_prompts_lower = {k.lower(): k for k in prompts[category].keys()}
        existing_prompt = dict(source_record or {})
        if name.lower() in existing_prompts_lower:
            old_name = existing_prompts_lower[name.lower()]
            existing_prompt = prompts[category].get(old_name, {})
            if old_name != name:
                print(f"[KRC Prompt Vault] Removing old casing '{old_name}' before saving as '{name}'")
                del prompts[category][old_name]

        now = _modified_at(existing_prompt)

        prompt_data = {
            "prompt": text,
        }

        nsfw = data.get("nsfw")
        if nsfw is not None:
            prompt_data["nsfw"] = bool(nsfw)
        elif existing_prompt.get("nsfw"):
            prompt_data["nsfw"] = existing_prompt["nsfw"]

        ll_preset = data.get("ll_preset")
        if ll_preset is None:
            ll_preset = existing_prompt.get("ll_preset", "")
        ll_preset = (ll_preset or "").strip()
        if ll_preset:
            prompt_data["ll_preset"] = ll_preset

        # Cached display name for the referenced preset id — used only to show
        # a "missing" reference if the preset is later deleted; self-heals from
        # the live preset list whenever the id still resolves.
        ll_preset_label = data.get("ll_preset_label")
        if ll_preset_label is None:
            ll_preset_label = existing_prompt.get("ll_preset_label", "")
        ll_preset_label = (ll_preset_label or "").strip()
        if ll_preset_label:
            prompt_data["ll_preset_label"] = ll_preset_label

        # Loadout Kit preset links ({kit_id: {id, label}}); the client sends the whole map.
        kit_presets = data.get("kitPresets")
        if kit_presets is None:
            kit_presets = existing_prompt.get("kitPresets")
        kit_presets = normalize_kit_presets(kit_presets)
        if kit_presets:
            prompt_data["kitPresets"] = kit_presets

        prompt_data["id"] = existing_prompt.get("id") or prompt_store.safe_record_id(data.get("id")) or uuid.uuid4().hex
        prompt_data["dateAdded"] = existing_prompt.get("dateAdded") or data.get("dateAdded") or now
        # dateModified is computed at the end, after the record is fully assembled,
        # so a quick-metadata-only toggle (favorite/pinned/nsfw/customBadge/cardColor)
        # leaves it untouched — only a real content change re-stamps it. See below.

        def _carry_str(key):
            val = data.get(key)
            if val is None:
                val = existing_prompt.get(key, "")
            val = (val or "").strip()
            if val:
                prompt_data[key] = val

        _carry_str("model")
        _carry_str("cardColor")
        _carry_str("notes")
        _carry_str("promptB")
        _carry_str("replaceFind")
        _carry_str("replaceWith")

        for flag in ("favorite", "pinned", "appendPromptB", "hasThumb"):
            val = data.get(flag)
            if val is None:
                val = existing_prompt.get(flag)
            if val:
                prompt_data[flag] = True

        custom_badge = data.get("customBadge")
        if custom_badge is None:
            custom_badge = existing_prompt.get("customBadge", "")
        custom_badge = normalize_custom_badge(custom_badge)
        if custom_badge is None:
            return server.web.json_response({
                "success": False,
                "error": "Custom badge must use letters, numbers, and spaces only (10 max)",
            })
        if custom_badge:
            prompt_data["customBadge"] = custom_badge

        rating = _as_int(data.get("rating", existing_prompt.get("rating", 0)), 0)
        if rating:
            prompt_data["rating"] = rating

        _MANAGED_KEYS = {"prompt", "thumb", "thumbnail", "nsfw", "ll_preset", "ll_preset_label", "kitPresets", "trigger",
                         "id", "dateAdded", "dateModified", "model", "cardColor", "notes",
                         "promptB", "replaceFind", "replaceWith", "favorite", "pinned", "jsonPrompt", "customBadge",
                         "rating", "appendPromptB", "useInputThumbnail", "hasThumb", "thumbType"}
        for extra_key, extra_val in existing_prompt.items():
            if extra_key not in _MANAGED_KEYS and extra_key not in prompt_data:
                prompt_data[extra_key] = extra_val

        # Quick-metadata toggles must not touch the modified date. Re-stamp only when
        # a field OTHER than the quick-metadata set changed (or the record is new);
        # otherwise carry the stored dateModified forward untouched.
        _QUICK_META_KEYS = {"favorite", "pinned", "nsfw", "customBadge", "cardColor", "rating"}
        _DATE_KEYS = {"id", "dateAdded", "dateModified"}
        def _cmp(value):
            return "" if value is None else value
        compared_keys = (set(prompt_data) | set(existing_prompt)) - _QUICK_META_KEYS - _DATE_KEYS
        content_changed = (not existing_prompt) or any(
            _cmp(prompt_data.get(key)) != _cmp(existing_prompt.get(key)) for key in compared_keys
        )
        # A rename / move re-stamps it, as /rename-prompt does.
        prompt_data["dateModified"] = now if content_changed or moved else (existing_prompt.get("dateModified") or now)

        if prompt_data.get("pinned"):
            pinned_count = 0
            current_id = prompt_data.get("id")
            for prompt_bucket in prompts.values():
                if not isinstance(prompt_bucket, dict):
                    continue
                for existing_name, existing_data in prompt_bucket.items():
                    if existing_name == "__meta__" or not isinstance(existing_data, dict):
                        continue
                    if existing_data.get("id") == current_id:
                        continue
                    if existing_data.get("pinned"):
                        pinned_count += 1
            if pinned_count >= MAX_PINNED:
                return server.web.json_response({"success": False, "error": f"Only {MAX_PINNED} prompts can be pinned"})

        prompts[category][name] = prompt_data
        prompt_store.save_prompts(prompts)

        return server.web.json_response({
            "success": True,
            "prompts": prompt_store.prompts_for_response(prompts),
            "id": prompt_data["id"],
            "category": category,
            "name": name,
        })


def prompt_vault_route(method, path, *, store=None):
    """Register a Prompt Vault API route under /krc/prompt-vault."""
    def decorator(handler):
        routes = server.PromptServer.instance.routes
        if store is not None:
            handler = bind_profile(handler, store, identity=method == "get" and path in {"/prompt-detail", "/thumbnail"})
        if method == "post" and path not in {"/bulk-operation/preview", "/bulk-operation", "/bulk-attributes", "/prompt-details"}:
            handler = notify_card_write("prompt")(handler)
        getattr(routes, method)(f"{PROMPT_VAULT_API_PREFIX}{path}")(handler)
        return handler
    return decorator


def register_prompt_vault_routes(prompt_store):
    global _ROUTES_REGISTERED

    if _ROUTES_REGISTERED:
        return
    _ROUTES_REGISTERED = True
    register_profile_routes()

    # This node's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md).
    for section in prompt_vault_bundle_sections(prompt_store):
        register_section(section)

    @prompt_vault_route("post", "/bulk-operation/preview", store=prompt_store)
    async def preview_prompt_operation(request, prompt_store=prompt_store):
        try:
            return server.web.json_response(prompt_bulk_operation(prompt_store, await request.json(), preview=True))
        except ValueError as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=500)

    @prompt_vault_route("post", "/bulk-operation", store=prompt_store)
    async def execute_prompt_operation(request, prompt_store=prompt_store):
        try:
            return server.web.json_response(prompt_bulk_operation(prompt_store, await request.json()))
        except ValueError as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=500)

    @prompt_vault_route("post", "/bulk-attributes", store=prompt_store)
    async def bulk_prompt_attributes(request, prompt_store=prompt_store):
        try:
            return server.web.json_response(update_prompt_attributes(prompt_store, await request.json()))
        except ValueError as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=500)

    @prompt_vault_route("get", "/get-prompts", store=prompt_store)
    async def get_prompts_advanced(request, prompt_store=prompt_store):
        """The whole library, text deferred. ``?fields=a,b`` keeps only those record fields
        (category and prompt names are keys, so they stay); without it, every field."""
        try:
            try:
                fields = parse_fields(request.query.get("fields", ""))
            except ValueError as exc:
                return server.web.json_response({"error": str(exc)}, status=400)
            def prepare():
                prompts = prompt_store.load_prompts()
                return server.web.json_response(select_fields(prompt_store.prompts_for_response(prompts), fields))
            return await prepare_library_response(prepare)
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in get_prompts API: {e}")
            return server.web.json_response({"error": str(e)}, status=500)

    @prompt_vault_route("get", "/search-text", store=prompt_store)
    async def search_prompt_text(request, prompt_store=prompt_store):
        """The node's ``prompt:`` search: which prompts' saved Prompt A / B contain every
        ``prompt:`` value in ``q`` (the node holds the text back, so it asks). ->
        ``{"revision", "matches": [[category, name], …]}``."""
        try:
            query = request.query.get("q", "")
            def prepare():
                profile_id = getattr(prompt_store, "profile_id", DEFAULT_PROFILE_ID)
                revision, library = load_prompts_with_revision() if profile_id == DEFAULT_PROFILE_ID else load_prompts_with_revision(profile_id)
                matches = prompt_text_matches(library, query)
                return server.web.json_response({"revision": revision, "matches": [list(match) for match in matches]})
            return await prepare_library_response(prepare)
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in search_text API: {e}")
            return server.web.json_response({"error": str(e)}, status=500)

    @prompt_vault_route("get", "/prompt-detail", store=prompt_store)
    async def get_prompt_detail_advanced(request, prompt_store=prompt_store):
        """Return one full prompt record, including deferred text fields: by ``id`` (the
        first match by category, then name, when copies share it), else by ``category`` +
        ``name``. When both are given, ``id`` wins."""
        try:
            record_id = request.query.get("id", "").strip()
            if record_id:
                matches = prompts_by_id(record_id)
                if not matches:
                    return server.web.json_response({"error": "Prompt not found"}, status=404)
                return server.web.json_response(prompt_detail(*matches[0]))
            category = prompt_store._normalize_category_name(request.query.get("category", ""))
            name = request.query.get("name", "").strip()
            if not category or not name:
                return server.web.json_response({"error": "Category and prompt name are required"}, status=400)
            prompts = prompt_store.load_prompts()
            record = prompts.get(category, {}).get(name)
            if not isinstance(record, dict):
                return server.web.json_response({"error": "Prompt not found"}, status=404)
            detail = prompt_detail(category, name, record)
            detail["profileId"] = getattr(prompt_store, "profile_id", DEFAULT_PROFILE_ID)
            return server.web.json_response(detail)
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in prompt_detail API: {e}")
            return server.web.json_response({"error": str(e)}, status=500)

    @prompt_vault_route("post", "/prompt-details", store=prompt_store)
    async def get_prompt_details(request, prompt_store=prompt_store):
        """Explicit references are global; batch catch-up never relies on name keys."""
        try:
            data = await request.json()
            ids = validate_card_ids(data.get("ids"))
            if len(ids) > 500:
                raise ValueError("At most 500 prompt references per request")
            _revision, found = prompts_by_ids(ids)
            matches = [found[record_id][0] for record_id in ids if found.get(record_id)]
            return server.web.json_response({"details": prompt_details(matches)})
        except (ValueError, TypeError, AttributeError) as exc:
            return server.web.json_response({"error": str(exc)}, status=400)

    @prompt_vault_route("post", "/save-category", store=prompt_store)
    async def save_category_advanced(request, prompt_store=prompt_store):
        """API endpoint to create a new category"""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category_name = prompt_store._normalize_category_name(data.get("category_name", ""))

                if not category_name:
                    return server.web.json_response({"success": False, "error": "Category name is required"})

                prompts = prompt_store.load_prompts()

                existing_categories_lower = {k.lower(): k for k in prompts.keys()}
                if category_name.lower() in existing_categories_lower:
                    return server.web.json_response({
                        "success": False,
                        "error": f"Category already exists as '{existing_categories_lower[category_name.lower()]}'"
                    })

                nsfw = data.get("nsfw", False)
                cat_data = {}
                if nsfw:
                    cat_data["__meta__"] = {"nsfw": True}
                prompts[category_name] = cat_data
                prompt_store.save_prompts(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts)})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in save_category API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/save-category-meta", store=prompt_store)
    async def save_category_meta_advanced(request, prompt_store=prompt_store):
        """API endpoint to update category metadata such as NSFW, pinning, and chip color."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))

                if not category:
                    return server.web.json_response({"success": False, "error": "Category name is required"})

                prompts = prompt_store.load_prompts()
                if category not in prompts:
                    return server.web.json_response({"success": False, "error": "Category not found"})

                meta = prompts[category].get("__meta__")
                if not isinstance(meta, dict):
                    meta = {}

                if "nsfw" in data:
                    if data.get("nsfw"):
                        meta["nsfw"] = True
                    else:
                        meta.pop("nsfw", None)

                if "pinned" in data:
                    if data.get("pinned"):
                        meta["pinned"] = True
                    else:
                        meta.pop("pinned", None)

                if "cardColor" in data:
                    card_color = (data.get("cardColor") or "").strip()
                    if card_color:
                        meta["cardColor"] = card_color
                    else:
                        meta.pop("cardColor", None)

                if meta:
                    prompts[category]["__meta__"] = meta
                else:
                    prompts[category].pop("__meta__", None)

                prompt_store.save_prompts(prompts)
                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts)})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in save_category_meta API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/save-prompt", store=prompt_store)
    async def save_prompt_advanced(request, prompt_store=prompt_store):
        """API endpoint to save a prompt. ``mode`` "update" / "create" are the Card API's
        id-based saves (see prepare_api_save); no mode is Prompt Vault's own save."""
        try:
            data = await request.json()
            return _save_prompt_response(prompt_store, data)
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in save_prompt API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/copy-to-profile", store=prompt_store)
    async def copy_to_profile(request, prompt_store=prompt_store):
        try:
            data = await request.json()
            return copy_prompt_response(prompt_store, data, _save_prompt_response)
        except ValueError as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=400)
        except Exception as exc:
            return server.web.json_response({"success": False, "error": str(exc)}, status=500)

    @prompt_vault_route("post", "/delete-category", store=prompt_store)
    async def delete_category_advanced(request, prompt_store=prompt_store):
        """API endpoint to delete a category"""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))

                if not category:
                    return server.web.json_response({"success": False, "error": "Category name is required"})

                prompts = prompt_store.load_prompts()

                if category not in prompts:
                    return server.web.json_response({"success": False, "error": "Category not found"})

                if category == UNASSIGNED_CATEGORY:
                    return server.web.json_response({"success": False, "error": "Unassigned cannot be purged"})

                del prompts[category]
                prompt_store.save_prompts(prompts)
                prompt_store.gc_orphan_thumbnails(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts)})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in delete_category API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/rename-category", store=prompt_store)
    async def rename_category_advanced(request, prompt_store=prompt_store):
        """API endpoint to rename a category and all prompts under it."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))
                new_category = prompt_store._normalize_category_name(data.get("new_category", ""))
                merge = bool(data.get("merge"))

                if not category or not new_category:
                    return server.web.json_response({"success": False, "error": "Category and new category name are required"})

                prompts = prompt_store.load_prompts()

                if category not in prompts:
                    return server.web.json_response({"success": False, "error": "Category not found"})

                if category == UNASSIGNED_CATEGORY:
                    return server.web.json_response({"success": False, "error": "Unassigned cannot be renamed"})

                if category == new_category:
                    return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts), "new_category": new_category})

                existing_categories_lower = {k.lower(): k for k in prompts.keys()}
                existing = existing_categories_lower.get(new_category.lower())
                if existing and existing != category:
                    if not merge:
                        return server.web.json_response({
                            "success": False,
                            "conflict": "category_exists",
                            "existing_category": existing,
                            "error": f"Category already exists as '{existing}'"
                        })
                    prompts[existing] = prompt_store._merge_category_data(prompts[existing], prompts[category], category)
                    del prompts[category]
                    prompt_store.save_prompts(prompts)
                    return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts), "new_category": existing})

                prompts[new_category] = prompts[category]
                del prompts[category]
                prompt_store.save_prompts(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts), "new_category": new_category})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in rename_category API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/delete-category-safe", store=prompt_store)
    async def delete_category_safe_advanced(request, prompt_store=prompt_store):
        """Delete a category label, moving prompts into Unassigned."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))

                if not category:
                    return server.web.json_response({"success": False, "error": "Category name is required"})

                prompts = prompt_store.load_prompts()

                if category not in prompts:
                    return server.web.json_response({"success": False, "error": "Category not found"})

                if category == UNASSIGNED_CATEGORY:
                    return server.web.json_response({"success": False, "error": "Unassigned cannot be deleted"})

                prompts.setdefault(UNASSIGNED_CATEGORY, {})
                prompts[UNASSIGNED_CATEGORY] = prompt_store._merge_category_data(
                    prompts[UNASSIGNED_CATEGORY],
                    prompts[category],
                    category,
                )
                del prompts[category]
                prompt_store.save_prompts(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts), "new_category": UNASSIGNED_CATEGORY})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in delete_category_safe API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/delete-prompt", store=prompt_store)
    async def delete_prompt_advanced(request, prompt_store=prompt_store):
        """API endpoint to delete a prompt"""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))
                name = data.get("name", "").strip()

                if not category or not name:
                    return server.web.json_response({"success": False, "error": "Category and prompt name are required"})

                prompts = prompt_store.load_prompts()

                if category not in prompts or name not in prompts[category]:
                    return server.web.json_response({"success": False, "error": "Prompt not found"})

                del prompts[category][name]
                prompt_store.save_prompts(prompts)
                prompt_store.gc_orphan_thumbnails(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts)})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in delete_prompt API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/rename-prompt", store=prompt_store)
    async def rename_prompt_advanced(request, prompt_store=prompt_store):
        """API endpoint to rename/move a prompt, optionally to a different category"""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))
                old_name = data.get("old_name", "").strip()
                new_name = data.get("new_name", "").strip()
                new_category = prompt_store._normalize_category_name(data.get("new_category", "")) or category
                # When true, a name collision in the target replaces the existing prompt
                # (the renamed/moved prompt survives) instead of being rejected. The client
                # confirms this via the overwrite popover; default stays block-on-collision.
                overwrite = bool(data.get("overwrite"))

                if not category or not old_name or not new_name:
                    return server.web.json_response({"success": False, "error": "Category, old name, and new name are required"})

                prompts = prompt_store.load_prompts()

                if category not in prompts or old_name not in prompts[category]:
                    return server.web.json_response({"success": False, "error": "Prompt not found"})

                if new_category not in prompts:
                    return server.web.json_response({"success": False, "error": f"Category '{new_category}' not found"})

                target_prompts = prompts[new_category]
                if category == new_category:
                    existing_lower = {k.lower(): k for k in target_prompts.keys() if k != "__meta__" and k.lower() != old_name.lower()}
                else:
                    existing_lower = {k.lower(): k for k in target_prompts.keys() if k != "__meta__"}

                if new_name.lower() in existing_lower:
                    if not overwrite:
                        return server.web.json_response({
                            "success": False,
                            "error": f"A prompt named '{existing_lower[new_name.lower()]}' already exists in '{new_category}'"
                        })
                    # Overwrite: drop the record being replaced so the renamed/moved prompt
                    # takes its slot (that prompt keeps its own id + content).
                    prompts[new_category].pop(existing_lower[new_name.lower()], None)

                prompts[new_category][new_name] = prompts[category][old_name]
                if isinstance(prompts[new_category][new_name], dict):
                    now = _modified_at(prompts[new_category][new_name])
                    prompts[new_category][new_name]["dateAdded"] = prompts[new_category][new_name].get("dateAdded") or now
                    prompts[new_category][new_name]["dateModified"] = now
                del prompts[category][old_name]
                prompt_store.save_prompts(prompts)

                return server.web.json_response({"success": True, "prompts": prompt_store.prompts_for_response(prompts), "new_name": new_name, "new_category": new_category})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in rename_prompt API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)


    @prompt_vault_route("post", "/upload-thumbnail", store=prompt_store)
    async def upload_thumbnail(request, prompt_store=prompt_store):
        """Store a constrained WebP keyed by the prompt's record id."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))
                name = data.get("name", "").strip()
                if not category or not name:
                    return server.web.json_response({"success": False, "error": "Category and name required"})

                prompts = prompt_store.load_prompts()
                if category not in prompts or name not in prompts[category]:
                    return server.web.json_response({"success": False, "error": "Prompt not found"})
                record = prompts[category][name]
                record_id = record.get("id") or uuid.uuid4().hex
                record["id"] = record_id

                raw = prompt_store._decode_data_url(data.get("thumbnail"))
                path = prompt_store.save_thumbnail_bytes(record_id, raw)
                if path is None:
                    return server.web.json_response({"success": False, "error": "Unreadable image"}, status=400)

                record["hasThumb"] = True
                now = _modified_at(record)
                record["dateAdded"] = record.get("dateAdded") or now
                record["dateModified"] = now
                record["thumbnailVersion"] = uuid.uuid4().hex
                prompt_store.save_prompts(prompts)
                return server.web.json_response({"success": True, "id": record_id, "dateModified": now, "thumbnailVersion": record["thumbnailVersion"]})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in upload_thumbnail API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/upload-video-thumbnail", store=prompt_store)
    async def upload_video_thumbnail(request, prompt_store=prompt_store):
        """Direct mp4/webm upload -> the KRC constrained thumbnail set (webp poster +
        VP9 webm loop) keyed by the prompt's record id. The upload is transient: it is
        transcoded and discarded, no original is stored. Category/name/file arrive as
        multipart parts (binary, so a multi-MB clip isn't base64-inflated)."""
        if not krc_video.VIDEO_SUPPORT:
            return server.web.json_response(
                {"success": False, "error": krc_video.NO_VIDEO_MESSAGE},
                status=503)
        tmp_path = None
        try:
            check_declared_size(request, VIDEO_UPLOAD_MAX)
            reader = await request.multipart()
            category = name = ""
            video_written = False
            with tempfile.NamedTemporaryFile(suffix=".upload", delete=False) as handle:
                tmp_path = Path(handle.name)
                while True:
                    part = await reader.next()
                    if part is None:
                        break
                    if part.name == "category":
                        category = prompt_store._normalize_category_name((await part.text()))
                    elif part.name == "name":
                        name = (await part.text()).strip()
                    elif part.name in ("video", "file"):
                        await copy_part(part, handle, VIDEO_UPLOAD_MAX)
                        video_written = True

            if not category or not name:
                return server.web.json_response({"success": False, "error": "Category and name required"})
            if not video_written or not tmp_path.stat().st_size:
                return server.web.json_response({"success": False, "error": "Empty upload"})
            if not krc_video.sniff_container(tmp_path):
                return server.web.json_response(
                    {"success": False, "error": krc_video.UNSUPPORTED_VIDEO_MESSAGE}, status=400)
            # Transcoding runs outside any transaction (it takes seconds); the record update
            # after it is one read-modify-save.
            found = prompt_store.load_prompts().get(category, {}).get(name)
            if not isinstance(found, dict):
                return server.web.json_response({"success": False, "error": "Prompt not found"})
            record_id = found.get("id") or uuid.uuid4().hex
            settings = load_settings()
            prompt_store.delete_thumbnail(record_id)  # clean replace
            result = krc_video.transcode_upload(
                tmp_path,
                prompt_store.get_thumbnail_path(record_id, prompt_store.THUMB_EXTENSION),
                prompt_store.get_thumbnail_path(record_id, ".webm"),
                want_animated=True,
                frame=settings.get("posterFrame", "first"),
                crf=settings.get("webmCrf"),
            )
            if not result["poster"] and not result["animated"]:
                return server.web.json_response(
                    {"success": False, "error": "Could not read that video file."}, status=400)
            with db.write():
                prompts = prompt_store.load_prompts()
                record = prompts.get(category, {}).get(name)
                if not isinstance(record, dict):
                    return server.web.json_response({"success": False, "error": "Prompt not found"})
                record["id"] = record.get("id") or record_id
                record["hasThumb"] = True
                record["thumbType"] = "video" if result["animated"] else "image"
                record["thumbHasPoster"] = bool(result["poster"])
                now = _modified_at(record)
                record["dateAdded"] = record.get("dateAdded") or now
                record["dateModified"] = now
                record["thumbnailVersion"] = uuid.uuid4().hex
                prompt_store.save_prompts(prompts)
            return server.web.json_response({
                "success": True,
                "id": record_id,
                "dateModified": now,
                "thumbnailVersion": record["thumbnailVersion"],
                "hasAnimation": bool(result["animated"]),
                "reason": result["reason"],
            })
        except UploadTooLarge as e:
            return server.web.json_response({"success": False, "error": str(e)}, status=413)
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in upload_video_thumbnail API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)
        finally:
            if tmp_path is not None:
                try:
                    tmp_path.unlink()
                except OSError:
                    pass

    @prompt_vault_route("post", "/remove-thumbnail", store=prompt_store)
    async def remove_thumbnail(request, prompt_store=prompt_store):
        """Delete the id-keyed thumbnail and clear the record's hasThumb marker."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                category = prompt_store._normalize_category_name(data.get("category", ""))
                name = data.get("name", "").strip()
                prompts = prompt_store.load_prompts()
                if category not in prompts or name not in prompts[category]:
                    return server.web.json_response({"success": False, "error": "Prompt not found"})
                record = prompts[category][name]
                prompt_store.delete_thumbnail(record.get("id"))
                record.pop("hasThumb", None)
                now = _modified_at(record)
                record["dateAdded"] = record.get("dateAdded") or now
                record["dateModified"] = now
                record["thumbnailVersion"] = uuid.uuid4().hex
                prompt_store.save_prompts(prompts)
                return server.web.json_response({"success": True, "id": record.get("id"), "dateModified": now, "thumbnailVersion": record["thumbnailVersion"]})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in remove_thumbnail API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("post", "/copy-thumbnail", store=prompt_store)
    async def copy_thumbnail(request, prompt_store=prompt_store):
        """Copy an id-keyed thumbnail from one record to another."""
        try:
            data = await request.json()
            # The library's read-modify-save in one transaction (no await inside), so a
            # bundle import or another thread's write can't land in between and be lost.
            with db.write():
                source_id = (data.get("source_id") or "").strip()
                category = prompt_store._normalize_category_name(data.get("category", ""))
                name = data.get("name", "").strip()
                if not source_id or not category or not name:
                    return server.web.json_response({"success": False, "error": "Source and target required"})

                prompts = prompt_store.load_prompts()
                if category not in prompts or name not in prompts[category]:
                    return server.web.json_response({"success": False, "error": "Prompt not found"})

                sources = prompt_store.find_thumbnail_paths(source_id)
                if not sources:
                    return server.web.json_response({"success": False, "error": "Source thumbnail not found"})

                record = prompts[category][name]
                record_id = record.get("id") or uuid.uuid4().hex
                record["id"] = record_id
                prompt_store.delete_thumbnail(record_id)
                for src in sources:
                    dest = prompt_store.get_thumbnail_path(record_id, os.path.splitext(src)[1].lower())
                    os.makedirs(os.path.dirname(dest), exist_ok=True)
                    shutil.copyfile(src, dest)
                record["hasThumb"] = True
                now = _modified_at(record)
                record["dateAdded"] = record.get("dateAdded") or now
                record["dateModified"] = now
                record["thumbnailVersion"] = uuid.uuid4().hex
                prompt_store.save_prompts(prompts)
                return server.web.json_response({"success": True, "id": record_id, "prompts": prompt_store.prompts_for_response(prompts)})
        except Exception as e:
            print(f"[KRC Prompt Vault] Error in copy_thumbnail API: {e}")
            return server.web.json_response({"success": False, "error": str(e)}, status=500)

    @prompt_vault_route("get", "/thumbnail", store=prompt_store)
    async def get_thumbnail(request, prompt_store=prompt_store):
        """Serve an id-keyed thumbnail variant. The card URL carries the record's version
        (?v=thumbnailVersion), so a versioned request is cached for good; FileResponse streams
        the file and answers conditional requests itself."""
        record_id = os.path.basename(request.query.get("id", ""))
        if not record_id:
            return server.web.Response(status=400, text="Missing id")
        try:
            sized = parse_width(request.query) is not None
        except ValueError as exc:
            return server.web.Response(status=400, text=str(exc))
        # ?w= (outside apps) always serves the static poster, scaled down.
        kind = "poster" if sized else request.query.get("kind", "")
        path = prompt_store.find_thumbnail_variant(record_id, kind)
        if not path:
            return server.web.Response(status=204)
        path = str(await thumbnail_to_serve(path, request.query))
        headers = thumbnail_cache_headers(request.query)
        headers["Content-Type"] = "video/webm" if os.path.splitext(path)[1].lower() == ".webm" else "image/webp"
        return server.web.FileResponse(path, headers=headers)


