"""
KRC Model Library — map a HuggingFace model card into a GENERIC model record.

Reuses LoRA Loadout's pure card parsing (`parse_hf_repo`, `split_front_matter`) and the
egress client (`hf_client.fetch_model_card`); only the field mapping into the generic
model schema is Model-Library-specific. Mirrors the LoRA HF path minus the LoRA-only
bits (no trained words, no originalName — a repo holds many files, so its name is a
folder, not per-file identity).
"""
from pathlib import Path

from ..library.hf_map import HF_HOST, parse_hf_repo, split_front_matter  # noqa: F401
from ..library.source_import import normalize_tags


def merge_hf_into_model_record(path, library_id, existing, repo, card, model_type=None):
    """Overlay a HuggingFace model card onto a generic model record; write + return it."""
    from .metadata import (
        current_millis,
        normalize_model_metadata,
        read_model_metadata,
        write_model_metadata,
    )

    path = Path(path)
    existing = existing if isinstance(existing, dict) else {}
    now = current_millis()
    front, body = split_front_matter(card)
    author = repo.split("/", 1)[0]
    url = f"https://{HF_HOST}/{repo}"
    record_type = model_type or existing.get("modelType") or "other"

    merged = dict(existing)
    if body:
        merged["description"] = body

    # base_model may be a string or a list; take the first and keep the bare model name
    # (org/model -> model), matching the Civitai baseModel vocabulary.
    base = front.get("base_model")
    if isinstance(base, list):
        base = base[0] if base else ""
    if base:
        merged["baseModel"] = str(base).rsplit("/", 1)[-1].strip()

    tags = front.get("tags")
    if tags:
        merged["tags"] = normalize_tags(tags)

    license_val = front.get("license")
    if license_val:
        merged["license"] = str(license_val)

    creator = dict(merged.get("creator")) if isinstance(merged.get("creator"), dict) else {}
    creator["name"] = author
    creator["username"] = author
    merged["creator"] = creator

    merged["source"] = {"name": "HuggingFace", "url": url, "repo": repo}
    merged["metadataSource"] = "huggingface"
    merged["sourceImport"] = {
        "type": "huggingface",
        "repo": repo,
        "url": url,
        "importedAt": now,
    }
    merged["libraryId"] = library_id
    if existing.get("sha256"):
        merged["sha256"] = existing["sha256"]
    merged["modelType"] = record_type

    write_model_metadata(
        {
            "library_id": library_id,
            "relative_path": existing.get("file") or path.name,
            "filename": path.name,
            "path": str(path),
        },
        merged,
    )
    return normalize_model_metadata(path, library_id, read_model_metadata(library_id, record_type))
