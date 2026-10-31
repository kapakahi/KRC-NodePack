// Shared identity rules for browser cards, external cards and missing-card status.
// Cycles fail closed. Paths are exact, type-scoped and must identify one record.
export function canonicalModelId(value, aliases = {}) {
  const original = String(value || "").trim();
  let current = original;
  const seen = new Set();
  while (current && Object.hasOwn(aliases, current)) {
    if (seen.has(current) || seen.size >= 64) return original;
    seen.add(current);
    const next = String(aliases[current] || "").trim();
    if (!next) return original;
    current = next;
  }
  return current;
}

const pathKey = value => String(value || "").trim().replace(/\\/g, "/");
const typeKey = value => value === "loras" ? "lora" : value === "all" ? "" : String(value || "");
const identities = item => [...new Set([item?.id, item?.libraryId, item?.sha256].filter(Boolean).map(String))];

export function modelIdentityIndex(items = [], aliases = {}) {
  const ids = new Map();
  const paths = new Map();
  const add = (map, key, item) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(item);
  };
  for (const item of items) {
    if (!item) continue;
    for (const id of identities(item)) add(ids, canonicalModelId(id, aliases), item);
    if (item.unavailable) continue;
    for (const path of new Set([item.relativePath, item.relative_path, item.path, item.value].map(pathKey).filter(Boolean))) {
      add(paths, `${typeKey(item.modelType)}|${path}`, item);
      add(paths, `|${path}`, item);
    }
  }
  return option => {
    const candidates = new Set();
    for (const id of identities(option)) {
      for (const item of ids.get(canonicalModelId(id, aliases)) || []) candidates.add(item);
    }
    if (candidates.size) return candidates.size === 1 ? [...candidates][0] : null;
    const matches = new Set();
    for (const path of new Set([option.relativePath, option.relative_path, option.path, option.value].map(pathKey).filter(Boolean))) {
      for (const item of paths.get(`${typeKey(option.modelType || option.folder)}|${path}`) || []) matches.add(item);
    }
    return matches.size === 1 ? [...matches][0] : null;
  };
}
