"""Shared text helpers for imported source metadata (Civitai / HuggingFace).

Pure, node-agnostic parsing used by both LoRA Loadout and Model Library when
ingesting external metadata: HTML-to-plain-text and tag de-duplication.
LoRA-schema-specific builders (the Civitai field mapping, trained-word/prompt
shaping) stay in the node's own source_import module.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (stage B6).
"""

import html
import re
from html.parser import HTMLParser


class PlainTextHTMLParser(HTMLParser):
    BLOCK_TAGS = {"br", "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6"}

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_starttag(self, tag, _attrs):
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data):
        if data:
            self.parts.append(data)

    def text(self):
        text = html.unescape("".join(self.parts))
        text = re.sub(r"[ \t\r\f\v]+", " ", text)
        text = re.sub(r"\n\s*\n\s*", "\n\n", text)
        return text.strip()


def normalize_tags(*values):
    tags = []
    seen = set()
    for value in values:
        if isinstance(value, str):
            items = [item.strip() for item in value.split(",")]
        elif isinstance(value, list):
            items = value
        else:
            items = []
        for item in items:
            tag = str(item).strip()
            key = tag.lower()
            if tag and key not in seen:
                tags.append(tag)
                seen.add(key)
    return tags


def clean_html(value):
    text = str(value or "")
    if not text:
        return ""
    parser = PlainTextHTMLParser()
    try:
        parser.feed(text)
        cleaned = parser.text()
    except Exception:
        cleaned = re.sub(r"<[^>]+>", " ", text)
        cleaned = html.unescape(cleaned)
    return cleaned.strip()
