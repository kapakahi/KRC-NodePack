"""
ComfyUI Prompt Vault Advanced - Prompt management with a browser, thumbnails, and NSFW filtering.
"""
import server  # ComfyUI PromptServer — used for the per-run usage on_prompt hook
from ..utils.library.usage_stats import bump_usage
from ..utils.lora_loadout.presets import PresetStore
import json
import re

from ..utils.loadout_kit.kit import get_kit
from ..utils.loadout_kit.presets import KitPresetStore
from ..utils.preset_link import (
    LORA_TARGET,
    MISSING_CLEAR,
    MISSING_KEEP,
    PRESET_LINK_TYPE,
    build_link,
    link_signature,
    stored_target_id,
)

_KIT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
from ..utils.prompt_vault_routes import register_prompt_vault_routes
from ..utils.prompt_vault_serialization import prompts_for_response
from ..utils.prompt_vault_store import (
    UNASSIGNED_CATEGORY,
    ensure_ids,
    get_prompts_path,
    load_prompts,
    merge_category_data,
    normalize_categories,
    normalize_category_name,
    save_prompts,
    sort_prompts_data,
)
from ..utils.prompt_vault_thumbnails import (
    THUMB_EXTENSION,
    THUMB_EXTENSIONS,
    THUMB_SIZE,
    THUMB_WEBP_QUALITY,
    decode_data_url,
    delete_thumbnail,
    find_thumbnail_path,
    find_thumbnail_paths,
    find_thumbnail_variant,
    gc_orphan_thumbnails,
    get_thumbnail_path,
    get_thumbnails_dir,
    safe_record_id,
    save_thumbnail_bytes,
)




class KRCPromptVault:
    """
    Advanced Prompt Vault.
    Saves and loads prompts by category with a prompt browser, thumbnails, and NSFW filtering.
    """

    @classmethod
    def INPUT_TYPES(s):
        prompts_data = KRCPromptVault.load_prompts()
        categories = list(prompts_data.keys()) if prompts_data else [UNASSIGNED_CATEGORY]

        all_prompts = set()
        for category_prompts in prompts_data.values():
            all_prompts.update(k for k in category_prompts.keys() if k != "__meta__")

        all_prompts.add("")
        all_prompts_list = sorted(list(all_prompts))

        first_category = categories[0] if categories else UNASSIGNED_CATEGORY

        # Keep new node instances empty until the user explicitly selects a prompt.
        first_prompt = ""
        first_prompt_text = ""

        return {
            "required": {
                "category": (categories, {"default": first_category}),
                "name": (all_prompts_list, {"default": first_prompt}),
                "text": ("STRING", {
                    "multiline": True,
                    "default": first_prompt_text,
                    "placeholder": "Enter prompt text",
                    "dynamicPrompts": False,
                    "tooltip": "Prompt A text emitted by the node unless Prompt B append changes the final output."
                }),
                "ll_preset": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "placeholder": "LL preset id (saved with the prompt)",
                    "dynamicPrompts": False,
                    "tooltip": "Optional LoRA Loadout preset id saved with the prompt and sent on the 'preset' link."
                }),
                "prompt_b": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "placeholder": "Secondary prompt text",
                    "dynamicPrompts": False,
                    "tooltip": "Optional Prompt B text; can be appended after Prompt A."
                }),
                "append_prompt_b": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Append Prompt B after Prompt A, separated by a newline."
                }),
                "replace_find": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "placeholder": "Find whole word",
                    "dynamicPrompts": False,
                    "tooltip": "Whole-word, case-sensitive text to find in Prompt A. Enable Prompt B replacement in Prompt Vault options."
                }),
                "replace_with": ("STRING", {
                    "multiline": False,
                    "default": "",
                    "placeholder": "Replace with",
                    "dynamicPrompts": False,
                    "tooltip": "Text that replaces each whole-word match when REPLACE is used."
                }),
                "replace_prompt_b": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Include Prompt B during Find/Replace."
                }),
                "clear_lora_when_missing": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "When a linked LoRA Loadout preset (or a kit row's preset, e.g. "
                               "RefMod) is missing, the loadout clears its stacks instead of "
                               "keeping them. Off by default."
                }),
                "prompt_input_enabled": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Allow the optional prompt input connector to overwrite Prompt A or B on run."
                }),
                "prompt_input_target": (["A", "B"], {
                    "default": "A",
                    "tooltip": "Prompt box overwritten by the optional prompt input connector."
                }),
                "prompt_input_disable_on_swap": ("BOOLEAN", {
                    "default": False,
                    "tooltip": "Disable prompt input when swapping Prompt A and Prompt B."
                }),
                "prompt_input_rejected": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "dynamicPrompts": False,
                    "tooltip": "Internal state: connector text ignored after discarding Prompt Input changes."
                }),
                "prompt_input_rejected_target": (["A", "B"], {
                    "default": "A",
                    "tooltip": "Internal state: Prompt Input target for the ignored connector text."
                }),
                "kit_presets": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "dynamicPrompts": False,
                    "tooltip": "Internal state: the Loadout Kit preset ids (e.g. RefMod) of the rows "
                               "switched on, as JSON {kit id: preset id}. Sent on the preset link."
                }),
            },
            "optional": {
                "prompt_input": ("STRING", {
                    "forceInput": True,
                    "default": "",
                    "tooltip": "Optional text connector that can overwrite Prompt A or B when INPUT is enabled."
                }),
                "thumbnail_image": ("IMAGE", {"tooltip": "Optional image input used as the selected prompt's thumbnail when saved from Prompt Vault."}),
                # Hidden. The record id of the saved prompt this node was loaded from ("" for a
                # node-local draft), so an API-format export says which prompt it is even after
                # an unsaved rename (category / name are the node's current values). The run and
                # IS_CHANGED ignore it. KRC_EXTERNAL_API_GAMEPLAN.md stage 3.
                "prompt_id": ("STRING", {
                    "default": "",
                    "tooltip": "Internal state: the record id of the saved prompt this node was loaded from."
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            }
        }

    CATEGORY = "KRC NodePack"
    DESCRIPTION = (
        "Browse, edit, and organize saved prompts with categories, thumbnails, "
        "Prompt A/B, a preset output for LoRA Loadout and Loadout Kit nodes, and "
        "Find/Replace tools."
    )
    RETURN_TYPES = ("STRING", PRESET_LINK_TYPE)
    RETURN_NAMES = ("prompt", "preset")
    FUNCTION = "get_prompt"
    OUTPUT_NODE = True

    @classmethod
    def IS_CHANGED(cls, category, name, text="", ll_preset="", prompt_b="", append_prompt_b=False,
                   replace_find="", replace_with="", replace_prompt_b=False,
                   clear_lora_when_missing=False,
                   prompt_input_enabled=False, prompt_input_target="A", prompt_input="",
                   prompt_input_rejected="", prompt_input_rejected_target="A", kit_presets="", **kwargs):
        """
        Track changes to the node's inputs to determine if re-execution is needed.
        Returns a tuple of relevant values that should trigger re-execution when changed.
        """
        return (
            category,
            name,
            text,
            # Hash the link as sent, not the raw inputs: it carries each preset's rev, so
            # re-saving a linked preset re-runs the chain, and the missing policy.
            link_signature(cls._preset_link(category, name, ll_preset,
                                            clear_when_missing=bool(clear_lora_when_missing),
                                            kit_presets=kit_presets, prompt_id=kwargs.get("prompt_id", ""))),
            prompt_b,
            append_prompt_b,
            prompt_input_enabled,
            "B" if prompt_input_target == "B" else "A",
            prompt_input if prompt_input_enabled else "",
            prompt_input_rejected if prompt_input_enabled else "",
            "B" if prompt_input_rejected_target == "B" else "A",
        )

    @classmethod
    def VALIDATE_INPUTS(cls, name, category=None, **kwargs):
        """The DOM owns selection: names/categories can be unsaved or from any profile.

        Name both combo inputs explicitly so native validation never constrains them
        to INPUT_TYPES' legacy Default-profile suggestions.
        """
        return True

    # Prompt storage (krc.db) lives in utils.prompt_vault_store; these aliases keep
    # route/archive code on the existing KRCPromptVault method API.
    get_prompts_path = staticmethod(get_prompts_path)
    _ensure_ids = staticmethod(ensure_ids)
    _merge_category_data = staticmethod(merge_category_data)
    _normalize_categories = staticmethod(normalize_categories)
    _normalize_category_name = staticmethod(normalize_category_name)
    load_prompts = staticmethod(load_prompts)
    sort_prompts_data = staticmethod(sort_prompts_data)
    save_prompts = staticmethod(save_prompts)

    # Thumbnail storage lives in utils.prompt_vault_thumbnails; these aliases keep
    # archive helpers and route code on the existing KRCPromptVault method API.
    THUMB_SIZE = THUMB_SIZE
    THUMB_EXTENSION = THUMB_EXTENSION
    THUMB_EXTENSIONS = THUMB_EXTENSIONS
    THUMB_WEBP_QUALITY = THUMB_WEBP_QUALITY
    get_thumbnails_dir = staticmethod(get_thumbnails_dir)
    safe_record_id = staticmethod(safe_record_id)
    get_thumbnail_path = staticmethod(get_thumbnail_path)
    find_thumbnail_path = staticmethod(find_thumbnail_path)
    find_thumbnail_paths = staticmethod(find_thumbnail_paths)
    find_thumbnail_variant = staticmethod(find_thumbnail_variant)
    save_thumbnail_bytes = staticmethod(save_thumbnail_bytes)
    delete_thumbnail = staticmethod(delete_thumbnail)
    _decode_data_url = staticmethod(decode_data_url)
    gc_orphan_thumbnails = staticmethod(gc_orphan_thumbnails)
    prompts_for_response = staticmethod(prompts_for_response)

    @staticmethod
    def _link_entry(stored, find, what):
        """A stored preset reference -> its preset-link entry, or None for no link.

        ``stored`` is a record's ``ll_preset`` / a kit row's value: "" (no link), the
        ``none:empty`` sentinel (sent as id "") or a preset id. An id is sent as-is with
        the preset's ``modified`` as ``rev``; one that isn't found here keeps rev 0 and
        is still sent, so the loadout applies the link's missing policy."""
        preset_id = stored_target_id(stored)
        if not preset_id:
            return None if preset_id is None else {"id": "", "rev": 0}
        try:
            preset = find(preset_id)
        except Exception as e:
            print(f"[KRC Prompt Vault] Could not read {what} preset {preset_id}: {e}")
            preset = None
        return {"id": preset_id, "rev": (preset or {}).get("modified") or 0}

    @classmethod
    def _kit_link_entries(cls, kit_presets):
        """The kit entries of the preset link, from the node's ``kit_presets`` JSON
        (``{kit id: preset id}``, one key per row switched on, "" for --none--). A row
        set to --none-- has no entry; kits that aren't registered here are left out."""
        try:
            links = json.loads(kit_presets) if kit_presets else {}
        except (TypeError, ValueError):
            return {}
        if not isinstance(links, dict):
            return {}
        out = {}
        for kit_id, value in links.items():
            if not isinstance(kit_id, str) or not _KIT_ID_RE.match(kit_id) or get_kit(kit_id) is None:
                continue
            entry = cls._link_entry(
                value,
                lambda preset_id, kit_id=kit_id: KitPresetStore(kit_id, canonicalize=False).find_by_id(preset_id),
                kit_id,
            )
            if entry is not None:
                out[kit_id] = entry
        return out

    @classmethod
    def _preset_link(cls, category, name, ll_preset, clear_when_missing=False, kit_presets="", prompt_id=""):
        """The single source of truth for the preset link (PRESET_LINK_GAMEPLAN.md).

        LoRA Loadout's entry prefers the node's own ll_preset reference and falls back to
        the one stored on the selected saved prompt; kit entries come from kit_presets.
        Used by both get_prompt (to send) and IS_CHANGED (its signature), so the two never
        diverge. ``clear_when_missing`` becomes the link's missing policy.
        """
        ref = (ll_preset or "").strip()
        if not ref:
            category = cls._normalize_category_name(category)
            if category and name:
                try:
                    if prompt_id:
                        from ..utils.prompt_vault_store import prompts_by_id
                        matches = prompts_by_id(prompt_id)
                        saved = matches[0][2] if matches else {}
                    else:
                        saved = cls.load_prompts().get(category, {}).get(name, {})
                    if isinstance(saved, dict):
                        ref = str(saved.get("ll_preset") or "").strip()
                except Exception as e:
                    print(f"[KRC Prompt Vault] Could not resolve saved LL preset: {e}")
        targets = cls._kit_link_entries(kit_presets)
        lora = cls._link_entry(ref, lambda preset_id: PresetStore().find_by_id(preset_id), "LoRA Loadout")
        if lora is not None:
            targets[LORA_TARGET] = lora
        return build_link(targets, MISSING_CLEAR if clear_when_missing else MISSING_KEEP)

    def get_prompt(self, category, name, text="", ll_preset="", prompt_b="", append_prompt_b=False,
                   replace_find="", replace_with="", replace_prompt_b=False,
                   clear_lora_when_missing=False,
                   prompt_input_enabled=False, prompt_input_target="A", prompt_input="",
                   prompt_input_rejected="", prompt_input_rejected_target="A", kit_presets="",
                   thumbnail_image=None, unique_id=None, **kwargs):
        """Return the selected prompt text + the preset link, and broadcast a display update."""

        category = self._normalize_category_name(category)
        prompt_a = text if text else ""
        prompt_b = prompt_b if prompt_b else ""
        connector_prompt = str(prompt_input or "")
        input_target = "B" if prompt_input_target == "B" else "A"
        rejected_target = "B" if prompt_input_rejected_target == "B" else "A"
        input_rejected = bool(
            prompt_input_enabled
            and connector_prompt
            and connector_prompt == str(prompt_input_rejected or "")
            and input_target == rejected_target
        )
        input_applied = bool(prompt_input_enabled and connector_prompt.strip() and not input_rejected)
        if input_applied:
            if input_target == "B":
                prompt_b = connector_prompt
            else:
                prompt_a = connector_prompt
        output_text = prompt_a
        if append_prompt_b and prompt_b:
            # Separate Prompt A and Prompt B with a blank line so appended prompts stay
            # legible. Config Switcher's snapshot join (promptEmittedText) mirrors this.
            output_text = "\n\n".join(part for part in (prompt_a, prompt_b) if part)

        # The stored preset ids (or the saved record's), with each preset's rev.
        preset_out = self._preset_link(
            category, name, ll_preset, clear_when_missing=bool(clear_lora_when_missing),
            kit_presets=kit_presets, prompt_id=kwargs.get("prompt_id", ""),
        )

        # Usage counting is per RUN, not per emit — it lives in the on_prompt hook
        # (_count_prompt_run below) so a cached node still counts and a prompt used
        # by several nodes in one run counts once. Nothing to bump here.

        return {
            "ui": {
                "krc_prompt_input": [connector_prompt if input_applied else ""],
                "krc_prompt_input_target": [input_target if input_applied else ""],
            },
            "result": (output_text, preset_out),
        }


register_prompt_vault_routes(KRCPromptVault)


# --- Per-run prompt usage counting ------------------------------------------------------
# Count each saved prompt ONCE PER WORKFLOW RUN (per Queue Prompt), independent of
# ComfyUI's node caching — a cached KRC Prompt Vault node is still present in the
# submitted graph, and bypassed/muted nodes are pruned from it, so "in the submitted
# prompt" is exactly the per-run signal we want. Counting on the node's FUNCTION could
# not do this (cached executions skip FUNCTION). Best-effort: the hook never blocks or
# fails a queue.

_RUN_COUNTER_REGISTERED = False
_PROMPT_VAULT_CLASS_TYPE = "KRC Prompt Vault"
# Pushes the new totals to open pages so the Info Panel's "Used N times" ticks live.
# Absolute values (not +1), so a missed or repeated event can't drift the display.
PROMPT_USAGE_EVENT = "krc-prompt-usage"


def _prompt_vault_run_ids(prompt):
    """Deduped category/name usage ids for every KRC Prompt Vault node in one queued
    graph. A wired category/name input (a [node_id, slot] list) or a blank name is
    skipped; only a literal saved-prompt selection is counted."""
    ids = []
    if not isinstance(prompt, dict):
        return ids
    for node in prompt.values():
        if not isinstance(node, dict) or node.get("class_type") != _PROMPT_VAULT_CLASS_TYPE:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        category = inputs.get("category")
        name = inputs.get("name")
        if not isinstance(category, str) or not isinstance(name, str):
            continue
        name = name.strip()
        if not name:
            continue
        ids.append(f"{normalize_category_name(category)}/{name}")
    return ids


def _count_prompt_run(json_data):
    """on_prompt handler: bump each PV prompt's run count once for this queued prompt.
    bump_usage dedupes, so a prompt in several nodes counts once. The new totals go
    out on PROMPT_USAGE_EVENT. Returns json_data unchanged; swallows every error so
    bookkeeping can never break the queue."""
    try:
        # New workflows carry the stable prompt id. Group those references by their
        # actual owner; a same-name record in Default must never get another profile's
        # count. Old workflows without ids keep the legacy category/name path below.
        graph = json_data.get("prompt")
        references = []
        legacy = {}
        for key, node in (graph.items() if isinstance(graph, dict) else []):
            if not isinstance(node, dict) or node.get("class_type") != _PROMPT_VAULT_CLASS_TYPE:
                continue
            inputs = node.get("inputs") or {}
            record_id = inputs.get("prompt_id")
            if isinstance(record_id, str) and record_id.strip():
                references.append((record_id.strip(), inputs.get("category"), inputs.get("name")))
            else:
                legacy[key] = node
        if references:
            from ..utils.prompt_vault_store import prompt_owners, bump_prompt_usage
            grouped = {}
            owners = prompt_owners(record_id for record_id, _category, _name in references)
            for record_id, category, name in references:
                locations = owners.get(record_id, [])
                if not locations:
                    continue
                # Legacy copies of one id belong to one profile and count once.
                owner = next((item for item in locations if item["category"] == category and item["name"] == name), locations[0])
                grouped.setdefault(owner["profileId"], []).append(f'{owner["category"]}/{owner["name"]}')
            legacy_keys = _prompt_vault_run_ids(legacy)
            if legacy_keys:
                grouped.setdefault("default", []).extend(legacy_keys)
            for profile_id, keys in grouped.items():
                usage = bump_prompt_usage(keys, profile_id=profile_id)
                if usage:
                    server.PromptServer.instance.send_sync(PROMPT_USAGE_EVENT, {"usage": usage, "profileId": profile_id})
            return json_data
        ids = _prompt_vault_run_ids(json_data.get("prompt"))
        if ids:
            usage = bump_usage("prompts", ids)
            if usage:
                server.PromptServer.instance.send_sync(PROMPT_USAGE_EVENT, {"usage": usage})
    except Exception:
        pass
    return json_data


def register_prompt_vault_run_counter():
    """Register the per-run counter with the PromptServer once. No-op if the server
    or the on_prompt API is unavailable (older ComfyUI) — counting just stays off.
    The guard flag lives on the PromptServer singleton (which outlives a module
    reload) so a reload can't stack a second handler and double-count."""
    global _RUN_COUNTER_REGISTERED
    if _RUN_COUNTER_REGISTERED:
        return
    try:
        instance = server.PromptServer.instance
    except Exception:
        return
    if instance is None or getattr(instance, "_krc_pv_run_counter", False):
        _RUN_COUNTER_REGISTERED = True
        return
    handler_adder = getattr(instance, "add_on_prompt_handler", None)
    if not callable(handler_adder):
        return
    handler_adder(_count_prompt_run)
    instance._krc_pv_run_counter = True
    _RUN_COUNTER_REGISTERED = True


register_prompt_vault_run_counter()


class KRCPromptVaultMain(KRCPromptVault):
    """The canonical "KRC Prompt Vault" node."""

    DESCRIPTION = (
        "Browse, edit, and organize saved prompts with categories, thumbnails, "
        "Prompt A/B, a preset output for LoRA Loadout and Loadout Kit nodes, and "
        "Find/Replace tools."
    )

    @classmethod
    def INPUT_TYPES(cls):
        types = super().INPUT_TYPES()
        optional = dict(types.get("optional", {}))
        optional.pop("thumbnail_image", None)
        types["optional"] = optional
        return types

    def get_prompt(self, category, name, text="", ll_preset="",
                   thumbnail_image=None, unique_id=None, **kwargs):
        return super().get_prompt(category, name, text, ll_preset,
                                  thumbnail_image=None,
                                  unique_id=unique_id, **kwargs)


NODE_CLASS_MAPPINGS = {
    "KRC Prompt Vault": KRCPromptVaultMain,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC Prompt Vault": "KRC Prompt Vault",
}
