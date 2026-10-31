"""Shared HuggingFace parsing plumbing (generic, node-agnostic).

The node-specific field mapping (card -> LoRA sidecar vs -> generic model record)
stays in each node's own hf_map. What's identical is the reference normalizer and the
dependency-free front-matter reader below.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (stage B6).
"""

import re
from urllib.parse import urlparse

HF_HOST = "huggingface.co"
_FRONT_MATTER_RE = re.compile(r"^﻿?---\s*\n(.*?)\n---\s*\n?", re.DOTALL)


def parse_hf_repo(raw):
    """Normalize a pasted HuggingFace reference to 'author/model', or None.

    Accepts full URLs (…/tree/main, …/blob/main/file.safetensors) and bare
    'author/model'. Rejects anything that isn't a HuggingFace host or lacks the two
    leading path segments.
    """
    text = str(raw or "").strip()
    if not text:
        return None
    if "://" in text or text.lower().startswith(HF_HOST):
        parsed = urlparse(text if "://" in text else f"https://{text}")
        host = (parsed.netloc or "").lower()
        if host and host not in (HF_HOST, "www." + HF_HOST):
            return None
        parts = [segment for segment in parsed.path.split("/") if segment]
    else:
        parts = [segment for segment in text.split("/") if segment]
    if len(parts) < 2 or not parts[0] or not parts[1]:
        return None
    return f"{parts[0]}/{parts[1]}"


def split_front_matter(card):
    """Return (front_matter_dict, body_markdown). No front matter -> ({}, card)."""
    text = str(card or "")
    match = _FRONT_MATTER_RE.match(text)
    if not match:
        return {}, text.strip()
    return _parse_front_matter(match.group(1)), text[match.end():].strip()


def _unquote(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        return value[1:-1]
    return value


def _parse_front_matter(text):
    """Minimal, dependency-free parser for the flat front-matter keys we use.

    Deliberately NOT a full YAML parser (no PyYAML dependency). Handles exactly the
    shapes HuggingFace model cards use for our Tier-1 keys:
      key: scalar
      key: [a, b, c]          (inline list)
      key:                    (block list)
        - a
        - b
    Only top-level (unindented) keys are read; nested maps and anything exotic are
    simply skipped — we only ever look up license / base_model / instance_prompt / tags.
    """
    result = {}
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        i += 1
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or raw[:1].isspace():
            continue  # blank, comment, or indented (child of a key we skip)
        match = re.match(r"^([A-Za-z0-9_\-]+)\s*:\s*(.*)$", raw)
        if not match:
            continue
        key, rest = match.group(1), match.group(2).strip()
        if rest.startswith("[") and rest.endswith("]"):
            result[key] = [_unquote(item) for item in rest[1:-1].split(",") if item.strip()]
        elif rest == "" and i < len(lines) and lines[i].lstrip().startswith("- "):
            items = []
            while i < len(lines) and lines[i].lstrip().startswith("- "):
                items.append(_unquote(lines[i].lstrip()[2:]))
                i += 1
            result[key] = items
        elif rest:
            result[key] = _unquote(rest)
    return result
