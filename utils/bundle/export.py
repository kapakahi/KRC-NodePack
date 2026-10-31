"""Build a KRC bundle from chosen sections (UNIFIED_BUNDLE_GAMEPLAN.md stage 2).

The chosen sections are written in their registry order, each into its own folder.
With include_linked, presets that exported prompts link to (LoRA Loadout / kit presets)
come along even when their section wasn't chosen: that section is then written with only
those presets and marked ``linkedOnly`` in the manifest.
"""
import zipfile
from pathlib import Path

from .container import SectionArchive, write_bundle_marker
from .sections import all_sections


class BundleExportError(ValueError):
    """An export that can't run; the message is shown to the user."""


def export_bundle(destination, section_ids, selection=None, include_linked=True):
    """Write a bundle of ``section_ids`` to ``destination``. ``selection``:
    {section id: that section's subset}. -> the manifest's sections map."""
    selection = selection if isinstance(selection, dict) else {}
    by_id = {section.id: section for section in all_sections()}
    chosen = [section_id for section_id in dict.fromkeys(str(s) for s in section_ids or []) if section_id in by_id]
    unknown = [str(s) for s in section_ids or [] if str(s) not in by_id]
    if unknown:
        raise BundleExportError(f"Unknown section: {', '.join(unknown)}")
    if not chosen:
        raise BundleExportError("Choose at least one section to export.")

    manifest = {}
    links = {}
    with zipfile.ZipFile(Path(destination), "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for section in all_sections():
            if section.id not in chosen:
                continue
            result = section.export(SectionArchive(archive, section.id), selection.get(section.id))
            manifest[section.id] = {"counts": result.get("counts", {})}
            for target, ids in (result.get("links") or {}).items():
                links.setdefault(target, set()).update(ids)
        if include_linked:
            for section in all_sections():
                ids = links.get(section.id)
                if not ids or section.id in manifest:
                    continue
                result = section.export(SectionArchive(archive, section.id), {"ids": sorted(ids)})
                manifest[section.id] = {"counts": result.get("counts", {}), "linkedOnly": True}
        write_bundle_marker(archive, manifest)
    return manifest
