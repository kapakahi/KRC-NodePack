import logging
import json
import os

try:
    import comfy.sd
    import comfy.utils
except ImportError:
    comfy = None

from ..utils.krc_log_settings import log_lora_names_enabled

logger = logging.getLogger(__name__)

LORA_STRENGTH_MIN = -10.0
LORA_STRENGTH_MAX = 10.0


class LoraLoaderNode:
    DESCRIPTION = (
        "Loads the LoRA stack output from KRC LoRA Loadout into the connected model."
    )
    CATEGORY = "KRC NodePack"
    RETURN_TYPES = ("MODEL",)
    RETURN_NAMES = ("model",)
    FUNCTION = "apply_lora_stack"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
            },
            "optional": {
                "lora_stack": ("LORA_STACK_A,LORA_STACK_B",),
            }
        }

    def apply_lora_stack(self, model, lora_stack=None):
        if lora_stack is None:
            logger.info("[KRC LoRA Loadout Loader] No KRC LoRA Loadout stack connected; passing model through unchanged.")
            return {
                "ui": {"text": ["No stack connected · bypassed"]},
                "result": (model,),
            }

        active_count = 0
        missing_names = []
        loaded_names = []
        resolved_stack = self._normalize_stack(lora_stack)
        log_lora_names = log_lora_names_enabled()
        stack_ids = []
        for entry in resolved_stack:
            stack_id = str(entry.get("stack", "")).strip()
            if stack_id and stack_id not in stack_ids:
                stack_ids.append(stack_id)
        stack_label = f"Stack {'+'.join(stack_ids)}" if stack_ids else "Stack"

        for entry in resolved_stack:
            if not entry.get("enabled", True):
                continue

            path = entry.get("path")
            if not path:
                continue

            # A file that isn't there (moved after LoRA Loadout resolved it, deleted, drive
            # offline) is skipped with a warning instead of failing the whole run.
            if not os.path.isfile(path):
                missing_names.append(str(entry.get("name") or os.path.basename(path)))
                continue

            strength = self._coerce_strength(entry.get("strength", 1.0))
            if comfy is None:
                continue

            lora = comfy.utils.load_torch_file(path, safe_load=True)
            model, _clip = comfy.sd.load_lora_for_models(model, None, lora, strength, 0.0)
            active_count += 1
            if log_lora_names:
                loaded_names.append(f"{entry.get('name') or path} ({strength:g})")

        if log_lora_names:
            logger.info(
                "[KRC LoRA Loadout Loader] received %s stack entries; loaded %s active LoRAs: %s",
                len(resolved_stack),
                active_count,
                ", ".join(loaded_names) if loaded_names else "none",
            )
        else:
            logger.info(
                "[KRC LoRA Loadout Loader] received %s stack entries; loaded %s active LoRAs.",
                len(resolved_stack),
                active_count,
            )
        if missing_names:
            logger.warning(
                "[KRC LoRA Loadout Loader] skipped %d LoRA(s) whose file is missing: %s",
                len(missing_names),
                ", ".join(missing_names),
            )
        missing_text = f" · {len(missing_names)} missing" if missing_names else ""
        return {
            "ui": {"text": [f"{stack_label} · {active_count} active{missing_text}"]},
            "result": (model,),
        }

    def _normalize_stack(self, lora_stack):
        if isinstance(lora_stack, str):
            try:
                lora_stack = json.loads(lora_stack)
            except json.JSONDecodeError:
                return []

        if isinstance(lora_stack, tuple):
            if len(lora_stack) == 1:
                return self._normalize_stack(lora_stack[0])
            return [entry for item in lora_stack for entry in self._normalize_stack(item)]

        if isinstance(lora_stack, dict):
            if isinstance(lora_stack.get("result"), (list, tuple)):
                return self._normalize_stack(lora_stack["result"])
            if "path" in lora_stack or "sha256" in lora_stack or "library_id" in lora_stack:
                return [lora_stack]

        if isinstance(lora_stack, list):
            if len(lora_stack) == 1 and isinstance(lora_stack[0], (list, tuple)):
                return self._normalize_stack(lora_stack[0])
            return [entry for entry in lora_stack if isinstance(entry, dict)]
        return []

    def _coerce_strength(self, value):
        try:
            strength = float(value)
        except (TypeError, ValueError):
            return 1.0
        return max(LORA_STRENGTH_MIN, min(LORA_STRENGTH_MAX, strength))


NODE_CLASS_MAPPINGS = {"KRC LoRA Loadout Loader": LoraLoaderNode}
NODE_DISPLAY_NAME_MAPPINGS = {"KRC LoRA Loadout Loader": "KRC LoRA Loadout Loader"}
