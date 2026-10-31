import { canonicalModelId, modelIdentityIndex } from "./model_identity.js";
// Missing-card status (CARD_MISSING_STATUS_GAMEPLAN.md, Card API 1.6): will a run find
// this card on THIS machine? Pure: the library lists come in, so the rule is testable
// (dev repo tests/card_status_check.mjs). card_api.js cardStatus() feeds it.
//
//   "ok"       the id is in the library (following identity aliases) and loadable
//   "by-path"  id unknown, but the path the node's run falls back to is exactly a
//              library item's relative path (same type folder when given): it will run
//   "missing"  neither
//
// No filename / size matching: a run never matches that way. A library that couldn't be
// read (null) makes every card "ok": unknown is not missing.

export const CARD_STATUS = Object.freeze({ OK: "ok", BY_PATH: "by-path", MISSING: "missing" });

// entries: ids, or { id, path?, folder? } (models) / { id, category?, name? } (prompts).
function normalizeEntries(entries) {
  return (entries || [])
    .map((entry) => (typeof entry === "object" && entry ? entry : { id: entry }))
    .map((entry) => ({ ...entry, id: String(entry.id || "").trim() }))
    .filter((entry) => entry.id);
}

// models: the /library payload ({ items, aliases }) or null.
export function modelCardStatus(entries, models) {
  const list = normalizeEntries(entries);
  const out = {};
  if (!models || !Array.isArray(models.items)) {
    for (const entry of list) out[entry.id] = CARD_STATUS.OK;
    return out;
  }
  const aliases = models.aliases || {};
  const resolve = modelIdentityIndex(models.items, aliases);
  for (const entry of list) {
    const item = resolve({ id: entry.id, path: entry.path, folder: entry.folder });
    const matchesId = item && [item.sha256, item.libraryId, item.id]
      .some(id => id && canonicalModelId(id, aliases) === canonicalModelId(entry.id, aliases));
    out[entry.id] = !item || item.unavailable ? CARD_STATUS.MISSING
      : matchesId ? CARD_STATUS.OK : CARD_STATUS.BY_PATH;
  }
  return out;
}

// prompts: Prompt Vault's library ({ category: { name: record } }) or null. Found by id,
// else by category + name (how Config Switcher and resolve_prompts look them up).
export function promptCardStatus(entries, prompts) {
  const list = normalizeEntries(entries);
  const out = {};
  if (!prompts || typeof prompts !== "object" || prompts.error) {
    for (const entry of list) out[entry.id] = CARD_STATUS.OK;
    return out;
  }
  const ids = new Set();
  for (const bucket of Object.values(prompts)) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [name, record] of Object.entries(bucket)) {
      if (name !== "__meta__" && record && typeof record === "object" && record.id) ids.add(String(record.id));
    }
  }
  for (const entry of list) {
    const bucket = entry.category ? prompts[entry.category] : null;
    const byName = Boolean((!entry.profileId || entry.profileId === "default") && entry.name && entry.name !== "__meta__" && bucket && typeof bucket === "object" && bucket[entry.name]);
    out[entry.id] = ids.has(entry.id) || byName ? CARD_STATUS.OK : CARD_STATUS.MISSING;
  }
  return out;
}
