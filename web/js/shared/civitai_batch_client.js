/*
 * Client for the server-side Civitai batch fetch (CIVITAI_BATCH_FETCH_GAMEPLAN.md §6).
 * Routes live under LoRA Loadout (the one LoRA writer); the Portal's Fetch
 * page (model_library/civitai_fetch_page.js) is the only UI consumer.
 *
 * A page-level SINGLETON store mirrors the server job. It attaches once (status fetch
 * + one "krc-civitai-batch" websocket listener) and then applies each event's deltas,
 * so any number of views read one job and a reload/re-open re-attaches to a live run.
 *
 * It is also the bridge onto the in-page sync bus, so LL / ML nodes converge:
 *   - id promotions → IDENTITY_CHANGED right away (a freshly hashed LoRA stays
 *     draggable and preset-resolvable mid-run);
 *   - run finished → ONE LIBRARY_CHANGED. Every surface re-scans once and re-applies
 *     its unsaved drafts on top (loadLibrary → applyMetadataDraft), so a draft is
 *     never clobbered. Not per item: each LIBRARY_CHANGED makes every surface force a
 *     server rescan.
 */
import { api } from "../../../scripts/api.js";
import { forgetInFlight, makeNodeApi } from "./api.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, publishKrcSync } from "./sync_bus.js";

const { fetchLora, postLoraJson } = makeNodeApi("/krc/lora-loadout");

export const CIVITAI_BATCH_EVENT = "krc-civitai-batch";
const SYNC_SOURCE = "krc-civitai-batch";
const LOG_LIMIT = 500;

const store = {
  job: null,          // server summary + mirrored log/errors/warnings
  lastRun: null,      // persisted summary of the last finished run
  attached: null,     // initial status-read promise (retried if it failed)
  wsInstalled: false, // the websocket listener — installed exactly once per page
  listeners: new Set(),
  settledJobs: new Set(),  // job ids we already broadcast LIBRARY_CHANGED for
};

function notify() {
  for (const fn of store.listeners) {
    try {
      fn(store);
    } catch (err) {
      console.warn("[KRC Civitai Batch] listener failed", err);
    }
  }
}

export function civitaiBatchState() {
  return store;
}

export function subscribeCivitaiBatch(fn) {
  store.listeners.add(fn);
  return () => store.listeners.delete(fn);
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────

// scope: "library" | "folder"; folder "" = the root folder.
export async function fetchCivitaiBatchTargets({ scope = "library", folder = "", subfolders = false } = {}) {
  const params = new URLSearchParams();
  if (scope === "folder") {
    params.set("folder", folder || "");
    if (subfolders) params.set("subfolders", "1");
  }
  const query = params.toString();
  const response = await fetchLora(`/civitai/batch/targets${query ? `?${query}` : ""}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

export async function refreshCivitaiBatchStatus() {
  const response = await fetchLora("/civitai/batch/status");
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await readJson(response);
  store.job = payload.job ? { ...payload.job, receivedAt: Date.now() } : null;
  store.lastRun = payload.lastRun || null;
  if (store.job && !store.job.active) store.settledJobs.add(store.job.id);  // already reconciled
  notify();
  return store;
}

export async function startCivitaiBatch({ scope = "library", folder = "", subfolders = false, overwrite = false } = {}) {
  const body = { subfolders: !!subfolders, overwrite: !!overwrite };
  if (scope === "folder") body.folder = folder || "";
  const response = await postLoraJson("/civitai/batch/start", body);
  const payload = await readJson(response);
  if (!response.ok || !payload.ok) {
    return { ok: false, status: payload.status || "", error: payload.error || `HTTP ${response.status}` };
  }
  // The websocket "state" event may already have arrived; only take the snapshot if not.
  if (!store.job || store.job.id !== payload.job?.id) store.job = { ...payload.job, receivedAt: Date.now() };
  notify();
  return { ok: true };
}

export async function cancelCivitaiBatch() {
  const response = await postLoraJson("/civitai/batch/cancel", {});
  const payload = await readJson(response);
  if (payload.job && store.job?.id === payload.job.id) {
    store.job = { ...store.job, ...payload.job, receivedAt: Date.now() };
    notify();
  }
  return { ok: !!payload.ok, error: payload.error || "" };
}

// Empties the finished run's Errors & Warnings (live job + persisted last run).
// Counts and the log stay; a no-match lives on in the Civitai cache (civitai:none),
// so nothing is lost.
export async function clearCivitaiBatchIssues() {
  const response = await postLoraJson("/civitai/batch/clear-issues", {});
  const payload = await readJson(response);
  if (!response.ok || !payload.ok) {
    return { ok: false, error: payload.error || `HTTP ${response.status}` };
  }
  applyIssuesCleared();
  return { ok: true };
}

function applyIssuesCleared() {
  if (store.job) store.job = { ...store.job, errors: [], warnings: [], errorCount: 0, warningCount: 0 };
  if (store.lastRun) store.lastRun = { ...store.lastRun, errors: [], warnings: [], errorCount: 0, warningCount: 0 };
  notify();
}

// Queues thumbnail generation for every video-preview LoRA still missing one (the
// existing LL bulk route; runs on the server's bounded thumbnail queue).
export async function generateMissingLoraThumbnails() {
  const response = await postLoraJson("/thumbnails/generate-missing", {});
  const payload = await readJson(response);
  if (!response.ok || !payload.ok) {
    return { ok: false, scheduled: 0, error: payload.error || `HTTP ${response.status}` };
  }
  return { ok: true, scheduled: Number(payload.scheduled) || 0 };
}

// ── websocket → store + sync bus ───────────────────────────────────────────────────

function applyEvent(event) {
  // Cleared from any browser — every page drops its issue lists.
  if (event?.type === "issues-cleared") {
    applyIssuesCleared();
    return;
  }
  const summary = event?.job;
  if (!summary?.id) return;
  const known = store.job && store.job.id === summary.id;
  const previousLog = known ? store.job.log || [] : [];
  const lastSeq = previousLog.length ? previousLog[previousLog.length - 1].seq : 0;
  const fresh = (event.log || []).filter((entry) => entry.seq > lastSeq);
  // Joined mid-run (a start from another browser) with a gap → backfill from status.
  const gap = fresh.length && fresh[0].seq !== lastSeq + 1;
  store.job = {
    ...(known ? store.job : {}),
    ...summary,
    receivedAt: Date.now(),  // lets a view tick elapsed time between events
    log: [...previousLog, ...fresh].slice(-LOG_LIMIT),
    errors: known ? store.job.errors || [] : [],
    warnings: known ? store.job.warnings || [] : [],
  };
  if (gap) refreshCivitaiBatchStatus().catch(() => {});

  for (const identity of event.identities || []) {
    if (!identity?.oldId || !identity?.newId || identity.oldId === identity.newId) continue;
    publishKrcSync(KRC_SYNC_EVENTS.IDENTITY_CHANGED, {
      source: SYNC_SOURCE,
      lane: KRC_SYNC_LANES.STRUCTURE,
      identity: { oldId: identity.oldId, newId: identity.newId },
    });
  }

  if (!summary.active && !store.settledJobs.has(summary.id)) {
    store.settledJobs.add(summary.id);
    forgetInFlight();   // receivers must not join a library read from before the run ended
    publishKrcSync(KRC_SYNC_EVENTS.LIBRARY_CHANGED, { source: SYNC_SOURCE, lane: KRC_SYNC_LANES.STRUCTURE });
    // Pull the finished run's full error/warning lists + the persisted last run.
    refreshCivitaiBatchStatus().catch(() => {});
  }
  notify();
}

// The websocket half only — installed at extension load (krc_civitai_batch_bridge.js)
// so LL/ML nodes on EVERY page converge when a run finishes, even one started from
// another browser on a page that never opened the Portal. Idempotent.
export function installCivitaiBatchBridge() {
  if (store.wsInstalled) return;
  store.wsInstalled = true;
  api.addEventListener(CIVITAI_BATCH_EVENT, (event) => applyEvent(event?.detail));
}

// Attach for a view: the bridge + an initial status read. Safe to call from every
// render; returns the same promise.
export function attachCivitaiBatch() {
  installCivitaiBatchBridge();
  if (!store.attached) {
    store.attached = refreshCivitaiBatchStatus().catch((err) => {
      store.attached = null;  // allow a retry on the next attach
      throw err;
    });
  }
  return store.attached;
}
