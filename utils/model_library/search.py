"""Model Library search on the server (the external API's /krc/ext/v1/search/models).

A port of the node's search: the shared key:value syntax (library/search_dsl.py, from
web/js/shared/search.js) with the Model Library's aliases (web/js/model_library/constants.js
``SEARCH_FIELD_ALIASES``), field text (pure_helpers.js ``searchFieldText`` / ``browserLabel``)
and has: / missing: words (shared/model_search_fields.js), plus the browser's
"duplicate(s)" shortcut. It runs over the same rows as the node's list (listing.py), so the
same query matches the same models. The dev repo's parity test runs the same queries through
that JS and through this; change both together.

Matching only: results are in the list's order (title, case-insensitive), not the node's
sort menu or pins.
"""
from ..library import search_dsl

# Mirror of SEARCH_FIELD_ALIASES (constants.js).
MODEL_SEARCH_ALIASES = {
    "model": "model", "basemodel": "model",
    "category": "category", "cat": "category",
    "creator": "creator", "author": "creator",
    "folder": "folder", "folders": "folder",
    "has": "has", "missing": "missing",
    "title": "title", "name": "title",
    "file": "filename", "filename": "filename",
    "trained": "trained", "train": "trained", "word": "trained", "words": "trained",
    "tag": "tag", "tags": "tag",
    "badge": "badge", "badges": "badge",
    "version": "version", "ver": "version",
    "civitai": "civitai",
}
NAME_MODES = ("title", "filename")
DUPLICATE_QUERIES = ("duplicate", "duplicates")

# model_search_fields.js PRESENCE: (words, test) in order.
_PRESENCE = (
    ("thumb thumbnail", lambda item: bool(item.get("thumbnail"))),
    ("animated", lambda item: bool(item.get("thumbnailHasAnimation"))),
    ("badge", lambda item: bool(item.get("customBadge"))),
    ("favorite", lambda item: bool(item.get("favorite"))),
    ("metadata", lambda item: bool(item.get("originalName") or item.get("version") or _creator_username(item))),
    ("file", lambda item: not item.get("unavailable")),
)


def _text(value):
    return str(value) if value else ""


def _creator_username(item):
    creator = item.get("creator")
    return creator.get("username") if isinstance(creator, dict) else ""


def model_presence_text(item, present):
    """model_search_fields.js modelPresenceText."""
    return " ".join(words for words, test in _PRESENCE if test(item) == present)


def browser_label(item, name_mode="title"):
    """pure_helpers.js browserLabel: the card's name in the node's name mode."""
    if name_mode == "filename":
        return _text(item.get("filename") or item.get("display_name"))
    if item.get("hasName"):
        return _text(item.get("display_name"))
    return _text(item.get("filename") or item.get("display_name"))


def _words(value):
    # Array.join: null / undefined read "", anything else as text.
    return " ".join("" if word is None else str(word) for word in value) if isinstance(value, list) else ""


def model_field_text(item, field, name_mode="title"):
    """pure_helpers.js searchFieldText: the lower-case text a filter on ``field`` searches."""
    if field == "active":
        return browser_label(item, name_mode).lower()
    if field == "title":
        return _text(item.get("display_name") or item.get("filename")).lower()
    if field == "filename":
        return _text(item.get("filename")).lower()
    if field == "model":
        return _text(item.get("baseModel")).lower()
    if field == "category":
        return _text(item.get("category")).lower()
    if field == "creator":
        return _text(_creator_username(item)).lower()
    if field == "folder":
        return _text(item.get("folder") or "root").lower()
    if field == "has":
        return model_presence_text(item, True)
    if field == "missing":
        return model_presence_text(item, False)
    if field == "version":
        return _text(item.get("version")).lower()
    if field == "trained":
        return _words(item.get("trainedWords")).lower()
    if field == "tag":
        return _words(item.get("tags")).lower()
    if field == "badge":
        return _text(item.get("customBadge")).lower()
    if field == "civitai":
        return "none nomatch notfound" if item.get("civitaiNotFoundAt") else ""
    return ""


def search_filters(query):
    return search_dsl.search_filters(query, MODEL_SEARCH_ALIASES)


def search_items(items, query, name_mode="title"):
    """The rows matching ``query``, in the given order. "duplicate" / "duplicates" alone
    lists the models with more than one copy on disk (the browser's shortcut)."""
    text = str(query or "").strip().lower()
    if text in DUPLICATE_QUERIES:
        return [item for item in items if int(item.get("duplicateCount") or 0) > 1]
    filters = search_filters(query)

    def field_text(item, field):
        return model_field_text(item, field, name_mode)

    return [item for item in items if search_dsl.matches(item, filters, field_text)]
