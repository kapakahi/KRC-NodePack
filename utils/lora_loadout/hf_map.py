"""
KRC LoRA Loadout — map a HuggingFace repo (model card) into a KRC record.

Thin and identity-focused (see HF_METADATA_DESIGN.md). Tier 1:
  card body (front-matter stripped) -> description
  front-matter base_model            -> baseModel (raw repo path)
  front-matter instance_prompt       -> trainedWords (trigger word)
  front-matter tags                  -> tags
  front-matter license               -> usage.license
  repo first segment (author)        -> creator.username
  repo URL                           -> originUrl + sourceImport provenance

originalName is deliberately NOT set from the repo: one HF repo commonly holds many
LoRA files, so the repo name is not per-file identity — display falls back to the
safetensors filename instead.

The front-matter is a documented, structured key:value block — reading it is not
"parsing the card"; only the prose body reaches Description, verbatim. No image scraping.
"""
from pathlib import Path

from ..library.hf_map import (  # noqa: F401  (re-exported for call sites)
    HF_HOST,
    parse_hf_repo,
    split_front_matter,
)


def merge_hf_into_record(path, library_id, existing, repo, card):
    """Overlay a HuggingFace model card onto an existing record; write + return it."""
    from .metadata import (
        current_millis,
        normalize_krc_metadata,
        read_krc_metadata,
        write_krc_metadata,
    )
    from .source_import import normalize_tags, normalize_words

    path = Path(path)
    existing = existing if isinstance(existing, dict) else {}
    now = current_millis()
    front, body = split_front_matter(card)
    author = repo.split("/", 1)[0]
    url = f"https://{HF_HOST}/{repo}"

    merged = dict(existing)
    merged["description"] = body
    # NB: do NOT set originalName from the repo name. A single HuggingFace repo often
    # holds many LoRA files (e.g. Kijai's), so the repo name is a folder, not per-file
    # identity — every file would collide on it. Leave originalName untouched so the
    # display falls back to the safetensors filename (name || originalName || filename).

    # base_model may be a string or a list; take the first. HF gives a repo id
    # (org/model), so keep just the model name — the field reads "MiniMax-H3", not
    # "MiniMaxAI/MiniMax-H3". Civitai's baseModel is a bare label too, so this stays
    # closer to that vocabulary.
    base = front.get("base_model")
    if isinstance(base, list):
        base = base[0] if base else ""
    if base:
        merged["baseModel"] = str(base).rsplit("/", 1)[-1].strip()

    # instance_prompt is the trigger word on diffusers/DreamBooth LoRA cards.
    instance = front.get("instance_prompt")
    if instance:
        merged["trainedWords"] = normalize_words([str(instance)])

    tags = front.get("tags")
    if tags:
        merged["tags"] = normalize_tags(tags)

    license_val = front.get("license")
    if license_val:
        usage = dict(merged.get("usage")) if isinstance(merged.get("usage"), dict) else {}
        usage["license"] = str(license_val)
        merged["usage"] = usage

    creator = dict(merged.get("creator")) if isinstance(merged.get("creator"), dict) else {}
    creator["username"] = author
    merged["creator"] = creator

    merged["originUrl"] = url
    merged["metadataSource"] = "huggingface"
    merged["sourceImport"] = {
        "type": "huggingface",
        "repo": repo,
        "url": url,
        "importedAt": now,
    }
    merged["userBlanked"] = False  # a HuggingFace import un-blanks the record
    merged["libraryId"] = library_id
    if existing.get("sha256"):
        merged["sha256"] = existing["sha256"]

    write_krc_metadata(
        {
            "library_id": library_id,
            "relative_path": existing.get("file") or path.name,
            "filename": path.name,
            "path": str(path),
        },
        merged,
    )
    return normalize_krc_metadata(path, library_id, read_krc_metadata(library_id))
