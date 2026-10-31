"""Config Switcher preset schema version.

Every saved preset carries ``schema`` (CS_SCHEMA_VERSION). Bump it by .1 whenever the field
vocabulary or a preset's shape changes (a new parameter type, a new field key), and keep
CS_SCHEMA_VERSION in web/js/config_switcher/config.js the same. Versions compare as
(major, minor) numbers, so "1.10" is newer than "1.9".

What it guards: code reading a preset written by newer code. Older code doesn't know a new
parameter type, so cleaning would rewrite or drop it. Instead:
- a save from a page whose version differs from the server's is refused (a stale server
  after an update, or a stale tab);
- a stored preset newer than this server is kept exactly as stored and can't be saved over;
- a bundle preset newer than this pack, or older than CS_SCHEMA_MIN, is skipped on import.
A preset without ``schema`` predates versioning and reads as "1.0". Older presets load as
they are (no migrations); raise CS_SCHEMA_MIN only when old presets stop being valid.
"""

CS_SCHEMA_VERSION = "1.6"
CS_SCHEMA_MIN = "1.0"
UNVERSIONED = "1.0"


def parse_schema(value):
    """"1.5" -> (1, 5); None when it isn't "<major>.<minor>"."""
    parts = str(value or "").strip().split(".")
    if len(parts) != 2 or not all(part.isdigit() for part in parts):
        return None
    return int(parts[0]), int(parts[1])


def preset_schema(preset):
    """A preset's (major, minor); unversioned presets are 1.0, unreadable ones None."""
    raw = preset.get("schema") if isinstance(preset, dict) else None
    return parse_schema(UNVERSIONED if raw in (None, "") else raw)


def is_newer(preset):
    """Written by newer code than this server (an unreadable version counts as newer)."""
    version = preset_schema(preset)
    return version is None or version > parse_schema(CS_SCHEMA_VERSION)


def import_skip_reason(preset):
    """Why a bundle preset can't be imported here, else None."""
    if is_newer(preset):
        return "from a newer KRC NodePack"
    if preset_schema(preset) < parse_schema(CS_SCHEMA_MIN):
        return "too old to import"
    return None


def save_problem(page_schema):
    """Why a save from a page at ``page_schema`` is refused, else None."""
    page = parse_schema(page_schema)
    server = parse_schema(CS_SCHEMA_VERSION)
    if page == server:
        return None
    if page is not None and page > server:
        return (f"This page is newer than the ComfyUI server (presets {page_schema} vs {CS_SCHEMA_VERSION}). "
                "Restart ComfyUI to load the update, then save again.")
    return (f"This page is older than the ComfyUI server (presets {page_schema or 'unversioned'} vs "
            f"{CS_SCHEMA_VERSION}). Reload the page, then save again.")


def stored_newer_problem(preset):
    return (f"This preset was saved by a newer KRC NodePack (presets {preset.get('schema')} vs "
            f"{CS_SCHEMA_VERSION}). Update KRC NodePack to change it.")
