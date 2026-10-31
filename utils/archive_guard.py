import json
import time


ARCHIVE_MARKER_NAME = "krc_archive.json"
APP_NAME = "KRC NodePack"
SCHEMA_VERSION = 1
# Which product wrote this bundle. Advisory provenance ONLY — never a validation
# gate (validate_archive_marker must not branch on it), so a bundle still imports
# across the node and the editor. Its use is support forensics + informing lenient
# import normalization. The editor stamps "KRC Editor" from its own copy of this.
EXPORTED_FROM = "KRC NodePack"

# Ceilings for a trusted-but-unverified bundle (someone shared a zip). These are
# generous for any legitimate library/preset/thumbnail set while stopping a
# "zip bomb" — a tiny archive that decompresses to gigabytes — from OOMing the
# ComfyUI process. Checked against the declared uncompressed sizes before any
# entry is read into memory.
MAX_TOTAL_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024  # 2 GiB
MAX_ENTRY_UNCOMPRESSED_BYTES = 512 * 1024 * 1024       # 512 MiB per file
MAX_ENTRY_COUNT = 100_000
# A single entry claiming to compress by more than this is treated as hostile.
MAX_COMPRESSION_RATIO = 1000
# A bundle's JSON (metadata, presets, manifests) is parsed whole, and parsing takes several
# times the file's size in memory: far below the media cap, still far above any real library.
MAX_JSON_ENTRY_BYTES = 128 * 1024 * 1024  # 128 MiB


class ArchiveGuardError(ValueError):
    pass


def guard_archive_size(
    archive,
    max_total=MAX_TOTAL_UNCOMPRESSED_BYTES,
    max_entry=MAX_ENTRY_UNCOMPRESSED_BYTES,
    max_entries=MAX_ENTRY_COUNT,
):
    """Reject decompression bombs before reading any entry. Inspects the zip
    directory's declared sizes (cheap, no decompression) and raises
    ArchiveGuardError if the archive is implausibly large or over-compressed.
    Call once, right after opening the archive."""
    infos = archive.infolist()
    if len(infos) > max_entries:
        raise ArchiveGuardError("Archive has too many entries")

    total = 0
    for info in infos:
        size = info.file_size
        if size > max_entry:
            raise ArchiveGuardError("Archive entry is too large")
        # A near-empty compressed size expanding to a huge file is the bomb
        # signature; a legitimate file never claims a 1000:1 ratio.
        if info.compress_size and size / info.compress_size > MAX_COMPRESSION_RATIO:
            raise ArchiveGuardError("Archive entry is over-compressed")
        total += size
        if total > max_total:
            raise ArchiveGuardError("Archive is too large")


def read_json_entry(archive, name, max_bytes=MAX_JSON_ENTRY_BYTES):
    """Parse one JSON file from the archive, refusing (ArchiveGuardError) one whose declared
    size is over ``max_bytes`` before reading it. KeyError when it's missing."""
    if archive.getinfo(name).file_size > max_bytes:
        raise ArchiveGuardError(f"{name} in the archive is too large")
    return json.loads(archive.read(name).decode("utf-8"))


def write_archive_marker(archive, archive_type, required_files=None, content_dirs=None, versions=None, extra=None):
    marker = {
        "app": APP_NAME,
        "exportedFrom": EXPORTED_FROM,
        "archiveType": archive_type,
        "schemaVersion": SCHEMA_VERSION,
        "requiredFiles": list(required_files or []),
        "contentDirs": list(content_dirs or []),
        "createdAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    if versions:
        marker["versions"] = dict(versions)
    if extra:
        marker.update({key: value for key, value in extra.items() if key not in marker})
    archive.writestr(ARCHIVE_MARKER_NAME, json.dumps(marker, indent=2, ensure_ascii=False))
    return marker


def validate_archive_marker(archive, expected_type, required_files=None):
    names = set(archive.namelist())
    if ARCHIVE_MARKER_NAME not in names:
        raise ArchiveGuardError("Archive is missing krc_archive.json")

    try:
        marker = read_json_entry(archive, ARCHIVE_MARKER_NAME)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ArchiveGuardError("Archive marker is not valid JSON")

    if not isinstance(marker, dict):
        raise ArchiveGuardError("Archive marker is invalid")
    if marker.get("app") != APP_NAME:
        raise ArchiveGuardError("Archive is not a KRC NodePack archive")
    if marker.get("archiveType") != expected_type:
        found = marker.get("archiveType") or "unknown"
        raise ArchiveGuardError(f"Archive is for {found}, not {expected_type}")
    if marker.get("schemaVersion") != SCHEMA_VERSION:
        raise ArchiveGuardError("Archive schema version is not supported")

    for name in required_files or []:
        if name not in names:
            raise ArchiveGuardError(f"Archive is missing {name}")

    return marker
