"""
KRC shared — Civitai raw-response cache (layer 1).

Content-hash-keyed, durable, no network. Stores the untouched by-hash response (or a
not_found sentinel) so a given hash is fetched at most once — renames/moves/dupes all
share the entry. The per-model record (layer 2) is DERIVED from this via the merge;
this file never interprets the payload. Shared by both nodes (a hash is a hash).

The envelope carries schemaVersion + status. No TTL: a version's by-hash data is
effectively immutable, so only an explicit user force-refresh overwrites an entry (hit or
sentinel).

Storage: krc.db's ``civitai_cache`` table, one row per sha with the envelope verbatim
(KRC_SQLITE_GAMEPLAN.md stage 3). Before that it was one JSON file per sha in
``lora_loadout/civitai_cache/``, which the stage-3 import reads once.
"""
import time
from pathlib import Path

from ..db import library as library_db
from ..krc_paths import get_krc_node_dir

KRC_DIR_NAME = "lora_loadout"
CACHE_SUBDIR = "civitai_cache"
CACHE_SCHEMA_VERSION = 1
CIVITAI_BY_HASH_URL = "https://civitai.com/api/v1/model-versions/by-hash/{}"
_FALLBACK = Path(__file__).resolve().parents[2] / ".krc_user" / "default" / KRC_DIR_NAME


def legacy_cache_dir():
    """The pre-database cache folder (one <sha>.json per entry)."""
    return get_krc_node_dir(KRC_DIR_NAME, fallback=_FALLBACK) / CACHE_SUBDIR


def read_cache(sha256):
    """Return the cached envelope dict, or None if absent/unreadable."""
    if not sha256:
        return None
    return library_db.civitai_get(str(sha256).strip().lower())


def write_cache(sha256, status, response=None):
    """Persist a hit (with response) or a not_found sentinel. Returns the envelope."""
    sha = str(sha256).strip().lower()
    envelope = {
        "schemaVersion": CACHE_SCHEMA_VERSION,
        "sha256": sha,
        "source": "civitai/by-hash",
        "url": CIVITAI_BY_HASH_URL.format(sha),
        "fetchedAt": int(time.time() * 1000),
        "status": status,  # "hit" | "not_found"
        "response": response if status == "hit" else None,
    }
    library_db.civitai_put(sha, envelope)
    return envelope


def cached_ids():
    """Every sha with a cache entry (hit or not_found)."""
    return library_db.civitai_ids()


def not_found_entries():
    """{sha: fetchedAt ms} for every cached not_found sentinel — "checked, not on
    Civitai". Drives the browse list's civitaiNotFoundAt flag, so it stays derived from
    the cache (no record field). One indexed query; a hit envelope is never read."""
    return library_db.civitai_not_found()


def not_found_at(sha256):
    """fetchedAt ms of this sha's not_found sentinel, else 0 (a hit is never opened)."""
    if not sha256:
        return 0
    return library_db.civitai_not_found_at(str(sha256).strip().lower())
