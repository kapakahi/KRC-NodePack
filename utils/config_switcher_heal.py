"""Config Switcher references that follow their source (PATH_HEALING_GAMEPLAN.md step 4,
CS_LIVE_PROMPTS_GAMEPLAN.md step 1).

A model field outputs a relative path, but its option also stores the model's library id.
At run time the path is resolved from the id, so a model that moved (or was renamed and
re-found) keeps working, and the saved presets plus every open node are quietly pointed
at the new path. A path change for the same id is never a modification.

A prompt field works the same way with its Prompt Vault record id and the record's
current saved text.
"""

from .config_switcher_presets import ConfigSwitcherPresetStore
from .library.library_index import add_heal_listener, announce_moves


def rewrite_saved_presets(moves):
    """Heal listener: every move the libraries find (a run's heal, a browse rescan, this
    module's own resolution) rewrites the saved presets' paths for those ids."""
    return ConfigSwitcherPresetStore().rewrite_model_paths(moves)


add_heal_listener(rewrite_saved_presets)


def _indexes():
    # Lazy: the library packages pull in a lot, and a Config Switcher without model
    # fields never needs them.
    from .lora_loadout.library_index import LoraLibraryIndex
    from .model_library.library_index import ModelLibraryIndex
    return ModelLibraryIndex(), LoraLibraryIndex()


def _selected_ids(fields, values):
    """{library id: [(field id, current value)]} for model fields whose selected option
    carries an id. A hand-typed option (no id) is left alone."""
    wanted = {}
    for field in fields or []:
        if not isinstance(field, dict) or field.get("type") != "model":
            continue
        value = values.get(field.get("id"))
        if not value:
            continue
        for option in field.get("modelOptions") or []:
            if isinstance(option, dict) and option.get("value") == value:
                library_id = option.get("libraryId") or option.get("sha256")
                if library_id:
                    wanted.setdefault(library_id, []).append((field.get("id"), value))
                break
    return wanted


def resolve_model_values(fields, values, write_back=True):
    """The config's values with every id-backed model field pointing at the model's
    current path (healing a move). With write_back, a value that was out of date is also
    rewritten in the saved presets and pushed to open pages.
    -> (values, {library id: {"relativePath", "path"}} that changed)"""
    wanted = _selected_ids(fields, values)
    if not wanted:
        return values, {}
    resolved = dict(values)
    moves = {}
    pending = set(wanted)
    for index in _indexes():
        index.refresh(check_folders=False)
        ids = [library_id for library_id in pending if index.get(library_id) is not None]
        if not ids:
            continue
        index.heal(ids)
        found = {}
        for library_id in ids:
            pending.discard(library_id)
            record = index.get(library_id)
            if index._dead(record):
                print(f"[KRC Config Switcher] model file not found for id {library_id}; "
                      f"passing the stored path through")
                continue
            new_value = record.get("relative_path") or ""
            for field_id, value in wanted[library_id]:
                if new_value and new_value != value:
                    resolved[field_id] = new_value
                    found[library_id] = {"relativePath": new_value, "path": record.get("path") or ""}
        if found and write_back:
            # Rewrites the saved presets (the listener above) and tells open pages.
            announce_moves(index, found)
        moves.update(found)
    if moves:
        print(f"[KRC Config Switcher] using the current path for {len(moves)} moved model(s)")
    return resolved, moves


# ── Live prompt text (CS_LIVE_PROMPTS_GAMEPLAN.md step 1) ─────────────────────────────
# A prompt field outputs text, but its option also stores the Prompt Vault record id. At
# run time the text is read from the record, so an edit saved in Prompt Vault reaches the
# output without a Refresh. A text change for the same id is never a modification.

PROMPT_TEXTS_EVENT = "krc-config-switcher-prompt-texts"


def prompt_record_text(record):
    """The text the Prompt Vault node emits for a saved record: Prompt A, plus Prompt B
    after a blank line when APPEND is on (krc_prompt_vault.get_prompt; the browser's
    promptEmittedText mirrors it)."""
    prompt_a = str(record.get("prompt") or "")
    prompt_b = str(record.get("promptB") or "")
    if record.get("appendPromptB") and prompt_b:
        return "\n\n".join(part for part in (prompt_a, prompt_b) if part)
    return prompt_a


def _load_prompt_library():
    # Lazy: a Config Switcher without prompt fields never reads the Prompt Vault store.
    from .prompt_vault_store import load_prompts
    return load_prompts()


def _find_prompt_record(prompts, by_id, option):
    record_id = str(option.get("id") or "")
    if record_id and record_id in by_id:
        return by_id[record_id]
    if record_id:
        return None
    bucket = prompts.get(str(option.get("category") or ""))
    record = bucket.get(str(option.get("name") or "")) if isinstance(bucket, dict) else None
    return record if isinstance(record, dict) else None


def _records_by_id(prompts):
    by_id = {}
    for category, bucket in (prompts or {}).items():
        if not isinstance(bucket, dict):
            continue
        for name, record in bucket.items():
            if name != "__meta__" and isinstance(record, dict) and record.get("id"):
                by_id[str(record["id"])] = record
    return by_id


def announce_prompt_texts(texts):
    """Tell every open page which prompt texts changed ({record id: text}); Config
    Switcher nodes take them without becoming modified. No-op off the ComfyUI runtime."""
    if not texts:
        return
    try:
        from server import PromptServer
        PromptServer.instance.send_sync(PROMPT_TEXTS_EVENT, {"texts": texts})
    except Exception:  # noqa: BLE001 — a missed push only means the page catches up later
        pass


def resolve_prompt_values(fields, values, write_back=True):
    """The config's values with every Prompt Vault-backed prompt field holding the record's
    current saved text. With write_back, a text that was out of date is also rewritten in
    the saved presets and pushed to open pages.
    -> (values, {record id: text} that changed)"""
    selected = []
    for field in fields or []:
        if not isinstance(field, dict) or field.get("type") != "prompt":
            continue
        value = values.get(field.get("id"))
        if not value:
            continue
        for option in field.get("promptOptions") or []:
            if isinstance(option, dict) and option.get("value") == value:
                # A hand-typed option has neither an id nor a category + name: left alone.
                if option.get("id") or (option.get("category") and option.get("name")):
                    selected.append((field.get("id"), value, option))
                break
    if not selected:
        return values, {}
    prompts = _load_prompt_library()
    by_id = _records_by_id(prompts)
    # Browsing remains scoped, but a workflow may reference another profile's prompt.
    missing_ids = {str(option.get("id")) for _field, _value, option in selected
                   if option.get("id") and str(option["id"]) not in by_id}
    if missing_ids:
        from .prompt_vault_store import prompts_by_ids

        _revision, matches = prompts_by_ids(missing_ids)
        by_id.update({record_id: locations[-1][2] for record_id, locations in matches.items()})
    resolved = dict(values)
    texts = {}
    for field_id, value, option in selected:
        record = _find_prompt_record(prompts, by_id, option)
        if record is None:
            print(f"[KRC Config Switcher] prompt {option.get('id') or option.get('name')} not found; "
                  f"using the stored text")
            continue
        # An emptied prompt emits "" too (a missing record keeps the stored text, above).
        text = prompt_record_text(record)
        if text != value:
            resolved[field_id] = text
            texts[str(record.get("id") or "")] = text
    texts.pop("", None)
    if texts and write_back:
        ConfigSwitcherPresetStore().rewrite_prompt_texts(texts)
        announce_prompt_texts(texts)
    if texts:
        print(f"[KRC Config Switcher] using the current text for {len(texts)} edited prompt(s)")
    return resolved, texts
