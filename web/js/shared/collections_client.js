import { api } from "../../../scripts/api.js";
import { jsonBodyInit } from "./api.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, publishKrcSync } from "./sync_bus.js";

// Client for the shared, cross-node Collections store (utils/library/collections.py, routes
// under /krc/collections). A Collection links a mix of models + LoRAs by canonical id; there
// is no per-record field, so this module-level cache is the single in-page mirror every
// InfoPanel + viewer reads. Mutations POST, refresh the cache from the echoed state, and
// broadcast COLLECTIONS_CHANGED so sibling surfaces reconcile. See COLLECTIONS_GAMEPLAN.md.

const BASE = "/krc/collections";

// One page-wide source id so a surface can skip the echo of its own mutation.
const SOURCE = `collections-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// { collections: [ordered records], membership: { memberId: [collectionId, ...] } }
let _cache = { collections: [], membership: {} };
let _loaded = false;
let _inflight = null;

export function collectionsCache() {
  return _cache;
}

// The collection ids a member (canonical id / sha) currently belongs to, in display order.
export function collectionsForMember(memberId) {
  const key = String(memberId || "");
  const ids = key ? _cache.membership[key] : null;
  return Array.isArray(ids) ? ids : [];
}

export function collectionById(collectionId) {
  const id = String(collectionId || "");
  return _cache.collections.find((record) => record.id === id) || null;
}

function applyState(payload) {
  if (payload && Array.isArray(payload.collections)) {
    _cache = {
      collections: payload.collections,
      membership: payload.membership && typeof payload.membership === "object" ? payload.membership : {},
    };
    _loaded = true;
  }
  return _cache;
}

async function req(path, options) {
  const response = await api.fetchApi(`${BASE}${path}`, options);
  if (!response.ok && response.status !== 404) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json().catch(() => ({}));
}

// Refresh the cache from the server. Deduped so several panels priming at once share one GET.
export async function loadCollections({ force = false } = {}) {
  if (_loaded && !force) return _cache;
  if (_inflight) return _inflight;
  _inflight = req("", {})
    .then((payload) => applyState(payload))
    .catch(() => _cache)
    .finally(() => { _inflight = null; });
  return _inflight;
}

// A mutation refreshed the cache locally; tell sibling surfaces to reconcile. `source` is the
// mutating surface's own sync id so it can skip its own echo (falls back to this module's id).
function broadcast(source) {
  publishKrcSync(KRC_SYNC_EVENTS.COLLECTIONS_CHANGED, {
    source: source || SOURCE,
    lane: KRC_SYNC_LANES.STRUCTURE,
  });
}

// The store changed server-side without a Collections mutation (a Model Library bundle
// import brought collections in): refetch, then tell every surface — including the caller's
// own panels, so the broadcast carries this module's id, not the caller's.
export async function reloadCollectionsEverywhere() {
  await loadCollections({ force: true });
  broadcast(SOURCE);
}

async function mutate(path, body, source) {
  const payload = await req(path, jsonBodyInit("POST", body || {}));
  applyState(payload);
  broadcast(source);
  return payload;
}

export function createCollection(name, { memberId = "", source = "" } = {}) {
  const body = { name: String(name || "").trim() };
  const member = String(memberId || "").trim();
  if (member) body.members = [member];
  return mutate("", body, source);
}

export function addMember(collectionId, memberId, { source = "" } = {}) {
  return mutate(`/${encodeURIComponent(collectionId)}/add-member`, { memberId }, source);
}

export function removeMember(collectionId, memberId, { source = "" } = {}) {
  return mutate(`/${encodeURIComponent(collectionId)}/remove-member`, { memberId }, source);
}

export function renameCollection(collectionId, name, { source = "" } = {}) {
  return mutate(`/${encodeURIComponent(collectionId)}/rename`, { name }, source);
}

export function setCollectionPinned(collectionId, pinned, { source = "" } = {}) {
  return mutate(`/${encodeURIComponent(collectionId)}/pin`, { pinned: !!pinned }, source);
}

export function setCollectionColor(collectionId, cardColor, { source = "" } = {}) {
  return mutate(`/${encodeURIComponent(collectionId)}/color`, { cardColor: String(cardColor || "") }, source);
}

export async function deleteCollection(collectionId, { source = "" } = {}) {
  const payload = await req(`/${encodeURIComponent(collectionId)}`, { method: "DELETE" });
  applyState(payload);
  broadcast(source);
  return payload;
}
