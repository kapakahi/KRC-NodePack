"""Loadout Kit preset store: one global, id-primary preset set per kit.

Kept in krc.db (kind ``kit:<kit id>`` in the presets table). The old file,
``krc_nodes/<kit id>/<kit id>_presets.json``, is read once by the stage-2 import
(utils/db/importers.py). Record shape, shared with every KRC preset store:

    {"id": <hex>, "group": <group>, "name": <label>, "stack": [...], "modified": int}

Stack entries are ``{"id", "order", "enabled", <field>: <value>, ...}``; ``id`` is a
Model Library id (canonicalized on write) or a Prompt Vault id. The trigger is composed
from group + name, never stored.
"""

import time
import uuid

from ..card_resolve import canonical_ids
from ..db import presets as preset_db
from ..db import connection as db
from ..krc_paths import get_krc_node_dir
from ..preset_naming import NONE_PRESET_GROUP, canonical_group, canonical_label, delete_store_group, rename_store_group, ungroup_store_group

# Labels that would shadow the virtual --empty-- / --unsaved-- pseudo-presets.
_RESERVED_PRESET_LABELS = {"--empty--", "--unsaved--"}


def is_reserved_preset_name(group, label):
    """True when (group, label) would collide with a virtual pseudo-preset: ``empty`` in
    group ``none`` (the ``none:empty`` trigger), or ``--empty--`` / ``--unsaved--`` in
    any group."""
    normalized = canonical_label(label).lower()
    if canonical_group(group) == NONE_PRESET_GROUP and normalized == "empty":
        return True
    return normalized in _RESERVED_PRESET_LABELS


def legacy_presets_path(kit_id):
    """The pre-database presets file of one kit (krc_nodes/<kit id>/<kit id>_presets.json)."""
    return get_krc_node_dir(kit_id) / f"{kit_id}_presets.json"


class KitPresetStore:
    def __init__(self, kit_id, *, canonicalize=True):
        self.kit_id = kit_id
        self.kind = preset_db.kit_kind(kit_id)
        # Model Library ids follow stabilization; Prompt Vault ids are already stable.
        self.canonicalize = canonicalize

    def load(self):
        return {"presets": self._dedupe(preset_db.load_records(self.kind))}

    def save(self, data):
        payload = {
            "presets": self._dedupe(data.get("presets", []) if isinstance(data.get("presets", []), list) else []),
            "modified": int(time.time()),
        }
        preset_db.save_records(self.kind, payload["presets"])
        return payload

    @db.atomic
    def upsert(self, preset_id, group, name, stack=None):
        """Create or update a preset, addressed by id. An existing id updates in place
        (keeps Prompt Vault links stable); an empty/unknown id mints a new preset.
        Returns the saved record, or None for a reserved pseudo-preset name."""
        if is_reserved_preset_name(group, name):
            return None
        data = self.load()
        preset_id = str(preset_id or "").strip()
        existing = next((p for p in data["presets"] if p.get("id") == preset_id), None) if preset_id else None
        pid = (existing or {}).get("id") or uuid.uuid4().hex
        presets = [preset for preset in data["presets"] if preset.get("id") != pid]
        presets.append({
            "id": pid,
            "group": canonical_group(group),
            "name": canonical_label(name),
            "stack": self._normalize_stack(stack),
            "modified": int(time.time()),
        })
        data["presets"] = presets
        self.save(data)
        return next((p for p in self.load()["presets"] if p.get("id") == pid), presets[-1])

    @db.atomic
    def rename(self, preset_id, group, new_name, stack=None):
        """Atomically rename/regroup a preset (addressed by id). The id is untouched, so
        a rename never breaks a link; duplicate names are allowed."""
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
        new_stack = self._normalize_stack(stack) if stack is not None else existing.get("stack", [])
        remaining = [preset for preset in presets if preset.get("id") != preset_id]
        remaining.append({
            "id": preset_id,
            "group": canonical_group(group),
            "name": new_name,
            "stack": new_stack,
            "modified": int(time.time()),
        })
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
        return next((preset for preset in self.load()["presets"] if preset.get("id") == preset_id), None)

    @db.atomic
    def delete(self, preset_id):
        preset_id = str(preset_id or "")
        data = self.load()
        before = len(data["presets"])
        data["presets"] = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        self.save(data)
        return len(data["presets"]) != before

    def _dedupe(self, presets):
        # Keyed by the stable id; group + name are mutable display attributes.
        deduped = {}
        for preset in presets:
            if not isinstance(preset, dict) or not preset.get("id") or not preset.get("name"):
                continue
            deduped[preset["id"]] = {
                "id": preset["id"],
                "group": canonical_group(preset.get("group")),
                "name": canonical_label(preset.get("name", "")),
                "stack": self._normalize_stack(preset.get("stack")),
                "modified": preset.get("modified") or int(time.time()),
            }
        return sorted(
            deduped.values(),
            key=lambda item: (item.get("group", "").lower(), item.get("name", "").lower()),
        )

    def _normalize_stack(self, entries):
        kept = [
            entry for entry in (entries if isinstance(entries, list) else [])
            if isinstance(entry, dict) and (entry.get("id") or entry.get("sha256"))
        ]
        ids = [entry.get("id") or entry.get("sha256") for entry in kept]
        if self.canonicalize:
            ids = canonical_ids(ids)
        out = []
        for entry, card_id in zip(kept, ids):
            normalized = dict(entry)
            normalized.pop("sha256", None)
            normalized["id"] = card_id
            out.append(normalized)
        return out
