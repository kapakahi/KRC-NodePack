"""
KRC LoRA Loadout — Civitai batch fetch: targets (eligibility + scope).

Which LoRAs a "fill missing" batch fetch will touch, and why the rest are skipped.
Spec: CIVITAI_BATCH_FETCH_GAMEPLAN.md §2. The same predicate backs the page's pre-run
preview (GET …/civitai/batch/targets) and the job (step 4), which re-evaluates it per
item at run time.

Pure helpers first (unit-tested off the runtime: tests/civitai_batch_check.py in
KRC-NodePack-dev); the one I/O function, build_targets_preview, reads the index, file sizes, and the Civitai
cache directory listing — no network, no hashing.
"""
import os

from .identity import is_local_library_id

# Records that already carry metadata from a real source. Manual ("krc") records are
# NOT here — they're targets; the fill merge protects the fields the user set.
SOURCED_SKIP = ("civitai", "huggingface")

# Skip reasons, in display order.
SKIP_REASONS = ("civitai", "huggingface", "blanked", "not_found_cached")


def _sidecar(record):
    sidecar = record.get("sidecar_data") if isinstance(record, dict) else None
    return sidecar if isinstance(sidecar, dict) else {}


def normalize_folder(folder):
    """Forward-slash folder path ("" = root). The index builds `folder` with
    str(Path(...)), which is backslash-separated on a Windows server."""
    return str(folder or "").replace("\\", "/").strip("/")


def record_folder(record):
    """The LoRA's folder relative to its root ("" = root), normalized."""
    return normalize_folder((record or {}).get("folder"))


def in_scope(folder, scope_folder, *, subfolders=False):
    """Whole library when scope_folder is None; otherwise the exact folder, plus its
    descendants when subfolders is on. "" is the root folder."""
    if scope_folder is None:
        return True
    folder = normalize_folder(folder)
    scope_folder = normalize_folder(scope_folder)
    if folder == scope_folder:
        return True
    if not subfolders:
        return False
    if scope_folder == "":
        return True  # every folder is under the root
    return folder.startswith(scope_folder + "/")


def classify(record, *, not_found_ids=frozenset()):
    """("target", None) or ("skip", reason) for one index record."""
    sidecar = _sidecar(record)
    source = str(sidecar.get("metadataSource") or "")
    if source in SOURCED_SKIP:
        return "skip", source
    if sidecar.get("userBlanked"):
        return "skip", "blanked"
    library_id = str(record.get("library_id") or "").lower()
    if library_id and not is_local_library_id(library_id) and library_id in not_found_ids:
        return "skip", "not_found_cached"
    return "target", None


def plan_targets(records, scope_folder=None, *, subfolders=False, not_found_ids=frozenset(), size_of=None):
    """Classify every in-scope record.

    Returns {"targets": [record, …], "hashed": n, "unhashed": n, "unhashedBytes": n,
    "skipped": {reason: n}}. `size_of(record)` supplies a file size (bytes) for
    unhashed targets — those are the ones a run must read in full to hash."""
    targets = []
    skipped = {reason: 0 for reason in SKIP_REASONS}
    hashed = unhashed = unhashed_bytes = 0
    for record in records:
        if not in_scope(record_folder(record), scope_folder, subfolders=subfolders):
            continue
        verdict, reason = classify(record, not_found_ids=not_found_ids)
        if verdict == "skip":
            skipped[reason] = skipped.get(reason, 0) + 1
            continue
        targets.append(record)
        if is_local_library_id(record.get("library_id")):
            unhashed += 1
            unhashed_bytes += int(size_of(record) if size_of else 0)
        else:
            hashed += 1
    return {
        "targets": targets,
        "hashed": hashed,
        "unhashed": unhashed,
        "unhashedBytes": unhashed_bytes,
        "skipped": skipped,
    }


def folder_counts(records):
    """[{name, count}] of every LoRA folder that holds files directly, sorted by path."""
    counts = {}
    for record in records:
        folder = record_folder(record)
        counts[folder] = counts.get(folder, 0) + 1
    return [{"name": name, "count": counts[name]} for name in sorted(counts, key=str.lower)]


# ── I/O ─────────────────────────────────────────────────────────────────────────

def _file_size(record):
    try:
        return os.stat(record.get("path") or "").st_size
    except (OSError, TypeError, ValueError):
        return 0


def cached_not_found_ids(candidate_ids):
    """The subset of candidate content-sha ids whose Civitai cache entry is a
    not_found sentinel. Lists the cache dir once and only opens entries that exist
    for a candidate (hit envelopes can be large)."""
    from ..library.civitai_cache import cached_ids, read_cache

    present = cached_ids()
    found = set()
    for library_id in candidate_ids:
        if library_id in present:
            envelope = read_cache(library_id)
            if envelope and envelope.get("status") == "not_found":
                found.add(library_id)
    return frozenset(found)


def target_order(record):
    """Run order: already-hashed targets first (quick lookups show progress at once),
    then the ones that must be read in full; by folder + name within each."""
    return (
        is_local_library_id(record.get("library_id")),
        record_folder(record).lower(),
        str(record.get("display_name") or record.get("filename") or "").lower(),
    )


def record_size(record):
    return _file_size(record)


def collect_targets(scope_folder=None, *, subfolders=False, selected_ids=None):
    """(records, plan) for a scope — the ONE planning path shared by the preview and
    the job, so what the page promised is what runs. plan["targets"] is in run order.
    Blocking (index walk on a cold cache, one stat per unhashed target) — off the loop."""
    from .library_index import LoraLibraryIndex

    index = LoraLibraryIndex()
    records = list(index.refresh().values())
    if selected_ids is not None:
        from ..bulk_selection import validate_card_ids
        selected = set(validate_card_ids(selected_ids))
        records = [record for record in records if record.get("library_id") in selected]
        if {record.get("library_id") for record in records} != selected:
            raise ValueError("A selected LoRA no longer exists. Refresh and select again.")
    stable_ids = [
        str(record.get("library_id") or "").lower()
        for record in records
        if record.get("library_id") and not is_local_library_id(record.get("library_id"))
    ]
    plan = plan_targets(
        records,
        scope_folder,
        subfolders=subfolders,
        not_found_ids=cached_not_found_ids(stable_ids),
        size_of=_file_size,
    )
    plan["targets"].sort(key=target_order)
    return records, plan


def build_targets_preview(scope_folder=None, *, subfolders=False):
    """The pre-run preview for the page: folders + target/skip breakdown."""
    records, plan = collect_targets(scope_folder, subfolders=subfolders)
    return {
        "folders": folder_counts(records),
        "preview": {
            "count": len(plan["targets"]),
            "hashed": plan["hashed"],
            "unhashed": plan["unhashed"],
            "unhashedBytes": plan["unhashedBytes"],
            "skipped": plan["skipped"],
        },
    }
