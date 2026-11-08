"""KRC's key:value search syntax on the server: a port of web/js/shared/search.js
(``searchTokens``, ``parseSearchToken``, ``searchFilters``), shared by every server search
(Prompt Vault: utils/prompt_vault_search.py; Model Library: utils/model_library/search.py).
Each search brings its own alias table and field text, as the nodes do. The dev repo's
parity tests run the same queries through the JS and through this; change both together.
"""
import re

# JavaScript's \s (what search.js trims and splits on), which isn't Python's.
_JS_SPACE = "\t\n\v\f\r    -     　﻿"
_IS_SPACE_RE = re.compile(f"[{_JS_SPACE}]")
# JavaScript's "." excludes these line terminators, not only \n.
_TOKEN_RE = re.compile("([a-z]+):([^\n\r  ]+)")
_FIELD_ONLY_RE = re.compile(r"([a-z]+):")


def _alias_spec(alias):
    if not alias:
        return None
    if isinstance(alias, str):
        return {"field": alias}
    if isinstance(alias, dict) and alias.get("field"):
        return alias
    return None


def parse_search_token(token, aliases):
    """search.js parseSearchToken: ``alias:value`` -> that field, else the "active" field."""
    match = _TOKEN_RE.fullmatch(token)
    spec = _alias_spec(aliases.get(match.group(1))) if match else None
    if spec:
        return {"field": spec["field"], "value": match.group(2)}
    return {"field": "active", "value": token}


def search_tokens(query):
    """search.js searchTokens: lower-cased words; double quotes keep a phrase together."""
    tokens = []
    current = ""
    quoted = False
    for char in str(query or "").lower():
        if char == '"':
            quoted = not quoted
        elif not quoted and _IS_SPACE_RE.match(char):
            if current:
                tokens.append(current)
            current = ""
        else:
            current += char
    if current:
        tokens.append(current)
    return tokens


def search_filters(query, aliases):
    """search.js searchFilters: the query as ``[{field, value}]``."""
    tokens = search_tokens(query)
    filters = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        field_only = _FIELD_ONLY_RE.fullmatch(token)
        spec = _alias_spec(aliases.get(field_only.group(1))) if field_only else None
        if spec and spec.get("implicit"):
            filters.append({"field": spec["field"], "value": spec["implicit"]})
        elif spec and index + 1 < len(tokens):
            filters.append({"field": spec["field"], "value": tokens[index + 1]})
            index += 1
        elif not spec:
            filters.append(parse_search_token(token, aliases))
        # else: a recognized alias with no value yet ("cat:") is incomplete; skipped
        index += 1
    return filters


def matches(item, filters, field_text):
    """search.js filterItems' test for one item: every filter's value is in its field's text."""
    return all(flt["value"] in str(field_text(item, flt["field"]) or "").lower() for flt in filters)
