/*
 * KRC shared search primitives — pure, side-effect-free, node-agnostic.
 * The key:value search DSL is common to KRC LoRA Loadout and KRC Prompt Vault;
 * this holds the identical parsing core. Each node keeps its own field-alias
 * table, field-text accessor, and sort logic and passes them in.
 * (Extracted from the LoRA Loadout helpers, which remain the reference shape.)
 */

function aliasSpec(alias) {
  if (!alias) return null;
  if (typeof alias === "string") return { field: alias };
  if (typeof alias === "object" && alias.field) return alias;
  return null;
}

/**
 * Parse one search token into a {field, value} filter.
 * "model:wan" with a recognized prefix → {field: aliases["model"], value: "wan"};
 * anything else → {field: "active", value: token} (matches the node's active mode).
 */
export function parseSearchToken(token, aliases = {}) {
  const match = /^([a-z]+):(.+)$/.exec(token);
  const spec = match ? aliasSpec(aliases[match[1]]) : null;
  if (spec) {
    return { field: spec.field, value: match[2] };
  }
  return { field: "active", value: token };
}

/**
 * The query's words, lower-cased. Whitespace separates words, except inside double
 * quotes: `prompt:"golden hour"` and `"golden hour"` are one word each, quotes removed,
 * so a phrase matches as written. An unclosed quote runs to the end; `""` is nothing.
 * (Mirrored by utils/prompt_vault_search.py search_tokens for the server's search.)
 */
export function searchTokens(query = "") {
  const tokens = [];
  let current = "";
  let quoted = false;
  for (const ch of String(query || "").toLowerCase()) {
    if (ch === "\"") {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(ch)) {
      if (current) tokens.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

export function searchFilters(query = "", aliases = {}) {
  const tokens = searchTokens(query);
  const filters = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const fieldOnly = /^([a-z]+):$/.exec(token);
    const spec = fieldOnly ? aliasSpec(aliases[fieldOnly[1]]) : null;
    if (spec?.implicit) {
      filters.push({ field: spec.field, value: spec.implicit });
    } else if (spec && tokens[index + 1]) {
      filters.push({ field: spec.field, value: tokens[index + 1] });
      index += 1;
    } else if (!spec) {
      filters.push(parseSearchToken(token, aliases));
    } else {
      // Recognized alias with no value yet ("model:", "folder:") is incomplete.
    }
  }
  return filters;
}

export function searchValuesForField(query = "", aliases = {}, field = "") {
  return searchFilters(query, aliases)
    .filter((filter) => filter.field === field)
    .map((filter) => filter.value);
}

export function filterItems(items = [], options = {}) {
  const {
    query = "",
    aliases = {},
    fieldText = () => "",
    predicate = () => true,
  } = options;
  const filters = searchFilters(query, aliases);

  return items.filter((item) => {
    if (!predicate(item)) {
      return false;
    }
    return filters.every((filter) => String(fieldText(item, filter.field) || "").toLowerCase().includes(filter.value));
  });
}

export function filterAndSortItems(items = [], options = {}) {
  const {
    compare,
    isPinned,
    pinnedIds = [],
    pinKey,
    pinnedOrder = "sorted",
  } = options;
  const out = filterItems(items, options);

  if (compare) {
    out.sort(compare);
  }

  const hasPinnedIds = Array.isArray(pinnedIds) && pinnedIds.length > 0 && typeof pinKey === "function";
  const pinnedCheck = typeof isPinned === "function"
    ? isPinned
    : hasPinnedIds
      ? (item) => pinnedIds.includes(pinKey(item))
      : null;
  if (!pinnedCheck) {
    return out;
  }

  const pins = [];
  const rest = [];
  for (const item of out) {
    if (pinnedCheck(item)) {
      pins.push(item);
    } else {
      rest.push(item);
    }
  }

  if (hasPinnedIds && pinnedOrder === "list") {
    pins.sort((a, b) => pinnedIds.indexOf(pinKey(a)) - pinnedIds.indexOf(pinKey(b)));
  }

  return [...pins, ...rest];
}

export function cachedFilterResult(owner, signature, compute, {
  signatureProp = "_filteredSig",
  cacheProp = "_filteredCache",
} = {}) {
  if (owner?.[signatureProp] === signature) {
    return owner[cacheProp];
  }
  const result = compute();
  if (owner) {
    owner[signatureProp] = signature;
    owner[cacheProp] = result;
  }
  return result;
}
