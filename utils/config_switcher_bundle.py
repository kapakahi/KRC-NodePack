"""Config Switcher's KRC bundle section (UNIFIED_BUNDLE_GAMEPLAN.md):
"config_switcher_presets" — every Config Switcher preset (presets.json).

Import: merge adds presets whose id (else name) isn't here; overwrite also replaces the
same-key ones. The store cleans every preset on save (ids, groups, fields). Presets on a
schema this pack can't read (newer, or older than CS_SCHEMA_MIN) are skipped.
"""

import json

from .archive_guard import read_json_entry
from .bundle.presets_plan import incoming_presets, plan_presets
from .bundle.sections import Section
from .config_switcher_presets import ConfigSwitcherPresetStore
from .config_switcher_schema import import_skip_reason

PRESETS_ARCHIVE_NAME = "presets.json"


def write_presets_section(archive, selection=None):
    """Every Config Switcher preset into ``archive`` (a bundle's SectionArchive).
    -> {"counts", "links"}."""
    payload = ConfigSwitcherPresetStore().load()
    archive.writestr(PRESETS_ARCHIVE_NAME, json.dumps(payload, indent=2, ensure_ascii=False))
    return {"counts": {"presets": len(payload.get("presets", []))}, "links": {}}


def plan_presets_section(archive, mode, options, stager):
    payload = read_json_entry(archive, PRESETS_ARCHIVE_NAME) if PRESETS_ARCHIVE_NAME in archive.namelist() else {}
    return plan_presets(ConfigSwitcherPresetStore(), incoming_presets(payload), mode,
                        key=lambda preset: str(preset.get("id") or preset.get("name") or ""),
                        skip=import_skip_reason)


def bundle_sections():
    """This node's KRC bundle section (registered with its routes)."""
    return [Section("config_switcher_presets", "Config Switcher presets",
                    lambda: len(ConfigSwitcherPresetStore().load().get("presets", [])),
                    write_presets_section, plan_presets_section,
                    slices=(("presets", "kind = 'cs'"),), stores=(("presets:cs", None),))]
