"""KRC bundle sections for KRC packs (public API 1.13, PUBLIC_API_PACKS_GAMEPLAN.md stage 4).

``register_bundle_section(pack_id, name, ...)`` gives a KRC pack's data a section of the KRC
bundle ("pack/<pack id>__<name>"): it lists, exports, previews, imports and undoes like
NodePack's own. Packs have no krc.db access, so a pack section's data is files under its
own data folder (``data_dir``, inside KRC's data root, e.g. get_krc_node_dir(...)):

  export(archive, selection) -> {"counts": {...}}   writes into its folder of the bundle
  plan(archive, mode, options, files) -> summary     decides the import, writing nothing
                                                     itself: every change goes through
                                                     ``files`` (PackFiles below)

``files.put(path, data)`` / ``files.remove(path)`` stage changes for paths inside
``data_dir`` only (anything else raises PackFilesError); they land after the import's
transaction commits, and Undo last import saves what they replace and removes what they
add. So a pack section is all-or-nothing and undoable with no extra code. A section is
listed only while its pack is allowlisted and loaded.
"""
import re
from pathlib import Path

from ..krc_paths import get_krc_nodes_dir
from .sections import ImportPlan, Section, plan_summary, register_pack_section

PACK_SECTION_PREFIX = "pack/"
_NAME_RE = re.compile(r"^[a-z][a-z0-9]{0,31}$")


class PackFilesError(ValueError):
    """A pack section tried to touch a file outside its own data folder."""


class PackFiles:
    """A pack section's view of the import's stager, confined to its data folder."""

    def __init__(self, stager, root):
        self.root = Path(root).resolve()
        self._stager = stager

    def _inside(self, path):
        resolved = Path(path).resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise PackFilesError(f"{path} is outside the pack's data folder")
        return resolved

    def put(self, path, data):
        """Write ``data`` (bytes or str) to ``path`` once the import lands."""
        data = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        self._stager.stage_bytes(data, self._inside(path))

    def remove(self, path):
        """Delete ``path`` once the import lands."""
        self._stager.remove(self._inside(path))

    def will_exist(self, path):
        return self._stager.will_exist(self._inside(path))


def _summary(raw):
    raw = raw if isinstance(raw, dict) else {}
    reasons = raw.get("reasons") if isinstance(raw.get("reasons"), dict) else {}
    return plan_summary(int(raw.get("added") or 0), int(raw.get("updated") or 0), int(raw.get("unchanged") or 0),
                        {str(key): int(value or 0) for key, value in reasons.items()})


def register_bundle_section(pack_id, name, *, label, count, export, plan, data_dir):
    """Give KRC pack ``pack_id``'s data a KRC bundle section (see the module docstring).
    ``name``: lowercase letters and digits, unique within the pack. -> the section id."""
    from ..krc_packs import KRC_PACK_ALLOWLIST
    pack_id, name = str(pack_id or ""), str(name or "")
    if pack_id not in KRC_PACK_ALLOWLIST:
        raise ValueError(f"register_bundle_section: {pack_id!r} isn't a KRC pack NodePack knows")
    if not _NAME_RE.match(name):
        raise ValueError("register_bundle_section: name must be lowercase letters and digits (up to 32)")
    root = Path(data_dir).resolve()
    data_root = Path(get_krc_nodes_dir()).resolve()
    if root == data_root or data_root not in root.parents:
        raise ValueError("register_bundle_section: data_dir must be a folder inside KRC's data folder")
    section_id = f"{PACK_SECTION_PREFIX}{pack_id}__{name}"

    def section_plan(archive, mode, options, stager):
        summary = _summary(plan(archive, mode, dict(options), PackFiles(stager, root)))
        return ImportPlan(summary, lambda: {"added": summary["added"], "updated": summary["updated"]})

    register_pack_section(pack_id, Section(section_id, str(label or name), count,
                                           lambda archive, selection=None: export(archive, selection), section_plan))
    return section_id
