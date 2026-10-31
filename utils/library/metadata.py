"""Shared metadata primitives for KRC library nodes.

The full normalize/default *bodies* diverge by field set (LoRA schema vs generic
model schema) — that divergence is real, so each node keeps its own
``normalize_*`` / ``default_*`` that names its own fields. What is byte-identical
across the two lineages is the plumbing below: id/hash helpers, version
stamping, type coercion, and the write-time modified-bump rule. These make the
shared conventions in KRC_MODEL_METADATA_SCHEMA.md executable, and the KRC Editor
can consume the same primitives instead of re-deriving them.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (stage B3).
"""

import hashlib
from pathlib import Path

from .identity import (  # noqa: F401  (single source, re-exported)
    current_millis,
    file_birth_or_mtime,
    is_local_library_id,
)


# Fields that never count toward "did the content change" — location/version
# bookkeeping that a routine rescan rewrites without it being a real edit.
DEFAULT_VOLATILE_FIELDS = ("modified", "path", "file")

# User-metadata toggles that must NOT bump `modified` on their own: favoriting, rating,
# NSFW tagging, a custom badge, and a card color are organizing/tagging actions, not
# content edits. Like the volatile fields, they are excluded from the change comparison
# — so toggling one leaves the modified date untouched, while any real edit alongside it
# still re-stamps.
QUICK_META_FIELDS = ("favorite", "pinned", "rating", "nsfw", "customBadge", "cardColor")


# Deferred-detail wire contract (INFO_PANEL_RECORD_CONTRACT_GAMEPLAN.md step 2). A browser-
# list row omits heavy text + detail-only fields and sets these flags when that content
# exists; the frontend InfoPanel engine reads them to trigger the /detail read-through. Every
# list-mode serializer for a deferrable lineage MUST emit all three keys — build them through
# deferred_detail_flags() below so a serializer can't ship a renamed/partial set (the dead
# `deferDetails` key that blanked Model Library / Portal LoRA panels). The JS twin is
# DEFERRED_DETAIL_FLAGS in web/js/shared/metadata_fields.js; keep the two lists identical.
DEFERRED_DETAIL_FLAGS = ("descriptionDeferred", "examplePromptsDeferred", "detailFieldsDeferred")


def deferred_detail_flags(*, description_deferred, example_prompts_deferred, detail_fields_deferred):
    """Return the complete deferred-detail flag dict from the three already-computed booleans.
    Building the flags through this one helper guarantees all of DEFERRED_DETAIL_FLAGS are
    present under their canonical names — the contract the frontend gate depends on. (The
    per-lineage *conditions* that produce the booleans stay in each serializer; only the key
    names + completeness are locked here.)"""
    flags = {
        "descriptionDeferred": bool(description_deferred),
        "examplePromptsDeferred": bool(example_prompts_deferred),
        "detailFieldsDeferred": bool(detail_fields_deferred),
    }
    # Guard against a future key rename drifting off the contract silently.
    assert set(flags) == set(DEFERRED_DETAIL_FLAGS), "deferred-detail flag set drifted"
    return flags


def safe_id(value):
    return "".join(char if char.isalnum() or char in ("-", "_") else "_" for char in str(value))


def make_library_id(path, root=None):
    """Path-derived id: ``local-<sha256(identity)[:24]>``. ``identity`` is the path
    relative to ``root`` when given, else the absolute path. One id scheme for both
    record kinds before content-SHA stabilization."""
    path = Path(path)
    if root:
        try:
            identity = str(path.relative_to(root))
        except ValueError:
            identity = str(path)
    else:
        identity = str(path)
    digest = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]
    return f"local-{digest}"


def as_int(value, default):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_number(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def primary_file_size_bytes(primary_file):
    """Return a canonical byte count from current or legacy primaryFile keys.

    Civitai reports sizeKB and older records used a plain size. The schema-level
    field is sizeBytes, so normalize both through one point.
    """
    if not isinstance(primary_file, dict):
        return 0
    value = _as_number(primary_file.get("sizeBytes"))
    if value is not None and value > 0:
        return int(value)
    value = _as_number(primary_file.get("size"))
    if value is not None and value > 0:
        return int(value)
    value = _as_number(primary_file.get("sizeKB"))
    if value is not None and value > 0:
        return int(value * 1024)
    return 0


def normalize_primary_file(primary_file):
    """Coerce primaryFile to an object with sizeBytes as the canonical size key."""
    normalized = dict(primary_file) if isinstance(primary_file, dict) else {}
    normalized["sizeBytes"] = primary_file_size_bytes(normalized)
    normalized.pop("size", None)
    normalized.pop("sizeKB", None)
    return normalized


def stamp_versions(metadata, version_fields):
    """Return a copy of ``metadata`` with each version field filled if absent.
    Existing (truthy) values win, so an older record keeps its born-at stamps."""
    stamped = dict(metadata or {})
    for key, value in version_fields.items():
        stamped[key] = stamped.get(key) or value
    return stamped


def coerce_fields(record, *, strings=(), bools=(), objects=(), lists=()):
    """In-place: force each named field to its declared shape (missing/None/wrong
    type -> the type's empty value). Mutates and returns ``record``."""
    for field in strings:
        value = record.get(field)
        record[field] = value if isinstance(value, str) else ("" if value is None else str(value))
    for field in bools:
        record[field] = bool(record.get(field, False))
    for field in objects:
        value = record.get(field)
        record[field] = value if isinstance(value, dict) else {}
    for field in lists:
        value = record.get(field)
        record[field] = value if isinstance(value, list) else []
    return record


# Inert future-proof verification object (schema doc §3), shared by BOTH lineages so a
# model and a LoRA carry the identical shape. Persisted and exported, never UI-exposed
# until KRC ships a real verify feature.
VERIFICATION_DEFAULT = {
    "status": "unknown",
    "checkedAt": 0,
    # scannedAt: the provider's OWN scan/verification date (Civitai file scannedAt, an
    # ISO-8601 string), distinct from checkedAt (when WE ran the by-hash check). "" when
    # the provider gives none (manual, or absent in the response).
    "scannedAt": "",
    "provider": "",
    "hash": "",
    "resultUrl": "",
    "notes": "",
}


def coerce_verification(value):
    """Merge a stored verification object onto VERIFICATION_DEFAULT: keep only the
    recognized keys, default-fill the rest. Returns a fresh dict."""
    merged = dict(VERIFICATION_DEFAULT)
    if isinstance(value, dict):
        for key in VERIFICATION_DEFAULT:
            if key in value and value[key] is not None:
                merged[key] = value[key]
    return merged


def apply_imported_dates(payload, dates):
    """After the write rule: a history-keeping bundle import's (krcFirstSeen, modified)
    win (utils/library/archive.imported_dates). A None keeps the rule's value."""
    first_seen, modified = dates or (None, None)
    if first_seen:
        payload["krcFirstSeen"] = first_seen
    if modified:
        payload["modified"] = modified
    return payload


def apply_modified_write_rule(payload, existing, volatile=DEFAULT_VOLATILE_FIELDS):
    """In-place write-time rule shared by both lineages:

    - ``krcFirstSeen`` is stamped once and preserved (the stored value wins so a
      regenerated payload can't reset it).
    - ``modified`` bumps only when non-volatile content actually changed, so the
      date-modified sort reflects real edits rather than routine rescans. The
      quick-metadata toggles in ``QUICK_META_FIELDS`` (favorite / nsfw / customBadge /
      cardColor) are excluded too, so tagging or coloring a record never re-dates it.
    """
    payload["krcFirstSeen"] = (
        existing.get("krcFirstSeen")
        or payload.get("krcFirstSeen")
        or existing.get("modified")
        or current_millis()
    )
    excluded = set(volatile) | set(QUICK_META_FIELDS)
    unchanged = bool(existing) and (
        {k: v for k, v in payload.items() if k not in excluded}
        == {k: v for k, v in existing.items() if k not in excluded}
    )
    payload["modified"] = existing.get("modified") if unchanged else current_millis()
    return payload
