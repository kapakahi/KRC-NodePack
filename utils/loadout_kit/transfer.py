"""Loadout Kit KRC bundle sections (UNIFIED_BUNDLE_GAMEPLAN.md): one per kit,
"kit_presets/<kit id>" — that kit's presets (presets.json names its kit, so one kit's
presets can't land in another's store). Entries keep their ``card`` snapshots (missing
cards step 2b), so imported presets show real names even where the cards are missing.
"""

import json

from ..archive_guard import ArchiveGuardError, read_json_entry
from ..bundle.presets_plan import plan_presets
from ..bundle.sections import KIT_SECTION_PREFIX, Section
from .presets import is_reserved_preset_name

PRESETS_ARCHIVE_NAME = "presets.json"
FORMAT_VERSION = 1


def write_kit_presets_section(kit, archive, selection=None):
    """One kit's presets into ``archive`` (a zip or a bundle's SectionArchive): all, or
    ``{"ids": [...]}`` (the presets an exported prompt links to). -> {"counts", "links"}."""
    presets = kit.presets().load()["presets"]
    wanted = (selection or {}).get("ids")
    if wanted is not None:
        wanted = {str(preset_id) for preset_id in wanted}
        presets = [preset for preset in presets if preset.get("id") in wanted]
    payload = {"kit": kit.id, "formatVersion": FORMAT_VERSION, "presets": presets}
    archive.writestr(PRESETS_ARCHIVE_NAME, json.dumps(payload, indent=2, ensure_ascii=False))
    return {"counts": {"presets": len(presets)}, "links": {}}


def plan_kit_presets_section(kit, archive, mode, options, stager):
    """Plan a kit's presets import (merge adds new ids, overwrite replaces same ids)."""
    payload = read_json_entry(archive, PRESETS_ARCHIVE_NAME) if PRESETS_ARCHIVE_NAME in archive.namelist() else {}
    if not isinstance(payload, dict) or not isinstance(payload.get("presets", []), list):
        raise ArchiveGuardError(f"{KIT_SECTION_PREFIX}{kit.id}/presets.json is invalid")
    if payload.get("kit", kit.id) != kit.id:
        raise ArchiveGuardError(f"These presets are for {payload.get('kit')}, not {kit.id}")
    return plan_presets(kit.presets(), payload.get("presets", []), mode,
                        key=lambda preset: str(preset.get("id") or ""), required=("id", "name"),
                        reserved=is_reserved_preset_name)


def kit_presets_section(kit):
    """The KRC bundle section for one kit ("kit_presets/<kit id>")."""
    return Section(f"{KIT_SECTION_PREFIX}{kit.id}", f"{kit.label} presets",
                   lambda: len(kit.presets().load()["presets"]),
                   lambda archive, selection=None: write_kit_presets_section(kit, archive, selection),
                   lambda archive, mode, options, stager: plan_kit_presets_section(kit, archive, mode, options, stager),
                   # kit ids are ^[a-z][a-z0-9_]{1,47}$ (kit.py), so safe in the clause
                   slices=(("presets", f"kind = 'kit:{kit.id}'"),), stores=((f"presets:kit:{kit.id}", None),))
