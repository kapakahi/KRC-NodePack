"""Loadout Kit runtime: a card-stack node described by a kit (source, slots, fields).

The kit owns everything a card-stack node does that isn't its loader's math: the hidden
inputs, the preset store + the preset link (KRC_PRESET ids, PRESET_LINK_GAMEPLAN.md),
canonical ids, resolving cards (healed model paths / prompt text), the missing-card
report, usage counting and the ``IS_CHANGED`` key. Rewritten generic from KRC RefMod
Loadout (see LOADOUT_KIT_GAMEPLAN.md in the dev repo).

    kit = LoadoutKit("my_kit", source={"kind": "model", "folder": "refmods"}, slots=8,
                     fields=[kit_field("strength", "float", 0, 1, default=1.0, label="S")])
    INPUT_TYPES -> kit.input_types(required={...the node's own inputs...})
    IS_CHANGED  -> kit.is_changed(**kwargs)
    FUNCTION    -> loadout = kit.resolve(**kwargs); ...loader(loadout.entries)...;
                   return {"ui": loadout.ui, "result": (...)}
"""

import json
import logging
import re
from dataclasses import dataclass, field as dc_field

from ..card_resolve import canonical_ids, resolve_models, resolve_prompts
from ..library.run_usage import node_used
from ..preset_link import LORA_TARGET, MISSING_CLEAR, PRESET_LINK_TYPE, link_missing, read_target
from .fields import coerce_bool, coerce_field, validate_fields
from .presets import KitPresetStore

logger = logging.getLogger(__name__)

DESCRIPTOR_VERSION = 2
MAX_SLOTS = 16
STACK_ID = "A"

# Hidden inputs every kit node has (the JS kit hides and drives them).
STACK_INPUT = "loadout_stack"
HIDDEN_INPUTS = {
    STACK_INPUT: ("STRING", {"default": "[]", "multiline": False}),
    "active_preset": ("STRING", {"default": "", "multiline": False}),
    "auto_preset_link": ("BOOLEAN", {"default": True}),
}
# The optional preset link input (KRC_PRESET, from Prompt Vault).
LINK_INPUT = "preset"

# UI message keys the JS kit reads after a run.
UI_TRIGGERED_PRESET = "krc_triggered_preset"
UI_TRIGGERED_EMPTY = "krc_triggered_empty"
UI_STACK = "krc_loadout_stack"
UI_MISSING = "krc_loadout_missing"
UI_LINK_MISSING = "krc_preset_link_missing"

_KIT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{1,47}$")
_KITS = {}


def get_kit(kit_id):
    return _KITS.get(kit_id)


def all_kits():
    return dict(_KITS)


@dataclass
class Loadout:
    """One run's resolved stack. ``entries``: enabled, found cards in slot order, each
    ``{"id", "slot", <field>: value, ...}`` plus ``"path"`` (model sources) or
    ``"text"``, ``"name"``, ``"category"`` (prompt sources)."""
    entries: list
    ui: dict
    preset_name: str = ""
    preset_link: object = None  # this kit's link target: an id, "" (empty) or None
    missing: list = dc_field(default_factory=list)


class LoadoutKit:
    def __init__(self, kit_id, *, source, slots, fields=(), label="", short_label="", prompt_vault=False):
        kit_id = str(kit_id or "")
        if not _KIT_ID_RE.match(kit_id):
            raise ValueError(f"loadout kit: invalid id {kit_id!r} (lowercase letters, digits, _)")
        if kit_id == LORA_TARGET:
            raise ValueError(f"loadout kit: id {kit_id!r} is reserved for LoRA Loadout")
        self.id = kit_id
        self.source = self._normalize_source(source)
        try:
            slots = int(slots)
        except (TypeError, ValueError):
            raise ValueError("loadout kit: slots must be an integer") from None
        if not 1 <= slots <= MAX_SLOTS:
            raise ValueError(f"loadout kit: slots must be 1..{MAX_SLOTS}")
        self.slots = slots
        self.fields = validate_fields(fields)
        # Display names (descriptor 2 / API 1.7): `label` names the kit where NodePack lists
        # kits (the Portal's Import and Export page); `short_label` is the compact form
        # (Prompt Vault's "<short> Preset" row). `prompt_vault` opts the kit into a preset
        # row on Prompt Vault, so NodePack never hard-codes which kits get one.
        self.label = str(label or "").strip() or kit_id
        self.short_label = str(short_label or "").strip() or self.label
        self.prompt_vault = bool(prompt_vault)
        self.log_tag = f"[KRC Loadout {kit_id}]"
        if kit_id in _KITS:
            logger.warning("%s kit registered twice; the newer definition wins.", self.log_tag)
        _KITS[kit_id] = self

    # ---- description ---------------------------------------------------------------

    @staticmethod
    def _normalize_source(source):
        source = source if isinstance(source, dict) else {}
        kind = source.get("kind")
        if kind == "model":
            folder = str(source.get("folder") or "").strip()
            folder = "" if folder == "all" else ("lora" if folder == "loras" else folder)
            return {"kind": "model", "folder": folder}
        if kind == "prompt":
            return {"kind": "prompt", "category": str(source.get("category") or "").strip()}
        raise ValueError("loadout kit: source kind must be 'model' or 'prompt'")

    def descriptor(self):
        """The JSON the JS kit builds the node from (served by the descriptor routes)."""
        return {
            "version": DESCRIPTOR_VERSION,
            "id": self.id,
            "label": self.label,
            "shortLabel": self.short_label,
            "promptVault": self.prompt_vault,
            "source": dict(self.source),
            "slots": self.slots,
            "fields": [dict(field) for field in self.fields],
        }

    def presets(self):
        return KitPresetStore(self.id, canonicalize=self.source["kind"] == "model")

    def input_types(self, required=None, optional=None):
        """INPUT_TYPES for the node: the kit's hidden inputs and the optional ``preset``
        link, plus the node's own (which may not reuse the kit's names)."""
        own = {**(required or {}), **(optional or {})}
        clash = set(own) & (set(HIDDEN_INPUTS) | {LINK_INPUT})
        if clash:
            raise ValueError(f"loadout kit: input names reserved by the kit: {sorted(clash)}")
        return {
            "required": {**HIDDEN_INPUTS, **(required or {})},
            "optional": {LINK_INPUT: (PRESET_LINK_TYPE, {"forceInput": True}), **(optional or {})},
        }

    # ---- runtime -------------------------------------------------------------------

    def is_changed(self, **kwargs):
        """Cache key: the current path / text of every card the stack (and its active
        preset) references, so a moved file or an edited prompt re-executes the node."""
        try:
            stacks = [decode_stack(kwargs.get(STACK_INPUT, "[]"))]
            active = str(kwargs.get("active_preset") or "")
            if active:
                preset = self.presets().find_by_id(active)
                if preset:
                    stacks.append(preset_stack(preset))
            ids = sorted(set(self._canonical([
                entry_id(entry) for stack in stacks for entry in stack if entry_id(entry)
            ])))
            if not ids:
                return ""
            cards = self._resolve_cards(ids)
            key = "text" if self.source["kind"] == "prompt" else "path"
            return "|".join(f"{card_id}={cards.get(card_id, {}).get(key, '')}" for card_id in ids)
        except Exception:  # noqa: BLE001 - never block a run; re-executing is the safe answer
            return float("nan")

    def resolve(self, **kwargs):
        """The stack this run uses, after the preset link, as a :class:`Loadout`."""
        presets = self.presets()
        stack = decode_stack(kwargs.get(STACK_INPUT, "[]"))
        self._canonicalize(stack)
        current_id = str(kwargs.get("active_preset") or "").strip()
        active = presets.find_by_id(current_id) if current_id else None
        preset_name = active.get("name", "") if active else ""
        link = kwargs.get(LINK_INPUT)
        auto = coerce_bool(kwargs.get("auto_preset_link", True))
        ui = {}

        # The same stateless rule as LoRA Loadout's: load this kit's linked preset when it
        # isn't the active one; when it is, keep the stack (it may hold unsaved field /
        # enable edits). "" is --empty--; a missing id keeps or clears per the link.
        want = read_target(link, self.id) if auto else None
        target = want
        matched = None
        if want:
            matched = presets.find_by_id(want)
            if matched is None:
                ui[UI_LINK_MISSING] = [json.dumps({"id": want})]
                cleared = link_missing(link) == MISSING_CLEAR
                logger.info("%s preset link: missing id=%s, %s.", self.log_tag, want, "cleared" if cleared else "kept")
                want = "" if cleared else None

        if want == "" and current_id:
            preset_name = "empty"
            stack = []
            ui[UI_TRIGGERED_EMPTY] = [True]
            ui[UI_STACK] = [json.dumps(stack)]
            logger.info("%s preset link: applied --empty--.", self.log_tag)
        elif matched and want != current_id:
            preset_name = matched.get("name", "")
            stack = preset_stack(matched)
            self._canonicalize(stack)
            ui[UI_TRIGGERED_PRESET] = [want]
            ui[UI_STACK] = [json.dumps(stack)]
            logger.info("%s preset link: applied id=%s (%s).", self.log_tag, want, preset_name)

        missing = []
        cards = self._resolve_cards([entry_id(entry) for entry in stack if isinstance(entry, dict)])
        entries = self._entries(stack, cards, missing)
        if missing:
            ui[UI_MISSING] = [json.dumps(missing)]
            logger.warning("%s skipped %d missing card(s) for preset=%r (moved or removed).",
                           self.log_tag, len(missing), preset_name)
        logger.info("%s resolved preset=%r auto=%s slots=%s loaded=%s.",
                    self.log_tag, preset_name, auto, len(stack), len(entries))
        self._report_usage(entries)
        return Loadout(entries=entries, ui=ui, preset_name=preset_name, preset_link=target, missing=missing)

    # ---- internals -----------------------------------------------------------------

    def _canonical(self, ids):
        return canonical_ids(ids) if self.source["kind"] == "model" else list(ids)

    def _canonicalize(self, entries):
        keyed = [entry for entry in entries if isinstance(entry, dict) and entry_id(entry)]
        for entry, card_id in zip(keyed, self._canonical([entry_id(entry) for entry in keyed])):
            entry["id"] = card_id
        return entries

    def _resolve_cards(self, ids):
        ids = [card_id for card_id in ids if card_id]
        if not ids:
            return {}
        return resolve_prompts(ids) if self.source["kind"] == "prompt" else resolve_models(ids)

    def _coerce_order(self, value):
        try:
            return max(0, min(self.slots - 1, int(value)))
        except (TypeError, ValueError):
            return self.slots - 1

    def _entries(self, stack, cards, missing):
        out = []
        for entry in sorted(
            (entry for entry in stack if isinstance(entry, dict)),
            key=lambda entry: self._coerce_order(entry.get("order")),
        ):
            card_id = entry_id(entry)
            if not card_id or not coerce_bool(entry.get("enabled", True)):
                continue
            card = cards.get(card_id) or {"error": "not found"}
            if card.get("error"):
                missing.append({"stack": STACK_ID, "id": card_id, "reason": card["error"]})
                continue
            resolved = {"id": card_id, "slot": self._coerce_order(entry.get("order"))}
            if self.source["kind"] == "prompt":
                resolved.update({"text": card.get("text", ""), "name": card.get("name", ""),
                                 "category": card.get("category", "")})
            else:
                resolved["path"] = card.get("path") or ""
            for field in self.fields:
                resolved[field["key"]] = coerce_field(field, entry.get(field["key"]))
            out.append(resolved)
        return out[: self.slots]

    def _report_usage(self, entries):
        # Once per run, cached runs included (utils/library/run_usage.py). Prompt usage is
        # keyed by category/name (Prompt Vault's ledger key).
        if self.source["kind"] == "prompt":
            node_used({"prompts": [f"{entry['category']}/{entry['name']}" for entry in entries]})
        else:
            node_used({"models": [entry["id"] for entry in entries]})


# ---- stack helpers (pure) ------------------------------------------------------------

def entry_id(entry):
    return str(entry.get("id") or entry.get("sha256") or "").strip() if isinstance(entry, dict) else ""


def decode_stack(raw):
    if isinstance(raw, list):
        return raw
    if not raw:
        return []
    try:
        decoded = json.loads(raw)
    except (TypeError, json.JSONDecodeError):
        return []
    return decoded if isinstance(decoded, list) else []


def preset_stack(preset):
    stack = preset.get("stack") if isinstance(preset, dict) else None
    return [dict(entry) for entry in stack if isinstance(entry, dict)] if isinstance(stack, list) else []
