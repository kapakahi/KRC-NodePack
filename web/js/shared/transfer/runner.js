/*
 * KRC import/export runner — one flow over the descriptors in kinds.js (a Word Bank .txt),
 * plus the file picker and sync publishing the KRC bundle dialogs share.
 *
 * Node-independent: the Portal's Import and Export page calls it with no node; a node's
 * item-level transfer (Word Bank .txt) passes its node (for the modal palette) and its
 * sync source ids (so it skips its own echo and refreshes itself).
 *
 *   exportTransfer(kind, { detail, detailName, notify })            → { ok }
 *   importTransfer(kind, { node, sources, notify })                 → { ok, result }
 *
 * `notify(message)` shows errors and summaries; default a KRC message dialog (Prompt Vault passes
 * its toast). Every step also logs one `[KRC Transfer]` console line (the server logs its
 * side under the same prefix). `sources` maps a sync event name → the caller's source id for that event
 * (its default key `"*"` covers the rest); the Portal passes none, so every node reacts.
 */
import { api } from "../../../../scripts/api.js";
import { krcAlert } from "../modal.js";
import { downloadResponseBlob } from "../persistence.js";
import { publishKrcSync } from "../sync_bus.js";
import { forgetInFlight } from "../api.js";
import { transferKind } from "./kinds.js";

const PORTAL_SOURCE = `transfer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

function defaultNotify(message, node = null) {
  krcAlert(message, node);
}

// Console lines stay ASCII (file and category names may not be).
function ascii(value) {
  return String(value ?? "").replace(/[^\x20-\x7e]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function log(kind, message, { failed = false } = {}) {
  (failed ? console.warn : console.log)(`[KRC Transfer] ${ascii(kind)} ${ascii(message)}`);
}

function fileText(files) {
  return files.map((file) => `"${file.name}" (${file.size} bytes)`).join(", ");
}

// → { ok, result, error } from a Response or an already-shaped result.
async function readOutcome(outcome) {
  if (!outcome) return { ok: false, result: null, error: "" };
  if (typeof outcome.json !== "function") return { ok: !!outcome.ok, result: outcome.result ?? null, error: outcome.error || "" };
  let body = null;
  try {
    body = await outcome.json();
  } catch {
    body = null;
  }
  // Routes answer {ok} (LL/ML/WB/CS) or {success} (Prompt Vault).
  const ok = outcome.ok && body?.ok !== false && body?.success !== false;
  return { ok, result: body, error: body?.error || (outcome.ok ? "" : `HTTP ${outcome.status}`) };
}

export function pickFiles({ accept, multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept || "";
    input.multiple = !!multiple;
    input.addEventListener("change", () => resolve(Array.from(input.files || [])));
    // Closing the picker without a file fires "cancel" (no "change") — resolve empty so
    // the caller isn't left waiting.
    input.addEventListener("cancel", () => resolve([]));
    input.click();
  });
}

// Tell every open node an import changed the server's store. `events` = [{ name, lane,
// detail? }]; `sources` as in importTransfer.
export function publishTransferEvents(kind, events, sources = null) {
  // Receivers re-read the store; none of them may join a read from before the import.
  forgetInFlight();
  for (const event of events || []) {
    const source = sources?.[event.name] || sources?.["*"] || PORTAL_SOURCE;
    // refetch: the server store changed and no page has a fresh copy to hand around.
    publishKrcSync(event.name, { ...(event.detail || {}), source, lane: event.lane, refetch: true });
  }
  if (events?.length) log(kind, `import: told open nodes (${events.map((event) => event.name).join(", ")})`);
}

export async function exportTransfer(kind, { detail = "", detailName = "", notify = defaultNotify } = {}) {
  const entry = transferKind(kind);
  if (!entry) return { ok: false };
  if (entry.picker && !detail) {
    notify(`Choose a ${entry.picker} to export first.`);
    return { ok: false };
  }
  let ok = false;
  let reason = "";
  log(entry.kind, `export: start${detail ? ` "${detailName || detail}"` : ""}`);
  try {
    const response = await api.fetchApi(entry.exportPath(detail));
    if (!response.ok) reason = `HTTP ${response.status}`;
    ok = await downloadResponseBlob(response, entry.exportName(detail, detailName));
  } catch (err) {
    ok = false;
    reason = String(err?.message || err);
  }
  if (ok) log(entry.kind, "export: downloaded");
  else {
    log(entry.kind, `export: FAILED${reason ? ` (${reason})` : ""}`, { failed: true });
    notify(`Could not export ${entry.noun}.`);
  }
  return { ok };
}

export async function importTransfer(kind, { node = null, sources = null, notify = (message) => defaultNotify(message, node) } = {}) {
  const entry = transferKind(kind);
  if (!entry) return { ok: false };
  const files = await pickFiles(entry);
  if (!files.length) {
    log(entry.kind, "import: no file chosen");
    return { ok: false, cancelled: true };
  }
  log(entry.kind, `import: picked ${fileText(files)}, sending`);

  let outcome;
  try {
    outcome = await readOutcome(await entry.request(files));
  } catch (err) {
    outcome = { ok: false, result: null, error: String(err?.message || err) };
  }
  if (!outcome.ok) {
    log(entry.kind, `import: FAILED${outcome.error ? ` (${outcome.error})` : ""}`, { failed: true });
    notify(`Could not import ${entry.noun}${outcome.error ? `: ${outcome.error}` : "."}`);
    return { ok: false, result: outcome.result };
  }
  log(entry.kind, "import: ok");

  publishTransferEvents(entry.kind, entry.events, sources);
  const message = entry.summary?.(outcome.result);
  if (message) notify(message);
  return { ok: true, result: outcome.result };
}
