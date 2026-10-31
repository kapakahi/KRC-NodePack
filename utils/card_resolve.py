"""Card resolving shared by the public API (krc_public_api.py) and the Loadout Kit:
Model Library / Prompt Vault ids -> the real thing, plus Model Library id
canonicalization. Behaviour is the public API's contract (KRC_PUBLIC_API.md)."""

import asyncio


def canonical_id(library_id):
    """The current id for a Model Library id (follows stabilization / re-ids)."""
    from .model_library.identity import IdentityStore

    return IdentityStore().canonical_id(library_id)


def canonical_ids(ids):
    """:func:`canonical_id` for many ids at once (one identity-file read), in order."""
    from .model_library.identity import IdentityStore

    identities = IdentityStore()
    return [identities.canonical_id(library_id) for library_id in ids]


def _resolve(index, ids, default_type=""):
    index.heal(ids)
    out = {}
    for library_id in ids:
        record = index.get(library_id)
        if index._dead(record):
            out[library_id] = {"error": "unavailable" if record and record.get("unavailable") else "not found"}
        else:
            out[library_id] = {"path": record.get("path") or "", "modelType": record.get("modelType") or default_type}
    return out


def _clean_ids(ids):
    return [library_id for library_id in dict.fromkeys(str(item or "").strip() for item in ids or []) if library_id]


def _resolve_split(models, loras, ids):
    """Each id goes to the index that knows it (LoRAs live in LoRA Loadout's index, every
    other folder in the Model Library's), so a LoRA id never makes the model index heal."""
    lora_ids = [library_id for library_id in ids if models.get(library_id) is None and loras.get(library_id) is not None]
    lora_set = set(lora_ids)
    out = _resolve(models, [library_id for library_id in ids if library_id not in lora_set])
    if lora_ids:
        out.update(_resolve(loras, lora_ids, default_type="lora"))
    return {library_id: out[library_id] for library_id in ids}


def resolve_models(ids):
    """Model Library ids (any folder, LoRAs included) -> {id: {"path", "modelType"} |
    {"error": "unavailable" | "not found"}}. Moved or renamed files are healed first
    (run-time path check, no full rescan unless a file is gone). For node execution and
    IS_CHANGED."""
    from .lora_loadout.library_index import LoraLibraryIndex
    from .model_library.library_index import ModelLibraryIndex

    clean = _clean_ids(ids)
    if not clean:
        return {}
    models = ModelLibraryIndex()
    models.refresh(check_folders=False)
    loras = LoraLibraryIndex()
    loras.refresh(check_folders=False)
    return _resolve_split(models, loras, clean)


async def resolve_models_async(ids):
    """:func:`resolve_models` for async route handlers: a cold cache loads off the event
    loop."""
    from .lora_loadout.library_index import LoraLibraryIndex
    from .model_library.library_index import ModelLibraryIndex

    clean = _clean_ids(ids)
    if not clean:
        return {}
    models, loras = await ModelLibraryIndex.loaded(), await LoraLibraryIndex.loaded()
    # Healing may stat slow/offline drives or rescan moved files, even with warm indexes.
    return await asyncio.to_thread(_resolve_split, models, loras, clean)


def _prompt_card(category, name, record):
    prompt_a = str(record.get("prompt") or "")
    prompt_b = str(record.get("promptB") or "")
    append_b = bool(record.get("appendPromptB"))
    # The text a Prompt Vault node emits for this card: Prompt A, plus Prompt B after a
    # blank line when "append B" is on (krc_prompt_vault.get_prompt does the same).
    text = "\n\n".join(part for part in (prompt_a, prompt_b) if part) if append_b and prompt_b else prompt_a
    return {
        "name": name,
        "category": category,
        "text": text,
        "promptA": prompt_a,
        "promptB": prompt_b,
        "appendPromptB": append_b,
        "llPreset": str(record.get("ll_preset") or ""),
        "nsfw": bool(record.get("nsfw")),
    }


def resolve_prompts(ids):
    """Prompt Vault card ids -> {id: {"name", "category", "text", "promptA", "promptB",
    "appendPromptB", "llPreset", "nsfw"} | {"error": "not found"}}. ``text`` is what a
    Prompt Vault node would emit for the card. Ids are stable across renames and moves
    between categories. For node execution and IS_CHANGED."""
    from .prompt_vault_store import prompts_by_ids

    clean = _clean_ids(ids)
    if not clean:
        return {}
    _revision, matches = prompts_by_ids(clean)
    # Retain the sorted library's last match for legacy copies of one id (Unassigned
    # first, then case-insensitive category/name), without loading unrelated prompts.
    found = {record_id: _prompt_card(*max(locations, key=lambda item: (
        item[0] != "Unassigned", item[0].lower(), item[1].lower()))) for record_id, locations in matches.items()}
    return {prompt_id: found.get(prompt_id) or {"error": "not found"} for prompt_id in clean}


async def resolve_prompts_async(ids):
    """:func:`resolve_prompts` for async route handlers (the prompt file is read off the
    event loop)."""
    return await asyncio.to_thread(resolve_prompts, ids)
