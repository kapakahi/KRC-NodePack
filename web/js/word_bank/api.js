// KRC Word Bank — bank listing / random-word API over the /wordbank routes.
import { deleteJson, getJson, jsonBodyInit, postJson, requestOk } from "../shared/api.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, publishKrcSync } from "../shared/sync_bus.js";

let _banks = null;
const _entryCache = new Map();

export async function fetchBankNames(force = false) {
  if (_banks && !force) return _banks;
  _banks = await getJson("/wordbank/banks", { fallback: [] });
  return _banks;
}

export function clearBankEntryCache(category = null) {
  if (category) _entryCache.delete(category);
  else _entryCache.clear();
}

export async function fetchBankEntries(category, force = false) {
  if (!category) return [];
  if (!force && _entryCache.has(category)) return _entryCache.get(category);
  const data = await getJson(`/wordbank/banks/${encodeURIComponent(category)}/entries`, { fallback: { entries: [] } });
  const entries = Array.isArray(data?.entries) ? data.entries : [];
  _entryCache.set(category, entries);
  return entries;
}

// Tell every other Word Bank node the bank set changed, so its row pickers follow a
// create / rename / delete (imports announce the same event from the shared runner).
// `source` is the acting node's id so it skips its own echo; rename carries the id
// change and delete the removed id, so other nodes remap / clear their rows.
function announceBanksChanged(source, change = {}) {
  publishKrcSync(KRC_SYNC_EVENTS.WORDBANK_BANKS_CHANGED, { source, lane: KRC_SYNC_LANES.STRUCTURE, ...change });
}

export async function createBank(name, { source = "" } = {}) {
  const result = await postJson("/wordbank/banks", { name }, { requireOk: true, fallback: null });
  _banks = null;
  if (result?.ok) announceBanksChanged(source);
  return result;
}

export async function renameBank(id, newName, { source = "" } = {}) {
  const result = await postJson("/wordbank/banks/rename", { id, new: newName }, { fallback: { ok: false } });
  _banks = null;
  clearBankEntryCache();
  if (result?.ok) announceBanksChanged(source, { oldId: id, newId: result.id });
  return result;
}

export async function deleteBank(id, { source = "" } = {}) {
  const result = await deleteJson("/wordbank/banks", { id }, { fallback: { ok: false } });
  _banks = null;
  clearBankEntryCache(id);
  if (result?.ok) announceBanksChanged(source, { deletedId: id });
  return !!result?.ok;
}

export async function insertBankEntry(categoryId, value) {
  const result = await postJson("/wordbank/banks/entry", { categoryId, value }, { fallback: { ok: false } });
  if (result?.ok) clearBankEntryCache(categoryId);
  return result;
}

export async function removeBankEntry(categoryId, value) {
  const result = await deleteJson("/wordbank/banks/entry", { categoryId, value }, { fallback: { ok: false } });
  if (result?.ok) clearBankEntryCache(categoryId);
  return result;
}

// -> a random word ("" when the bank is empty), or null when the request failed: callers
// then keep the row's current word instead of blanking it.
export async function randomWord(categoryId, exclude = "") {
  const query = exclude ? `?exclude=${encodeURIComponent(exclude)}` : "";
  const data = await getJson(`/wordbank/random/${encodeURIComponent(categoryId)}${query}`, { fallback: null });
  if (!data || typeof data !== "object" || "error" in data) return null;
  return typeof data.value === "string" ? data.value : "";
}

// ── Global presets (disk-backed via /wordbank/presets) ──────────────────────

export async function fetchPresets() {
  return getJson("/wordbank/presets", { fallback: { presets: [] } });
}

export async function savePreset(group, name, rows, id = "") {
  // requireOk so an HTTP error resolves to null instead of an error body the
  // caller might mistake for a saved preset.
  return postJson("/wordbank/presets", { id, group, name, rows }, { requireOk: true, fallback: null });
}

export async function renamePreset(id, group, newName) {
  // The rename route returns { ok } with HTTP 200 even on a rejected rename
  // (name taken / source gone), so read the body rather than trusting the
  // status — requestOk would report success for a refused rename.
  return postJson("/wordbank/presets/rename", { id, group, new: newName }, { fallback: { ok: false } });
}

export async function deletePreset(id) {
  return requestOk("/wordbank/presets", jsonBodyInit("DELETE", { id }));
}
