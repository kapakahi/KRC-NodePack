import { api } from "../../../scripts/api.js";
import { withSyncOrigin } from "./sync_origin.js";

export function jsonBodyInit(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// Per-node route helpers bound to a route prefix. LL/ML defined an identical set
// (loraPath/loraApiUrl/fetchLora/postLoraJson/deleteLoraJson/postLoraForm) that
// differed only by the PREFIX constant; this factory is that one difference.
export function makeNodeApi(prefix) {
  const loraPath = (path) => `${prefix}${path}`;
  // A finished write drops every in-flight shared GET (writes are rare, and an ML write
  // can change what LL lists), so a read that starts after the write never joins one
  // that began before it.
  const fetchLora = (path, options) => {
    const request = api.fetchApi(loraPath(path), withSyncOrigin(options));
    return isWriteRequest(options) ? request.finally(() => forgetInFlight()) : request;
  };
  return {
    loraPath,
    loraApiUrl: (path) => api.apiURL(loraPath(path)),
    fetchLora,
    postLoraJson: (path, body) => fetchLora(path, jsonBodyInit("POST", body)),
    deleteLoraJson: (path, body) => fetchLora(path, jsonBodyInit("DELETE", body)),
    postLoraForm: (path, form) => fetchLora(path, formBodyInit("POST", form)),
    getSharedJson: (path) => sharedGetJson(loraPath(path), () => fetchLora(path)),
  };
}

// Identical requests in flight share one promise; the entry clears once it settles,
// so a later call always makes a fresh request.
const inFlight = new Map();
let readRevision = 0;

// A save or live notification invalidates reads that began before it. Consumers
// of raw responses can use the same fence as the shared JSON readers.
export function currentReadRevision() { return readRevision; }

export function isWriteRequest(options) {
  const method = String(options?.method || "GET").toUpperCase();
  return method !== "GET" && method !== "HEAD";
}

export function forgetInFlight() {
  readRevision++;
  inFlight.clear();
}

export function singleFlight(key, run) {
  const pending = inFlight.get(key);
  if (pending) return pending;
  const promise = Promise.resolve()
    .then(run)
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return promise;
}

// A GET shared by every node that asks for it at the same time. The body is shared as
// text and each caller parses its own copy, so one node editing its list can't leak
// into another's. `token` is the same object for every caller of one request, for
// follow-up work that should run once per response (e.g. the localStorage snapshot).
export async function sharedGetJson(key, fetchResponse) {
  const revision = currentReadRevision();
  const shared = await singleFlight(key, async () => {
    const response = await fetchResponse();
    return { ok: response.ok, status: response.status, text: await response.text() };
  });
  // Clearing deduplication alone does not stop the previous request's response
  // from reaching its existing callers. Re-read instead of returning that snapshot.
  if (revision !== currentReadRevision()) return sharedGetJson(key, fetchResponse);
  let data = null;
  try {
    data = shared.text ? JSON.parse(shared.text) : null;
  } catch {
    data = null;
  }
  return { ok: shared.ok, status: shared.status, data, token: shared };
}

export function formBodyInit(method, form) {
  return { method, body: form };
}

export async function requestJson(url, options = {}, { fallback = null, fetcher = fetch, requireOk = false } = {}) {
  try {
    const response = await fetcher(url, options);
    if (requireOk && !response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

export function getJson(url, options = {}) {
  return requestJson(url, {}, { requireOk: true, ...options });
}

export function postJson(url, body, options = {}) {
  return requestJson(url, jsonBodyInit("POST", body), options);
}

export function deleteJson(url, body, options = {}) {
  return requestJson(url, jsonBodyInit("DELETE", body), options);
}

export async function requestOk(url, options = {}, { fetcher = fetch } = {}) {
  try {
    await fetcher(url, options);
    return true;
  } catch {
    return false;
  }
}

export function apiSucceeded(response) {
  return !!(response && response.success);
}

export function apiErrorMessage(response, fallback = "Request failed") {
  return (response && response.error) || fallback;
}

export function toastApiError(toast, response, fallback = "Request failed") {
  return toast(apiErrorMessage(response, fallback));
}
