"""Lightweight, best-effort usage ledger for KRC nodes.

Counts how often each LoRA / prompt is used. Deliberately a SEPARATE store from
the metadata sidecars: incrementing a count must never bump a record's
``modified`` date, trip its Stale/SYNC badge, or trigger a library reload. It is
silent bookkeeping, so it lives in its own file and is joined in only on read.

Everything is counted once **per workflow run** (per queued prompt), cached runs
included:
- **prompts** — from the Prompt Vault node's ``on_prompt`` hook;
- **loras** / **models** (and kit prompt slots) — by ``run_usage.py``: the hook counts
  what each node emitted last time, and a node that executes corrects it to what it
  really emitted (a preset trigger can change it mid-run).

Design notes:
- Keyed by whatever id the caller already holds (the LoRA's canonical
  ``library_id``; the prompt's ``category/name`` key), so the read-side join in
  the browser routes matches without any extra lookup.
- Everything lives in krc.db's ``usage`` table (KRC_SQLITE_GAMEPLAN.md stages 1 + 3).
  **prompts** are keyed by the prompt's record id so a rename keeps its history; the
  functions below hand them to ``utils/prompt_vault_store.py`` and callers still use
  category/name keys. **loras** / **models** are keyed by library id, as before.
  ``usage_stats.json`` is only read by the one-time import (``read_json_section``).
- Every operation is best-effort: a failed read/write never propagates, so a
  workflow run can never fail because the counter could not be persisted.
- Two fields per id are enough for the browser's future sort modes:
  ``count`` (Most Used) and ``lastUsedMs`` (Last Used).
"""

import json
import time

from ..db import library as library_db
from ..krc_paths import get_krc_nodes_dir

USAGE_FILENAME = "usage_stats.json"
# Top-level sections keep the LoRA sha id-space, the generic-model sha id-space (fed by
# Config Switcher) and the prompt category/name id-space from colliding in one flat map.
VALID_KINDS = ("loras", "models", "prompts")

def _usage_path():
    return get_krc_nodes_dir() / USAGE_FILENAME


def _load(path):
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def _dedupe(ids):
    keys = []
    seen = set()
    for raw in ids or []:
        key = str(raw or "").strip()
        if key and key not in seen:
            seen.add(key)
            keys.append(key)
    return keys


def read_json_section(kind):
    """One section of the pre-database usage_stats.json (the one-time import's source)."""
    section = _load(_usage_path()).get(kind)
    return section if isinstance(section, dict) else {}


def _prompt_store():
    from .. import prompt_vault_store

    return prompt_vault_store


def bump_usage(kind, ids):
    """Increment the run count (and stamp lastUsedMs) for each id in one section.

    Deduped per call so an id referenced twice in one call counts once. Silent on
    any failure — the caller runs inside a queue/execution path and must not fail
    on bookkeeping. -> {id: {"count", "lastUsedMs"}} new totals for the bumped ids
    ({} when nothing was written), so a caller can push them to open pages.
    """
    if kind not in VALID_KINDS:
        return {}
    keys = _dedupe(ids)
    if not keys:
        return {}
    try:
        if kind == "prompts":
            return _prompt_store().bump_prompt_usage(keys)
        return library_db.usage_bump(kind, keys, int(time.time() * 1000))
    except Exception:  # noqa: BLE001 - bookkeeping never fails a run
        return {}


def load_usage_section(kind):
    """Return the whole {id: {count, lastUsedMs}} map for one section (read-join).

    Load once per browser request and look ids up in a loop, rather than querying
    per card.
    """
    if kind not in VALID_KINDS:
        return {}
    try:
        if kind == "prompts":
            return _prompt_store().prompt_usage_by_key()
        return library_db.usage_load(kind)
    except Exception:  # noqa: BLE001
        return {}


def decrement_usage(kind, ids):
    """Take one run back from each id (never below 0; lastUsedMs kept): the per-run
    counter's correction when a node turned out not to use something it was counted for
    (utils/library/run_usage.py). Best-effort. -> {id: {"count", "lastUsedMs"}} new totals."""
    if kind not in VALID_KINDS:
        return {}
    keys = _dedupe(ids)
    if not keys:
        return {}
    try:
        section = load_usage_section(kind)
        entries = {}
        for key in keys:
            stats = section.get(key)
            if not isinstance(stats, dict):
                continue
            entries[key] = {
                "count": max(0, int(stats.get("count") or 0) - 1),
                "lastUsedMs": int(stats.get("lastUsedMs") or 0),
            }
        if entries:
            set_usage(kind, entries)
        return entries
    except Exception:  # noqa: BLE001
        return {}


def set_usage(kind, entries):
    """Write several ids' usage at once: {id: {"count", "lastUsedMs"}} sets an entry,
    {id: None} removes it. Used by a bundle import to carry usage over (or clear it).
    Best-effort like bump_usage. -> number of ids set."""
    if kind not in VALID_KINDS or not entries:
        return 0
    try:
        if kind == "prompts":
            return _prompt_store().set_prompt_usage(entries)
        return library_db.usage_set(kind, entries)
    except Exception:  # noqa: BLE001
        return 0
