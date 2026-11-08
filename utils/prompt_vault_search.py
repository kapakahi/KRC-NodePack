"""Prompt Vault search on the server (KRC_EXTERNAL_API_GAMEPLAN.md stage 14, prompts only).

A port of the in-node search: the key:value DSL (web/js/shared/search.js ``searchFilters`` /
``filterItems``) and Prompt Vault's fields (web/js/prompt_vault/search_fields.js
``PROMPT_SEARCH_ALIASES`` / ``promptFieldText``). The dev repo's parity test runs the same
queries through that JS and through this, and requires the same matches; change both
together.

Matching only: the order of results is the server's own (category, then name), not the
node's display order (which depends on its sort menu and pins).

``prompt:`` searches Prompt A and B. The node's list holds that text back, so the node asks
the server (``prompt_text_matches``, the internal /krc/prompt-vault/search-text route) and
filters with the answer; here the full records are at hand, so it's an ordinary field.
"""
from .library import search_dsl
from .prompt_vault_store import UNASSIGNED_CATEGORY, normalize_kit_presets

# constants.js UNASSIGNED_LABEL: the default bucket reads "Unsorted"; the stored name stays.
UNASSIGNED_LABEL = "Unsorted"

# Mirror of PROMPT_SEARCH_ALIASES (search_fields.js).
PROMPT_SEARCH_ALIASES = {
    "category": "category", "cat": "category",
    "title": "title", "name": "title",
    "preset": "ll_preset", "presets": "ll_preset",
    "type": "type", "types": "type",
    "has": "has", "missing": "missing",
    "badge": "badge", "badges": "badge",
    "prompt": "prompt", "prompts": "prompt",
}
PROMPT_FIELD = "prompt"

def parse_search_token(token, aliases=PROMPT_SEARCH_ALIASES):
    """search.js parseSearchToken with Prompt Vault's aliases (library/search_dsl.py)."""
    return search_dsl.parse_search_token(token, aliases)


search_tokens = search_dsl.search_tokens


def search_filters(query, aliases=PROMPT_SEARCH_ALIASES):
    """search.js searchFilters with Prompt Vault's aliases (library/search_dsl.py)."""
    return search_dsl.search_filters(query, aliases)


def _text(value):
    return str(value) if value else ""


def _category_text(item):
    """search_fields.js categoryText: the stored name and its label ("Unassigned" reads "Unsorted")."""
    category = item.get("category")
    label = UNASSIGNED_LABEL if category == UNASSIGNED_CATEGORY else category
    return " ".join(dict.fromkeys(_text(part) for part in (category, label) if part))


def prompt_field_text(item, field):
    """search_fields.js promptFieldText: the lower-case text a filter on ``field`` searches."""
    if field == "active":
        labels = [link["label"] for link in normalize_kit_presets(item.get("kitPresets")).values() if link["label"]]
        parts = [item.get("name"), _category_text(item), item.get("llPresetLabel"), *labels, item.get("model")]
        return " ".join(_text(part) for part in parts if part).lower()
    if field == "title":
        return _text(item.get("name")).lower()
    if field == "category":
        return _category_text(item).lower()
    if field == "ll_preset":
        return _text(item.get("llPresetLabel")).lower()
    if field == "type":
        return _text(item.get("model")).lower()
    if field == "has":
        return "thumb thumbnail" if item.get("hasThumb") else ""
    if field == "missing":
        return "" if item.get("hasThumb") else "thumb thumbnail"
    if field == "badge":
        return _text(item.get("customBadge")).lower()
    if field == "prompt":
        return "\n".join(_text(part) for part in (item.get("prompt"), item.get("promptB")) if part).lower()
    return ""


def matches(item, filters):
    """search.js filterItems' test for one item: every filter's value is in its field's text."""
    return search_dsl.matches(item, filters, prompt_field_text)


def library_items(response):
    """A get-prompts response (``{category: {name: record}}``) as the node's flat items,
    ``{category, name, ...record}`` (prompt_detail.js promptSummaryItem, minus the text it
    clears, which the response has already held back)."""
    items = []
    for category, bucket in (response or {}).items():
        if not isinstance(bucket, dict):
            continue
        for name, record in bucket.items():
            if name == "__meta__" or not isinstance(record, dict):
                continue
            items.append({"category": category, "name": name, **record})
    return items


def prompt_text_matches(library, query):
    """The node's ``prompt:`` lookup: the ``(category, name)`` of every prompt whose Prompt A
    or B contains every ``prompt:`` value in ``query`` (the query's other filters are the
    node's to apply). ``library`` is the full library, text included. [] when the query has
    no ``prompt:`` filter."""
    filters = [flt for flt in search_filters(query) if flt["field"] == PROMPT_FIELD]
    if not filters:
        return []
    return [(item["category"], item["name"]) for item in library_items(library) if matches(item, filters)]


def search_items(items, query):
    """The items matching ``query``, ordered by category then name (case-insensitive)."""
    filters = search_filters(query)
    found = [item for item in items if matches(item, filters)]
    found.sort(key=lambda item: (str(item.get("category") or "").casefold(), str(item.get("name") or "").casefold(),
                                 str(item.get("category") or ""), str(item.get("name") or "")))
    return found
