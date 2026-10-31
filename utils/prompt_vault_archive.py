"""Prompt Vault's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md): "prompt_vault" —
categories, prompts, their thumbnails and usage.

Export writes into a section folder (all categories or a chosen few, plus the presets the
prompts link to for Include linked presets); import is a two-phase plan
(utils/bundle/sections.py). Imported records are cleaned to a normal save's shapes.
"""
import json
import os
import time
import uuid

from .archive_guard import ArchiveGuardError, read_json_entry
from .bundle.sections import ImportPlan, Section, plan_summary
from .library.archive import merge_empty_fields, thumbnail_member_ok
from .library.card_colors import CARD_COLOR_IDS
from .library.usage_stats import load_usage_section, set_usage
from .custom_badge import normalize_custom_badge
from .prompt_vault_store import normalize_category_name, normalize_kit_presets, prompt_usage_by_key, set_prompt_usage, prompt_owners
from .prompt_profile_transfer import export_store, plan_profile_section, announce_profiles
from .db import connection as db


PROMPTS_ARCHIVE_NAME = "prompts.json"
# Optional: {record id: {"count", "lastUsedMs"}}, keyed by the stable record id so it
# follows the prompt to its new home. Bundles without it import fine (usage is left alone).
USAGE_ARCHIVE_NAME = "usage.json"
USAGE_SECTION = "prompts"
THUMBNAILS_ARCHIVE_DIR = "thumbnails"
ANIMATED_THUMBNAILS_ARCHIVE_DIR = "animated_thumbnails"
# Only these thumbnail types are accepted out of a bundle's thumbnail dir — don't
# let an archive drop an arbitrary-typed file into the thumbnail folder.
THUMBNAIL_IMPORT_EXTENSIONS = (".webp", ".webm")

# What an imported prompt may hold (a bundle is someone else's file): each field in the
# shape a normal save gives it, text within these lengths. A record or category name over
# its limit is skipped (stats "skipped"), never cut.
MAX_PROMPT_TEXT = 200_000   # prompt, prompt B
MAX_NOTE_TEXT = 20_000      # notes, find / replace
MAX_SHORT_TEXT = 1_024      # model, a preset id or label, a date
MAX_NAME_TEXT = 256         # a category or prompt name
_LONG_FIELDS = {"prompt": MAX_PROMPT_TEXT, "promptB": MAX_PROMPT_TEXT, "notes": MAX_NOTE_TEXT,
                "replaceFind": MAX_NOTE_TEXT, "replaceWith": MAX_NOTE_TEXT, "model": MAX_SHORT_TEXT,
                "ll_preset": MAX_SHORT_TEXT, "ll_preset_label": MAX_SHORT_TEXT}


def _as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _write_archive_thumbnails(prompt_store, archive, prompts):
    seen = set()
    for cat_data in prompts.values():
        if not isinstance(cat_data, dict):
            continue
        for name, entry in cat_data.items():
            if name == "__meta__" or not isinstance(entry, dict):
                continue
            record_id = entry.get("id")
            if record_id and record_id not in seen:
                seen.add(record_id)
                for src in prompt_store.find_thumbnail_paths(record_id):
                    archive_dir = ANIMATED_THUMBNAILS_ARCHIVE_DIR if os.path.splitext(src)[1].lower() == ".webm" else THUMBNAILS_ARCHIVE_DIR
                    archive.write(src, f"{archive_dir}/{os.path.basename(src)}")


def _write_prompts(prompt_store, archive, prompts):
    archive.writestr(PROMPTS_ARCHIVE_NAME, json.dumps(prompts, indent=2, ensure_ascii=False))
    archive.writestr(USAGE_ARCHIVE_NAME, json.dumps(_usage_by_record_id(prompts, getattr(prompt_store, "profile_id", "default")), indent=2, ensure_ascii=False))
    _write_archive_thumbnails(prompt_store, archive, prompts)


def _prompt_records(prompts):
    for cat_data in prompts.values():
        if isinstance(cat_data, dict):
            for name, entry in cat_data.items():
                if name != "__meta__" and isinstance(entry, dict):
                    yield entry


def _linked_presets(prompts):
    """{section id: [preset ids]} the prompts link to: LoRA Loadout presets and each
    Loadout Kit's presets (for the bundle's Include linked presets)."""
    links = {}

    def add(section_id, preset_id):
        preset_id = str(preset_id or "").strip()
        if preset_id and not preset_id.startswith("none:"):  # none:empty is never stored
            links.setdefault(section_id, set()).add(preset_id)

    for entry in _prompt_records(prompts):
        add("lora_presets", entry.get("ll_preset"))
        for kit_id, link in normalize_kit_presets(entry.get("kitPresets")).items():
            add(f"kit_presets/{kit_id}", link.get("id"))
    return {section_id: sorted(ids) for section_id, ids in links.items()}


def write_vault_section(prompt_store, archive, selection=None):
    """Prompt Vault into ``archive`` (a bundle's SectionArchive): every category, or
    ``{"categories": [...]}``, with their thumbnails and usage. -> {"counts", "links"}."""
    prompt_store = export_store(prompt_store, archive, selection)
    prompts = prompt_store.load_prompts()
    wanted = (selection or {}).get("categories")
    if wanted is not None:
        wanted = {str(name) for name in wanted}
        prompts = {category: data for category, data in prompts.items() if category in wanted}
    _write_prompts(prompt_store, archive, prompts)
    return {
        "counts": {"categories": len(prompts), "prompts": sum(1 for _ in _prompt_records(prompts))},
        "links": _linked_presets(prompts),
    }


def vault_choices(archive):
    """The category names a bundle's Prompt Vault holds, in its order (the Import dialog's
    picker; the values plan_vault_section's selection matches)."""
    if PROMPTS_ARCHIVE_NAME not in archive.namelist():
        return []
    manifest = read_json_entry(archive, PROMPTS_ARCHIVE_NAME)
    if not isinstance(manifest, dict):
        raise ArchiveGuardError("prompt_vault/prompts.json is invalid")
    names = (_clean_name(raw, category=True) for raw, bucket in manifest.items() if isinstance(bucket, dict))
    return list(dict.fromkeys(name for name in names if name))


def bundle_sections(prompt_store):
    """This node's KRC bundle section (registered by prompt_vault_routes.py)."""
    return [Section("prompt_vault", "Prompt Vault",
                    lambda: sum(1 for _ in _prompt_records(prompt_store.load_prompts())),
                    lambda archive, selection=None: write_vault_section(prompt_store, archive, selection),
                    lambda archive, mode, options, stager: plan_profile_section(prompt_store, archive, mode, options, stager, plan_vault_section),
                    slices=(("usage", "domain = 'prompts' AND item_id IN (SELECT id FROM main.prompts WHERE profile_id = 'default' UNION SELECT id FROM snap.prompts WHERE profile_id = 'default')"),
                            ("prompt_categories", "profile_id = 'default'"), ("prompts", "profile_id = 'default'")),
                    stores=(("prompts", None), ("usage", "prompts"), ("prompt_profiles", None)), refresh=announce_profiles,
                    choices=vault_choices)]


def _usage_by_record_id(prompts, profile_id="default"):
    """The ledger's entries for these prompts, re-keyed from category/name to record id."""
    ledger = load_usage_section(USAGE_SECTION) if profile_id == "default" else prompt_usage_by_key(profile_id)
    usage = {}
    for category, cat_data in prompts.items():
        if not isinstance(cat_data, dict):
            continue
        for name, entry in cat_data.items():
            if name == "__meta__" or not isinstance(entry, dict) or not entry.get("id"):
                continue
            stats = ledger.get(f"{category}/{name}")
            if isinstance(stats, dict) and (stats.get("count") or stats.get("lastUsedMs")):
                usage[entry["id"]] = {
                    "count": _as_int(stats.get("count"), 0),
                    "lastUsedMs": _as_int(stats.get("lastUsedMs"), 0),
                }
    return usage


def _read_archive_usage(archive):
    """The bundle's usage.json as {safe record id: entry}, or None when it has none
    (an older bundle) or it's unreadable."""
    if USAGE_ARCHIVE_NAME not in archive.namelist():
        return None
    try:
        raw = read_json_entry(archive, USAGE_ARCHIVE_NAME)
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    return {
        _safe_record_id(record_id): entry
        for record_id, entry in raw.items()
        if _safe_record_id(record_id) and isinstance(entry, dict)
    }


def _stamp():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _text(value):
    """A text field as a normal save stores it: a stripped string ("" for anything else)."""
    return value.strip() if isinstance(value, str) else ""


def _clean_name(value, category=False):
    """A category or prompt name from a bundle, or "" when it isn't one."""
    name = normalize_category_name(_text(value)) if category else _text(value)
    return name if name and len(name) <= MAX_NAME_TEXT and name != "__meta__" else ""


def _too_long(data):
    """Whether any text field of an imported record is over its limit."""
    return any(isinstance(data.get(key), str) and len(data[key]) > limit for key, limit in _LONG_FIELDS.items())


def _clean_meta(meta):
    """A category's __meta__ from a bundle: only the flags and colour the UI sets."""
    if not isinstance(meta, dict):
        return None
    clean = {}
    if meta.get("nsfw"):
        clean["nsfw"] = True
    if meta.get("pinned"):
        clean["pinned"] = True
    if _text(meta.get("cardColor")) in CARD_COLOR_IDS:
        clean["cardColor"] = _text(meta.get("cardColor"))
    return clean or None


def _date(value, fallback):
    """A bundle date kept when it's a plain timestamp (ISO string or epoch number)."""
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)) or (isinstance(value, str) and 0 < len(value) <= 64):
        return value
    return fallback


def _archive_thumbnails(names):
    """{bundle record id: [(member name, extension)]} for the bundle's thumbnail files."""
    found = {}
    for name in names:
        if name.endswith("/") or not (
            name.startswith(f"{THUMBNAILS_ARCHIVE_DIR}/")
            or name.startswith(f"{ANIMATED_THUMBNAILS_ARCHIVE_DIR}/")
        ):
            continue
        stem, extension = os.path.splitext(os.path.basename(name))
        extension = extension.lower()
        record_id = _safe_record_id(stem)
        if record_id and extension in THUMBNAIL_IMPORT_EXTENSIONS:
            found.setdefault(record_id, []).append((name, extension))
    return found


def _safe_record_id(record_id):
    """Keep only filesystem-safe characters so an imported id can't traverse
    out of the thumbnail directory. Mirrors KRCPromptVault.safe_record_id."""
    return "".join(
        char for char in str(record_id or "")
        if char.isalnum() or char in ("-", "_")
    )


def _thumb_fields(thumbs):
    """hasThumb / thumbType / thumbHasPoster for a record's thumbnail files once the import
    lands. ``thumbs`` = {".webp": bool, ".webm": bool}."""
    poster, loop = bool((thumbs or {}).get(".webp")), bool((thumbs or {}).get(".webm"))
    if not (poster or loop):
        return {}
    fields = {"hasThumb": True, "thumbType": "video" if loop else "image"}
    if loop and poster:
        fields["thumbHasPoster"] = True
    return fields


def _normalize_prompt_record(data, now, record_id, keep_history=True, thumbs=None):
    """One imported record in the store's shape. `record_id` is already filesystem-safe
    (bundle ids are attacker-controllable and end up in thumbnail paths). Without
    keep_history the record is dated now, as if just created. ``thumbs``: which of its
    thumbnail files will exist ({".webp": bool, ".webm": bool})."""
    added = _date(data.get("dateAdded"), now) if keep_history else now
    normalized = {
        "prompt": _text(data.get("prompt")),
        "dateAdded": added,
        "dateModified": _date(data.get("dateModified"), added) if keep_history else now,
        "id": record_id,
    }
    normalized.update(_thumb_fields(thumbs))

    if data.get("nsfw"):
        normalized["nsfw"] = True
    if data.get("favorite"):
        normalized["favorite"] = True
    rating = max(0, min(5, _as_int(data.get("rating"), 0)))
    if rating:
        normalized["rating"] = rating
    if data.get("pinned"):
        normalized["pinned"] = True
    if data.get("appendPromptB"):
        normalized["appendPromptB"] = True
    for key in ("ll_preset", "ll_preset_label"):
        if _text(data.get(key)):
            normalized[key] = _text(data.get(key))
    kit_presets = normalize_kit_presets(data.get("kitPresets"))
    if kit_presets:
        normalized["kitPresets"] = kit_presets
    for key in ("model", "notes", "promptB", "replaceFind", "replaceWith"):
        if _text(data.get(key)):
            normalized[key] = _text(data.get(key))
    if _text(data.get("cardColor")) in CARD_COLOR_IDS:
        normalized["cardColor"] = _text(data.get("cardColor"))
    custom_badge = normalize_custom_badge(data.get("customBadge", ""))
    if custom_badge:
        normalized["customBadge"] = custom_badge
    return normalized


def _merge_usage(local, incoming):
    """The larger count and the later last-used of two usage entries."""
    local = local if isinstance(local, dict) else {}
    return {"count": max(_as_int(local.get("count")), _as_int(incoming.get("count"))),
            "lastUsedMs": max(_as_int(local.get("lastUsedMs")), _as_int(incoming.get("lastUsedMs")))}


def plan_vault_section(prompt_store, archive, mode, options, stager):
    """Plan a "prompt_vault" import into the current library. merge adds new prompts and
    fills only empty fields of same-name ones (keeping their thumbnails); overwrite replaces
    same-name prompts with the bundle's. An existing prompt keeps its record id (so links
    to it survive); a new one takes the bundle's id when it's free here.

    Planning reads the library once, to choose ids and stage thumbnails and to count a
    preview. apply() runs inside the import's transaction and resolves every bundle prompt
    again against the library (and usage) as they are then, so a prompt saved, edited or
    deleted meanwhile is kept as it is now; it returns the counts it committed."""
    overwrite = mode == "overwrite"
    keep_history = options.get("history", True)
    manifest = read_json_entry(archive, PROMPTS_ARCHIVE_NAME) if PROMPTS_ARCHIVE_NAME in archive.namelist() else {}
    if not isinstance(manifest, dict):
        raise ArchiveGuardError("prompt_vault/prompts.json is invalid")
    # The Import dialog's category picker: only these of the bundle's categories (vault_choices names).
    wanted = (options.get("selection") or {}).get("categories")
    if wanted is not None:
        if not isinstance(wanted, list):
            raise ValueError("The category selection is invalid")
        wanted = {str(name) for name in wanted}
    thumbs = _archive_thumbnails(archive.namelist())
    bundle_usage = _read_archive_usage(archive) if keep_history else None
    snapshot = prompt_store.load_prompts()
    profiled = options.get("_profileImport", False)
    replacing = options.get("_replaceProfile", False)
    profile_id = getattr(prompt_store, "profile_id", "default")
    planning = {} if replacing else snapshot
    used_ids = {str(entry.get("id")) for entry in _prompt_records(snapshot) if entry.get("id")}
    used_ids.update(row[0] for row in db.connection().execute("SELECT id FROM prompts"))
    foreign_ids = {row[0] for row in db.connection().execute("SELECT id FROM prompts WHERE profile_id != ?", (profile_id,))}
    reusable_ids = {str(record.get("id")) for record in _prompt_records(snapshot)} - foreign_ids if replacing else set()
    planned_targets = set()
    category_names = {key.casefold(): key for key in planning}
    local_by_id = {str(record.get("id")): (cat, name) for cat, bucket in planning.items() if isinstance(bucket, dict)
                   for name, record in bucket.items() if name != "__meta__" and isinstance(record, dict) and record.get("id")}
    now = _stamp()
    metas = []    # (category, meta)
    entries = []  # (category, name, incoming record, thumbnail files, record id, bundle id)
    categories = set()
    invalid = 0

    for raw_category, cat_prompts in manifest.items():
        category = _clean_name(raw_category, category=True)
        if not category or not isinstance(cat_prompts, dict):
            invalid += 1
            continue
        if wanted is not None and category not in wanted:
            continue
        if profiled:
            category = category_names.setdefault(category.casefold(), category)
        planned = planning.get(category) if isinstance(planning.get(category), dict) else {}
        categories.add(category)
        for raw_name, pdata in cat_prompts.items():
            if raw_name == "__meta__":
                meta = _clean_meta(pdata)
                if meta:
                    metas.append((category, meta))
                continue
            name = _clean_name(raw_name)
            if not name or not isinstance(pdata, dict) or _too_long(pdata):
                invalid += 1
                continue
            bundle_id = _safe_record_id(pdata.get("id"))
            target_category = category
            if profiled and bundle_id in local_by_id:
                target_category, name = local_by_id[bundle_id]
            target_bucket = planning.get(target_category, {}) if profiled else planned
            if profiled:
                name = next((key for key in target_bucket if key.casefold() == name.casefold() and key != "__meta__"), name)
            if profiled:
                target_key = (target_category.casefold(), name.casefold())
                if target_key in planned_targets:
                    invalid += 1
                    continue
                planned_targets.add(target_key)
            local = target_bucket.get(name) if isinstance(target_bucket.get(name), dict) else None
            if local:
                record_id = _safe_record_id(local.get("id")) or uuid.uuid4().hex
            else:
                record_id = bundle_id if bundle_id and (bundle_id not in used_ids or bundle_id in reusable_ids) else uuid.uuid4().hex
                used_ids.add(record_id)
                reusable_ids.discard(record_id)

            members = [(member, ext) for member, ext in thumbs.get(bundle_id, []) if thumbnail_member_ok(archive, member, ext)]
            take_thumbs = bool(members) and (overwrite or not local or not prompt_store.find_thumbnail_path(record_id))
            if record_id in foreign_ids:
                take_thumbs = False
            if replacing:
                for path in prompt_store.find_thumbnail_paths(record_id):
                    stager.remove(path)
            if take_thumbs:
                for path in prompt_store.find_thumbnail_paths(record_id):
                    stager.remove(path)
                for member, ext in members:
                    stager.stage(archive, member, prompt_store.get_thumbnail_path(record_id, ext))
            files = {ext: stager.will_exist(prompt_store.get_thumbnail_path(record_id, ext)) for ext in THUMBNAIL_IMPORT_EXTENSIONS}
            normalized = _normalize_prompt_record(pdata, now, record_id, keep_history, files)
            if profiled and take_thumbs:
                normalized["thumbnailVersion"] = uuid.uuid4().hex
            entries.append((target_category, name, normalized, files, record_id, bundle_id))

    if replacing and invalid:
        raise ArchiveGuardError("Cannot replace a profile from a bundle with invalid or duplicate prompt entries. Use Merge or correct the bundle.")

    def resolve(prompts, ledger):
        """Apply the bundle to ``prompts`` (in place). -> (added, updated, unchanged, usage writes)."""
        added = updated = unchanged = 0
        usage_writes = {}
        if profiled:
            for category in categories:
                prompts.setdefault(category, {})
        for category, meta in metas:
            bucket = prompts.setdefault(category, {})
            local_meta = bucket.get("__meta__") if isinstance(bucket.get("__meta__"), dict) else {}
            bucket["__meta__"] = meta if overwrite else merge_empty_fields(local_meta, meta)
        for category, name, incoming, files, record_id, bundle_id in entries:
            bucket = prompts.setdefault(category, {})
            local = bucket.get(name) if isinstance(bucket.get(name), dict) else None
            if not local:
                bucket[name] = incoming
                added += 1
            elif overwrite:
                bucket[name] = incoming
                updated += 1
            else:
                merged = merge_empty_fields(local, incoming)
                merged["id"] = local.get("id") or record_id
                if merged["id"] == record_id:
                    # Thumbnails were staged for this id; another id keeps its own.
                    for field in ("hasThumb", "thumbType", "thumbHasPoster"):
                        merged.pop(field, None)
                    merged.update(_thumb_fields(files))
                    if incoming.get("thumbnailVersion"):
                        merged["thumbnailVersion"] = incoming["thumbnailVersion"]
                bucket[name] = merged
                if merged != local:
                    updated += 1
                else:
                    unchanged += 1

            key = f"{category}/{name}"
            if keep_history and bundle_usage is not None:
                entry = bundle_usage.get(bundle_id) if bundle_id else None
                if overwrite or not local:
                    usage_writes[key] = entry  # None clears: the bundle's history replaces it
                elif entry:
                    usage_writes[key] = _merge_usage(ledger.get(key), entry)
            elif (not keep_history or replacing) and (overwrite or not local):
                usage_writes[key] = None
        return added, updated, unchanged, usage_writes

    def ledger():
        return prompt_usage_by_key(profile_id) if profiled else load_usage_section(USAGE_SECTION)

    added, updated, unchanged, _usage = resolve(_copy_library(planning), ledger() if not (profiled and not snapshot) else {})
    if replacing:
        incoming_ids = {record_id for _, _, _, _, record_id, _ in entries}
        old_ids = {record.get("id") for record in _prompt_records(snapshot)} - incoming_ids
        owners = prompt_owners(old_ids)
        for record_id in old_ids:
            if any(owner["profileId"] != profile_id for owner in owners.get(record_id, [])):
                continue
            for path in prompt_store.find_thumbnail_paths(record_id):
                stager.remove(path)

    def apply():
        if profiled:
            now_foreign = {row[0] for row in db.connection().execute("SELECT id FROM prompts WHERE profile_id != ?", (profile_id,))}
            if any(record_id in now_foreign - foreign_ids for _, _, _, _, record_id, _ in entries):
                raise ValueError("Prompt identities changed during import. Preview and import again.")
        prompts = {} if replacing else prompt_store.load_prompts()
        added_now, updated_now, _unchanged, usage_writes = resolve(prompts, ledger())
        prompt_store.save_prompts(prompts, source="import")
        if profiled:
            set_prompt_usage(usage_writes, profile_id=profile_id)
        else:
            set_usage(USAGE_SECTION, usage_writes)
        return {"categories": len(categories), "prompts": added_now + updated_now}

    def after():
        prompt_store.gc_orphan_thumbnails(prompt_store.load_prompts())

    summary = plan_summary(added, updated, unchanged, {"invalid name or text": invalid})
    if replacing:
        summary["removed"] = sum(1 for record in _prompt_records(snapshot) if record.get("id") not in incoming_ids)
    return ImportPlan(summary, apply, after)


def _copy_library(prompts):
    """A copy deep enough for resolve() to change without touching ``prompts``."""
    return {category: dict(bucket) if isinstance(bucket, dict) else bucket for category, bucket in prompts.items()}
