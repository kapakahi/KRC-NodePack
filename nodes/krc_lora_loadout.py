import json
import logging

from ..utils.library.run_usage import node_used
from ..utils.krc_log_settings import log_lora_names_enabled
from ..utils.lora_loadout.identity import IdentityStore
from ..utils.lora_loadout.library_index import LoraLibraryIndex
from ..utils.lora_loadout.presets import PresetStore, normalize_stack_enabled
from ..utils.preset_link import LORA_TARGET, MISSING_CLEAR, PRESET_LINK_TYPE, link_missing, read_target


logger = logging.getLogger(__name__)

LORA_STRENGTH_MIN = -10.0
LORA_STRENGTH_MAX = 10.0


class LoraBrowserNode:
    DESCRIPTION = (
        "LoRA Loadout with the LoRA library built in: browse LoRAs, edit metadata and "
        "thumbnails in the Info Panel, build two preset stacks, and output Stack A and B."
    )
    CATEGORY = "KRC NodePack"
    RETURN_TYPES = ("LORA_STACK_A", "LORA_STACK_B")
    RETURN_NAMES = ("stack_a", "stack_b")
    FUNCTION = "resolve_stacks"
    OUTPUT_NODE = False

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "stack_a_loras": ("STRING", {"default": "[]", "multiline": False}),
                "stack_b_loras": ("STRING", {"default": "[]", "multiline": False}),
                "active_preset": ("STRING", {"default": "", "multiline": False}),
                "stack_a_enabled": ("BOOLEAN", {"default": True}),
                "stack_b_enabled": ("BOOLEAN", {"default": True}),
                "auto_preset_link": ("BOOLEAN", {"default": True}),
                "selected_lora_sha256": ("STRING", {"default": "", "multiline": False}),
                "metadata_edit_serial": ("INT", {"default": 0}),
                "show_nsfw": ("BOOLEAN", {"default": False}),
                "show_favorites": ("BOOLEAN", {"default": False}),
                "color_filter": ("STRING", {"default": "", "multiline": False}),
                "browser_view": ("STRING", {"default": "thumb-list", "multiline": False}),
                "daisy_chain_mode": ("BOOLEAN", {"default": False}),
            },
            "optional": {
                "preset": (PRESET_LINK_TYPE, {"forceInput": True}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, stack_a_loras="[]", stack_b_loras="[]", active_preset="", **_kwargs):
        """Cache key for ComfyUI: the current path of every LoRA the stacks reference.
        The inputs are only ids, so without this a moved LoRA would keep ComfyUI serving
        the cached output with the old path. Healing here (one stat per LoRA; a rescan
        only when one moved) makes the change visible, and the node re-executes.
        A preset arriving on the `preset` link isn't known yet at this point; a new
        link changes that input, which re-executes the node anyway."""
        try:
            stacks = [cls._decode_stack(stack_a_loras), cls._decode_stack(stack_b_loras)]
            if active_preset:
                preset = PresetStore().find_by_id(active_preset)
                if preset:
                    stacks.extend(cls._preset_stacks(preset).values())
            identities = IdentityStore()
            ids = sorted({
                identities.canonical_id(entry.get("id") or entry.get("sha256"))
                for stack in stacks for entry in stack
                if isinstance(entry, dict) and (entry.get("id") or entry.get("sha256"))
            })
            if not ids:
                return ""
            index = LoraLibraryIndex()
            index.refresh(check_folders=False)
            index.heal(ids)
            return "|".join(f"{library_id}={(index.get(library_id) or {}).get('path', '')}" for library_id in ids)
        except Exception:  # noqa: BLE001 — never block a run; re-executing is the safe answer
            return float("nan")

    def resolve_stacks(
        self,
        stack_a_loras="[]",
        stack_b_loras="[]",
        active_preset="",
        stack_a_enabled=True,
        stack_b_enabled=True,
        auto_preset_link=True,
        selected_lora_sha256="",
        metadata_edit_serial=0,
        show_nsfw=False,
        show_favorites=False,
        color_filter="",
        browser_view="thumb-list",
        daisy_chain_mode=False,
        preset=None,
    ):
        # Runs trust the cached scan (no folder check); heal() below checks the files
        # this run actually loads.
        index = LoraLibraryIndex()
        index.refresh(check_folders=False)

        presets = PresetStore()
        stack_a_config = self._decode_stack(stack_a_loras)
        stack_b_config = self._decode_stack(stack_b_loras)
        identities = IdentityStore()
        self._canonicalize_stack(stack_a_config, identities)
        self._canonicalize_stack(stack_b_config, identities)
        raw_stack_a_count = len(stack_a_config)
        raw_stack_b_count = len(stack_b_config)
        # active_preset holds the preset's stable id (id-primary), "" for --empty--.
        current_id = str(active_preset or "").strip()
        active = presets.find_by_id(current_id) if current_id else None
        preset_name = active.get("name", "") if active else ""
        ui = {}
        auto = self._coerce_bool(auto_preset_link)
        log_lora_names = log_lora_names_enabled()

        # The preset link (PRESET_LINK_GAMEPLAN.md): an id, "" for --empty--, or None (no
        # link, or no entry for LoRA Loadout: keep the stacks). Stateless: load what the
        # link asks for when it isn't what's active; when it is, keep the node's stacks,
        # which may hold unsaved strength / enable edits.
        want = read_target(preset, LORA_TARGET) if auto else None
        matched = None
        if want:
            matched = presets.find_by_id(want)
            if matched is None:
                ui["krc_preset_link_missing"] = [json.dumps({"id": want})]
                if link_missing(preset) == MISSING_CLEAR:
                    logger.info("[KRC LoRA Loadout] preset link: missing id=%s, cleared.", want)
                    want = ""
                else:
                    logger.info("[KRC LoRA Loadout] preset link: missing id=%s, kept.", want)
                    want = None

        if want == "" and current_id:
            # Virtual "--empty--": no stored record. Clear both stacks to the blank slate.
            preset_name = "empty"
            stack_a_config = []
            stack_b_config = []
            # A dedicated flag (not an echoed id): the frontend clears its stacks and sets
            # active_preset="", which then reads as --empty--.
            ui["krc_triggered_empty"] = [True]
            ui["krc_stack_a_loras"] = [json.dumps(stack_a_config)]
            ui["krc_stack_b_loras"] = [json.dumps(stack_b_config)]
            logger.info("[KRC LoRA Loadout] preset link: applied --empty--.")
        elif matched and want != current_id:
            preset_name = matched.get("name", "")
            stacks = self._preset_stacks(matched)
            stack_a_config = stacks["A"]
            stack_b_config = stacks["B"]
            self._canonicalize_stack(stack_a_config, identities)
            self._canonicalize_stack(stack_b_config, identities)
            # The preset's Stack A / B switches apply too (they're part of the preset).
            switches = normalize_stack_enabled(matched.get("stackEnabled"))
            stack_a_enabled, stack_b_enabled = switches["A"], switches["B"]
            # Echo the id: the frontend sets active_preset to this value.
            ui["krc_triggered_preset"] = [want]
            ui["krc_stack_a_loras"] = [json.dumps(stack_a_config)]
            ui["krc_stack_b_loras"] = [json.dumps(stack_b_config)]
            ui["krc_stack_enabled"] = [json.dumps(switches)]
            logger.info("[KRC LoRA Loadout] preset link: applied id=%s (%s).", want, preset_name)

        missing = []
        stack_a_enabled = self._coerce_bool(stack_a_enabled)
        stack_b_enabled = self._coerce_bool(stack_b_enabled)
        daisy_chain_mode = self._coerce_bool(daisy_chain_mode)

        # Moved since the last scan? Re-find those LoRAs before resolving (path healing).
        heal_ids = [
            str(entry.get("id") or entry.get("sha256") or "").strip()
            for enabled, config in ((stack_a_enabled, stack_a_config), (stack_b_enabled, stack_b_config))
            if enabled
            for entry in config
            if isinstance(entry, dict)
        ]
        index.heal(heal_ids)   # logs "[KRC Library] ... healed N moved file path(s)"

        stack_a = self._resolve_stack(
            "A",
            stack_a_config,
            preset_name,
            index,
            missing,
        ) if stack_a_enabled else []
        stack_b = self._resolve_stack(
            "B",
            stack_b_config,
            preset_name,
            index,
            missing,
        ) if stack_b_enabled else []
        if daisy_chain_mode:
            stack_a = stack_a + stack_b
            stack_b = []
        # Entries whose LoRA is no longer in the library are dropped from the
        # output; report them so the UI can warn instead of silently shrinking
        # the stack, and relay to the terminal for anyone watching the log.
        if missing:
            ui["krc_missing_loras"] = [json.dumps(missing)]
            if log_lora_names:
                logger.warning(
                    "[KRC LoRA Loadout] skipped %d missing LoRA(s) for preset=%r (moved or removed): %s",
                    len(missing),
                    preset_name,
                    ", ".join(f"{item['stack']}:{item['id']}" for item in missing),
                )
            else:
                logger.warning(
                    "[KRC LoRA Loadout] skipped %d missing LoRA(s) for preset=%r (moved or removed).",
                    len(missing),
                    preset_name,
                )
        logger.info(
            "[KRC LoRA Loadout] resolved preset=%r auto=%s raw_a=%s raw_b=%s stack_a=%s stack_b=%s.",
            preset_name,
            auto,
            raw_stack_a_count,
            raw_stack_b_count,
            len(stack_a),
            len(stack_b),
        )

        # Usage, once per run (utils/library/run_usage.py): report every LoRA this
        # execution actually emits; a cached run is counted from the last report. Keyed by
        # the canonical library_id the browser card uses. Best-effort.
        node_used({"loras": [entry.get("library_id") for entry in (stack_a + stack_b)]})

        return {
            "ui": ui,
            "result": (stack_a, stack_b),
        }

    @staticmethod
    def _preset_stacks(preset):
        stacks = preset.get("stacks") if isinstance(preset, dict) else {}
        if isinstance(stacks, dict):
            return {
                "A": stacks.get("A", []) if isinstance(stacks.get("A", []), list) else [],
                "B": stacks.get("B", []) if isinstance(stacks.get("B", []), list) else [],
            }
        return {"A": preset.get("loras", []) if isinstance(preset.get("loras", []), list) else [], "B": []}

    @staticmethod
    def _decode_stack(raw):
        if isinstance(raw, list):
            return raw
        if not raw:
            return []
        try:
            decoded = json.loads(raw)
        except (TypeError, json.JSONDecodeError):
            return []
        return decoded if isinstance(decoded, list) else []

    def _canonicalize_stack(self, entries, identities):
        if not isinstance(entries, list):
            return entries
        for entry in entries:
            if isinstance(entry, dict):
                lora_id = entry.get("id") or entry.get("sha256")
                if lora_id:
                    entry["id"] = identities.canonical_id(lora_id)
        return entries

    def _resolve_stack(self, stack_id, entries, preset_name, index, missing=None):
        resolved = []
        for fallback_order, entry in enumerate(entries):
            if not isinstance(entry, dict):
                continue

            library_id = str(entry.get("id") or entry.get("sha256") or "").strip()
            if not library_id:
                continue

            record = index.get(library_id)
            if index._dead(record):
                if missing is not None:
                    reason = "unavailable" if record and record.get("unavailable") else "not found"
                    missing.append({"stack": stack_id, "id": library_id, "reason": reason})
                continue

            sidecar = record.get("sidecar_data") or {}
            resolved.append(
                {
                    "stack": stack_id,
                    "preset": preset_name or "",
                    "sha256": record.get("sha256") or "",
                    "library_id": library_id,
                    "name": sidecar.get("name") or record.get("display_name") or record.get("filename"),
                    "path": record.get("path"),
                    "enabled": bool(entry.get("enabled", True)),
                    "strength": self._coerce_strength(entry.get("strength", 1.0)),
                    "order": int(entry.get("order", fallback_order)),
                    "baseModel": sidecar.get("baseModel", ""),
                    "category": sidecar.get("category", ""),
                    "cardColor": sidecar.get("cardColor", ""),
                    "favorite": bool(sidecar.get("favorite", False)),
                }
            )

        resolved.sort(key=lambda item: item["order"])
        return resolved

    def _coerce_strength(self, value):
        try:
            strength = float(value)
        except (TypeError, ValueError):
            return 1.0
        return max(LORA_STRENGTH_MIN, min(LORA_STRENGTH_MAX, strength))

    def _coerce_bool(self, value):
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() not in ("", "0", "false", "no", "off", "none")
        return bool(value)


class LoraBrowserMiniNode(LoraBrowserNode):
    CATEGORY = "KRC NodePack"
    DESCRIPTION = (
        "Pick LoRAs (Browse opens the KRC Portal, or drag cards in) into two preset "
        "stacks, and output Stack A and Stack B. Auto-loads the preset Prompt Vault links."
    )


# Register the shared LoRA Loadout API routes (library, thumbnails, presets,
# metadata, import/export) at import time. Guarded internally against re-run.
from ..utils.lora_loadout.routes import register_routes
register_routes()

# Cross-node Collections routes (shared store spanning models + LoRAs). Idempotent; also
# registered from the Model Library node, whichever loads first.
from ..utils.library.collections_routes import register_collection_routes
from ..utils.library.transfer_history import register_transfer_history_routes
register_collection_routes()
register_transfer_history_routes()

# The type keys are the names (2026-10-27): the compact node is "KRC LoRA Loadout", the
# one with the built-in browser "KRC LoRA Loadout EX". (They were "KRC LoRA Loadout Mini"
# and "KRC LoRA Loadout"; saved nodes of either kind are re-added once.)
NODE_CLASS_MAPPINGS = {
    "KRC LoRA Loadout EX": LoraBrowserNode,
    "KRC LoRA Loadout": LoraBrowserMiniNode,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "KRC LoRA Loadout EX": "KRC LoRA Loadout EX",
    "KRC LoRA Loadout": "KRC LoRA Loadout",
}
