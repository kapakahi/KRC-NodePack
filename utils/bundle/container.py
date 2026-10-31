"""The KRC bundle's container: its marker and each section's folder.

A bundle is one zip: ``krc_archive.json`` (archiveType "krc_bundle", with a ``sections``
map: id -> {counts, linkedOnly?, ...}) and one folder per section holding that section's
files in the layout its node always used. A section's writer and reader see only their
own folder through SectionArchive, so the per-node code is unchanged inside it.
"""
from ..archive_guard import MAX_JSON_ENTRY_BYTES, read_json_entry, write_archive_marker

ARCHIVE_TYPE = "krc_bundle"
BUNDLE_VERSION = 1


class SectionArchive:
    """A zip seen from one section's folder: names are relative to ``<section id>/``.
    Wraps an open zipfile.ZipFile for writing (writestr / write) or reading (namelist /
    read / open / getinfo / infolist)."""

    def __init__(self, archive, section_id):
        self.archive = archive
        self.prefix = f"{section_id}/"

    def _name(self, name):
        name = str(name)
        if name.startswith("/") or ".." in name.split("/"):
            raise ValueError(f"Bad name in a bundle section: {name}")
        return f"{self.prefix}{name}"

    # -- writing
    def writestr(self, name, data):
        self.archive.writestr(self._name(name), data)

    def write(self, path, name):
        self.archive.write(path, self._name(name))

    # -- reading
    def namelist(self):
        return [name[len(self.prefix):] for name in self.archive.namelist()
                if name.startswith(self.prefix) and len(name) > len(self.prefix)]

    def infolist(self):
        return [info for info in self.archive.infolist() if info.filename.startswith(self.prefix)]

    def getinfo(self, name):
        return self.archive.getinfo(self._name(name))

    def read(self, name):
        return self.archive.read(self._name(name))

    def open(self, name, mode="r"):
        return self.archive.open(self._name(name), mode)

    def read_json(self, name, max_bytes=MAX_JSON_ENTRY_BYTES):
        """One JSON file of the section, size-checked before it's read (ArchiveGuardError
        when it's over ``max_bytes``; KeyError when it's missing)."""
        return read_json_entry(self.archive, self._name(name), max_bytes)


def write_bundle_marker(archive, sections):
    """The marker for a bundle holding ``sections`` ({id: {counts, ...}})."""
    return write_archive_marker(
        archive,
        ARCHIVE_TYPE,
        content_dirs=list(sections),
        versions={"bundle": BUNDLE_VERSION},
        extra={"sections": sections},
    )
