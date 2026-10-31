"""
KRC NodePack WordBank — global preset store.

Named parameter-row presets, kept in krc.db (kind "wb" in the presets table) so they
survive across workflows instead of living in per-workflow node state. The old JSON file
(…/user/default/krc_nodes/word_bank/word_bank_presets.json) is read once by the stage-2
import (utils/db/importers.py). The banks themselves stay files (decision D6).

Record shape (id-primary, shared across all KRC preset stores):
    {"id": <hex>, "group": <group>, "name": <label>, "rows": [...], "modified": int}
Identity is the stable ``id``; ``group`` + ``name`` are mutable display attributes
(the reserved token ``none`` = ungrouped). There is no stored trigger. Mirrors the
LoRA Loadout PresetStore shape.
"""
import time
import uuid

from .db import presets as preset_db
from .db import connection as db
from .krc_paths import get_krc_node_dir
from .preset_naming import canonical_group, canonical_label, delete_store_group, rename_store_group, ungroup_store_group

PRESETS_FILENAME = "word_bank_presets.json"


def legacy_presets_path():
    return get_krc_node_dir("word_bank") / PRESETS_FILENAME


class WordBankPresetStore:
    def load(self):
        return {"presets": self._clean(preset_db.load_records(preset_db.WORD_BANK))}

    def save(self, data):
        payload = {
            "presets": self._clean(data.get("presets", []) if isinstance(data.get("presets"), list) else []),
            "modified": int(time.time()),
        }
        preset_db.save_records(preset_db.WORD_BANK, payload["presets"])
        return payload

    def upsert(self, group, name, rows):
        return self.upsert_by_id(None, group, name, rows)

    @db.atomic
    def upsert_by_id(self, preset_id, group, name, rows):
        """Create or overwrite a preset by stable id. group + name are display labels."""
        group = canonical_group(group)
        name = canonical_label(name)
        if not name:
            return None
        data = self.load()
        preset_id = (preset_id or "").strip()
        if not preset_id:
            existing = next(
                (p for p in data["presets"] if canonical_group(p.get("group")) == group and p.get("name") == name),
                None,
            )
            preset_id = existing.get("id") if existing else uuid.uuid4().hex
        presets = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        preset = {"id": preset_id, "group": group, "name": name, "rows": self._clean_rows(rows), "modified": int(time.time())}
        presets.append(preset)
        data["presets"] = presets
        self.save(data)
        return preset

    @db.atomic
    def rename(self, preset_id, group, new):
        preset_id = (preset_id or "").strip()
        group = canonical_group(group)
        new = canonical_label(new)
        if not preset_id or not new:
            return False
        data = self.load()
        target = next((preset for preset in data["presets"] if preset.get("id") == preset_id), None)
        if not target:
            return False
        if any(preset.get("id") != preset_id and canonical_group(preset.get("group")) == group and preset.get("name") == new
               for preset in data["presets"]):
            return False  # target group + name already taken
        target["group"] = group
        target["name"] = new
        target["modified"] = int(time.time())
        self.save(data)
        return True

    @db.atomic
    def rename_group(self, old, new):
        """Move every preset in group ``old`` to ``new`` (merging into an existing group).
        Refused, with the names, when one is already used in ``new`` (as rename() refuses)."""
        return rename_store_group(self, old, new, unique_names=True)

    @db.atomic
    def ungroup_group(self, group):
        """Move every preset in ``group`` to --none--; refused, with the names, when one is
        already used there."""
        return ungroup_store_group(self, group, unique_names=True)

    @db.atomic
    def delete_group(self, group):
        """Delete ``group`` and every preset in it, in one save."""
        return delete_store_group(self, group)

    @db.atomic
    def delete(self, preset_id):
        preset_id = (preset_id or "").strip()
        data = self.load()
        before = len(data["presets"])
        data["presets"] = [preset for preset in data["presets"] if preset.get("id") != preset_id]
        self.save(data)
        return len(data["presets"]) != before

    def _clean_rows(self, rows):
        out = []
        for row in rows if isinstance(rows, list) else []:
            if not isinstance(row, dict):
                continue
            out.append({
                "categoryId": str(row.get("categoryId", "")),
                "category": str(row.get("category", "")),
                "value": str(row.get("value", "")),
                "locked": bool(row.get("locked", False)),
            })
        return out

    def _clean(self, presets):
        deduped = {}
        for preset in presets:
            if not isinstance(preset, dict) or not preset.get("name"):
                continue
            preset_id = str(preset.get("id") or uuid.uuid4().hex)
            group = canonical_group(preset.get("group"))
            name = canonical_label(preset.get("name", ""))
            deduped[preset_id] = {
                "id": preset_id,
                "group": group,
                "name": name,
                "rows": self._clean_rows(preset.get("rows")),
                "modified": preset.get("modified") or int(time.time()),
            }
        return sorted(
            deduped.values(),
            key=lambda item: (item.get("group", "").lower(), item.get("name", "").lower()),
        )
