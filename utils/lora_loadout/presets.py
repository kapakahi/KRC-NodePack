import time
import uuid

from ..db import presets as preset_db
from ..db import connection as db
from .identity import IdentityStore
from .metadata import get_krc_base_dir
from ..preset_naming import NONE_PRESET_GROUP, canonical_group, canonical_label, delete_store_group, rename_store_group, ungroup_store_group

# Labels that would shadow the virtual --empty-- / --unsaved-- pseudo-presets. LoRA
# Loadout only — Word Bank / Config Switcher have no such virtual states.
_RESERVED_PRESET_LABELS = {"--empty--", "--unsaved--"}


def normalize_stack_enabled(value):
    """A preset's Stack A / B switches: {"A": bool, "B": bool}. Missing (presets saved
    before the switches were part of a preset) = both on."""
    value = value if isinstance(value, dict) else {}
    return {"A": value.get("A") is not False, "B": value.get("B") is not False}


def is_reserved_preset_name(group, label):
    """True when (group, label) would collide with a virtual LL pseudo-preset:
    ``empty`` in group ``none`` (the ``none:empty`` trigger), or the display tokens
    ``--empty--`` / ``--unsaved--`` in any group."""
    normalized = canonical_label(label).lower()
    if canonical_group(group) == NONE_PRESET_GROUP and normalized == "empty":
        return True
    return normalized in _RESERVED_PRESET_LABELS
# Valid card-color ids come from the one shared source (parsed from card_colors.js,
# the single source of truth for card/folder colors) so the backend allowlist can
# never drift again — it once did (gold/purple/copper vs. yellow/black/orange),
# silently dropping picks from the swatch UI.
from ..library.card_colors import CARD_COLOR_IDS

# The pre-database JSON files, read once by the stage-2 import (utils/db/importers.py).
PRESETS_FILENAME = "lora_loadout_presets.json"
FOLDER_COLORS_FILENAME = "lora_loadout_folder_colors.json"
FOLDER_LINEAGE = "loras"


def legacy_presets_path():
    return get_krc_base_dir() / PRESETS_FILENAME


def legacy_folder_colors_path():
    return get_krc_base_dir() / FOLDER_COLORS_FILENAME


def legacy_raw_presets(data):
    """The preset list of an old presets file, including the oldest {"A": [...], "B": [...]}
    shape (one stack per preset)."""
    if not isinstance(data, dict):
        return []
    if isinstance(data.get("presets"), list):
        return data["presets"]
    raw = []
    for stack_key in ("A", "B"):
        stack_presets = data.get(stack_key, [])
        if isinstance(stack_presets, list):
            for preset in stack_presets:
                if isinstance(preset, dict):
                    migrated = dict(preset)
                    migrated["stacks"] = {
                        "A": preset.get("loras", []) if stack_key == "A" and isinstance(preset.get("loras", []), list) else [],
                        "B": preset.get("loras", []) if stack_key == "B" and isinstance(preset.get("loras", []), list) else [],
                    }
                    raw.append(migrated)
    return raw


class PresetStore:
    """LoRA Loadout stack presets, in krc.db (kind "ll")."""

    def load(self):
        return {"presets": self._dedupe(preset_db.load_records(preset_db.LORA_LOADOUT))}

    def save(self, data):
        payload = {
            "presets": self._dedupe(data.get("presets", []) if isinstance(data.get("presets", []), list) else []),
            "modified": int(time.time()),
        }
        preset_db.save_records(preset_db.LORA_LOADOUT, payload["presets"])
        return payload

    @db.atomic
    def upsert(self, preset_id, group, name, loras=None, stacks=None, stack_enabled=None):
        """Create or update a preset, addressed by id.

        A non-empty ``preset_id`` that matches an existing preset updates it in place
        (group/name/stacks may all change) — this is what keeps a Prompt Vault link
        stable across an edit or rename. An empty/unknown id mints a new preset. Returns
        the canonical saved record (post-normalize), so callers get the resolved id.
        The trigger is not stored; it is composed on demand from group + label name.
        A name reserved for a virtual pseudo-preset is rejected (returns None).
        """
        if is_reserved_preset_name(group, name):
            return None
        data = self.load()
        preset_id = str(preset_id or "").strip()
        existing = next((p for p in data["presets"] if p.get("id") == preset_id), None) if preset_id else None
        pid = (existing or {}).get("id") or uuid.uuid4().hex
        presets = [preset for preset in data["presets"] if preset.get("id") != pid]
        presets.append(
            {
                "id": pid,
                "group": canonical_group(group),
                "name": canonical_label(name),
                "stacks": self._normalize_stacks(stacks, loras),
                "stackEnabled": normalize_stack_enabled(stack_enabled),
                "modified": int(time.time()),
            }
        )
        data["presets"] = presets
        self.save(data)
        return next((p for p in self.load()["presets"] if p.get("id") == pid), presets[-1])

    @db.atomic
    def rename(self, preset_id, group, new_name, stacks=None, loras=None, stack_enabled=None):
        """Atomically rename/regroup a preset (addressed by id) in a single load/save.

        Returns "not_found" if the id is gone. Because the id is the identity, a
        rename never breaks a Prompt Vault link and duplicate names are allowed
        (group + name are display attributes), so there is no "exists" collision to
        guard. The trigger is composed from group + label name, never stored.
        """
        preset_id = str(preset_id or "").strip()
        new_name = canonical_label(new_name)
        if not new_name:
            return {"ok": False, "error": "invalid"}
        if is_reserved_preset_name(group, new_name):
            return {"ok": False, "error": "reserved"}
        data = self.load()
        presets = data["presets"]
        existing = next((preset for preset in presets if preset.get("id") == preset_id), None)
        if existing is None:
            return {"ok": False, "error": "not_found"}
        if stacks is not None or loras is not None:
            new_stacks = self._normalize_stacks(stacks, loras)
        else:
            new_stacks = existing.get("stacks", {"A": [], "B": []})
        remaining = [preset for preset in presets if preset.get("id") != preset_id]
        remaining.append(
            {
                # Identity is the id, carried untouched across the rename — this is
                # the whole point of id-backed references (the PV link survives).
                "id": preset_id,
                "group": canonical_group(group),
                "name": new_name,
                "stacks": new_stacks,
                "stackEnabled": normalize_stack_enabled(
                    stack_enabled if stack_enabled is not None else existing.get("stackEnabled")),
                "modified": int(time.time()),
            }
        )
        data["presets"] = remaining
        saved = self.save(data)
        renamed = next((preset for preset in saved["presets"] if preset.get("id") == preset_id), None)
        return {"ok": True, "preset": renamed}

    @db.atomic
    def rename_group(self, old, new):
        """Move every preset in group ``old`` to ``new`` (merging into an existing group);
        duplicate names are allowed here, as in rename()."""
        return rename_store_group(self, old, new, reserved=is_reserved_preset_name)

    @db.atomic
    def ungroup_group(self, group):
        """Move every preset in ``group`` to --none-- (refused for a preset named "empty",
        which would shadow --empty--)."""
        return ungroup_store_group(self, group, reserved=is_reserved_preset_name)

    @db.atomic
    def delete_group(self, group):
        """Delete ``group`` and every preset in it, in one save."""
        return delete_store_group(self, group)

    def find_by_id(self, preset_id):
        preset_id = str(preset_id or "").strip()
        if not preset_id:
            return None
        for preset in self.load()["presets"]:
            if preset.get("id") == preset_id:
                return preset
        return None

    def find_by_name(self, stack_id, name):
        for preset in self.load()["presets"]:
            if preset.get("name") == name:
                return preset
        return None

    @db.atomic
    def delete(self, preset_id):
        preset_id = str(preset_id or "")
        data = self.load()
        before = len(data["presets"])
        data["presets"] = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        self.save(data)
        return len(data["presets"]) != before

    def _dedupe(self, presets):
        # Keyed by the stable `id` — the preset's identity. `group` + `name` are mutable
        # display attributes, so two presets may legitimately share them; only the id
        # must be unique. Ids are minted solely by upsert()/rename(); a preset that
        # reaches here without one is malformed and dropped, keeping load() a pure read.
        deduped = {}
        for preset in presets:
            if not isinstance(preset, dict) or not preset.get("id") or not preset.get("name"):
                continue
            existing = deduped.get(preset["id"], {})
            stacks = self._normalize_stacks(preset.get("stacks"), preset.get("loras"))
            existing_stacks = existing.get("stacks", {"A": [], "B": []})
            group = canonical_group(preset.get("group"))
            name = canonical_label(preset.get("name", ""))
            deduped[preset["id"]] = {
                "id": preset["id"],
                "group": group,
                "name": name,
                "stacks": {
                    "A": stacks["A"] or existing_stacks.get("A", []),
                    "B": stacks["B"] or existing_stacks.get("B", []),
                },
                "stackEnabled": normalize_stack_enabled(preset.get("stackEnabled")),
                "modified": preset.get("modified") or existing.get("modified") or int(time.time()),
            }
        return sorted(
            deduped.values(),
            key=lambda item: (item.get("group", "").lower(), item.get("name", "").lower()),
        )

    def _normalize_stacks(self, stacks=None, loras=None):
        identities = IdentityStore()
        def normalize_entries(entries):
            out = []
            source = entries if isinstance(entries, list) else []
            for entry in source:
                if not isinstance(entry, dict):
                    continue
                lora_id = entry.get("id") or entry.get("sha256")
                if not lora_id:
                    continue
                normalized = dict(entry)
                normalized.pop("sha256", None)
                normalized["id"] = identities.canonical_id(lora_id)
                out.append(normalized)
            return out

        if isinstance(stacks, dict):
            return {
                "A": normalize_entries(stacks.get("A", [])),
                "B": normalize_entries(stacks.get("B", [])),
            }
        return {
            "A": normalize_entries(loras),
            "B": [],
        }


def normalize_folder_color(color_id):
    color_id = str(color_id or "").strip().lower()
    return color_id if color_id in CARD_COLOR_IDS else ""


def clean_folder_colors(data):
    """A folder-colours payload ({"folders", "pinned", "modified"}), cleaned: only known
    colour ids, pinned folders as strings."""
    if not isinstance(data, dict):
        return {"folders": {}, "pinned": [], "modified": 0}
    raw = data.get("folders")
    folders = {}
    if isinstance(raw, dict):
        for folder, color_id in raw.items():
            color_id = normalize_folder_color(color_id)
            if color_id:
                folders[str(folder)] = color_id
    raw_pinned = data.get("pinned")
    pinned = [str(f) for f in raw_pinned if f] if isinstance(raw_pinned, list) else []
    return {"folders": folders, "pinned": pinned, "modified": int(data.get("modified") or 0)}


class FolderColorStore:
    """LoRA folder colours and pins, in krc.db (folder_colors, lineage "loras")."""

    def load(self):
        return clean_folder_colors(preset_db.load_folder_colors(FOLDER_LINEAGE))

    @db.atomic
    def save_folder(self, folder, color_id):
        data = self.load()
        folders = data["folders"]
        folder = str(folder or "loras")
        color_id = self._normalize_color(color_id)
        if color_id:
            folders[folder] = color_id
        else:
            folders.pop(folder, None)
        return self._write({"folders": folders, "pinned": data["pinned"], "modified": int(time.time())})

    @db.atomic
    def save_pin(self, folder, pinned):
        # Pin/unpin a real folder to the top of the browser tree. Scope rows
        # (the "loras" all-scope and the "__root__" root scope) are fixed and
        # never user-pinned, so they are ignored here.
        data = self.load()
        folder = str(folder or "")
        pins = [f for f in data["pinned"] if f != folder]
        if pinned and folder and folder not in ("loras", "__root__"):
            pins.append(folder)
        return self._write({"folders": data["folders"], "pinned": pins, "modified": int(time.time())})

    def _write(self, payload):
        return preset_db.save_folder_colors(FOLDER_LINEAGE, payload)

    def _normalize_color(self, color_id):
        return normalize_folder_color(color_id)
