/*
 * KRC shared sync bus.
 *
 * Small CustomEvent wrapper for node-local surfaces that mirror a shared
 * disk-backed store. Event names stay explicit and backwards-compatible; this
 * module standardizes the detail payload so content, metadata, and structure
 * changes can travel on different lanes across Prompt Vault, LoRA Loadout,
 * Word Bank, and Config Switcher.
 */

import { forgetInFlight } from "./api.js";

export const KRC_SYNC_LANES = Object.freeze({
  CONTENT: "content",
  METADATA: "metadata",
  STRUCTURE: "structure",
});

export const KRC_SYNC_EVENTS = Object.freeze({
  LORA_METADATA_CHANGED: "krc-lora-metadata-changed",
  // Fired when the prompt store changed OUT OF BAND — a mutation that did not
  // originate from a PV controller on this page (a bulk import that reload()s
  // itself, and later a workflow write-node / the KRC Editor). Same-page saves
  // use publishPromptLibrary (in-memory sibling push, no refetch) instead.
  // Carry `source` so the emitter can skip its own echo via isOwnSyncEvent.
  PROMPTS_CHANGED: "krc-prompts-changed",
  // Fired when a library node finishes a forced disk re-scan (the set of files on
  // disk may have changed — a new/removed model or LoRA, an import). Sibling library
  // surfaces (the other node type, other instances, an open portal) listen and
  // re-scan so the item list never drifts between LoRA Loadout and Model Library.
  // Sync-triggered reloads carry no re-broadcast; `source` lets the emitter skip its
  // own echo via isOwnSyncEvent.
  LIBRARY_CHANGED: "krc-library-changed",
  // The server rescanned because files moved / appeared / vanished outside KRC (a folder
  // change or a run-time heal) and pushed it to every open page (library_heal_client.js).
  // `heal: { lineage: "loras" | "models", scanId, moves: {id: {path, relativePath}},
  // added, removed }`. Path healing step 3.
  LIBRARY_HEALED: "krc-library-healed",
  // Fired when a node promotes a path-derived (local-) id to a content SHA256 (a
  // stabilize). A LoRA has ONE id space (Model Library read-throughs LoRA Loadout's
  // index), so a promotion is valid on every surface holding the stale id. Siblings
  // remap in place (applyIdentityChange) so a freshly stabilized item is immediately
  // draggable / resolvable in presets without a rescan or a ComfyUI restart. Carries
  // `identity: { oldId, newId }`; `source` lets the emitter skip its own echo.
  IDENTITY_CHANGED: "krc-identity-changed",
  // Fired when the shared Collections store changed (create/rename/pin/delete a collection,
  // add/remove a member). Membership is cross-node (models + LoRAs) and external to every
  // record, so every InfoPanel + collection viewer listens and reconciles its cached
  // collections + reverse index. Carries `source` so the emitter skips its own echo.
  COLLECTIONS_CHANGED: "krc-collections-changed",
  // Per-node preset stores (names predate this table; each node file still publishes the
  // literal). Named here so node-independent code — the shared import/export runner
  // (shared/transfer/) — can announce an import to every open node. An event with
  // `refetch: true` means the server store changed with no fresh in-page cache to adopt.
  LORA_PRESETS_CHANGED: "krc-lora-presets-changed",
  WORDBANK_PRESETS_CHANGED: "krc-wordbank-presets-changed",
  CONFIG_SWITCHER_PRESETS_CHANGED: "krc-config-switcher-presets-changed",
  // Fired when the set of Word Bank banks changed out of band (a .txt or bundle import):
  // every WB node refetches the bank list and rebuilds its row pickers.
  WORDBANK_BANKS_CHANGED: "krc-wordbank-banks-changed",
  // Fired by Prompt Vault whenever its in-page library changes (every save, and each
  // library load), carrying the whole library as `prompts` ({category: {name: record}}).
  // For consumers outside Prompt Vault — Config Switcher prompt cards read their display
  // data from it (CS_LIVE_CARDS_GAMEPLAN.md step 3). PV siblings keep their direct push.
  PROMPT_LIBRARY_UPDATED: "krc-prompt-library-updated",
});

const VALID_LANES = new Set(Object.values(KRC_SYNC_LANES));

export function normalizeSyncLane(lane, fallback = KRC_SYNC_LANES.STRUCTURE) {
  return VALID_LANES.has(lane) ? lane : fallback;
}

export function publishKrcSync(eventName, detail = {}) {
  if (typeof window === "undefined" || !eventName) return;
  // Library-loaded announcements are snapshots, not mutations. Invalidating on
  // those would make simultaneous readers continually invalidate each other.
  if ([KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, KRC_SYNC_EVENTS.LIBRARY_CHANGED,
    KRC_SYNC_EVENTS.LIBRARY_HEALED, KRC_SYNC_EVENTS.IDENTITY_CHANGED,
    KRC_SYNC_EVENTS.PROMPTS_CHANGED].includes(eventName)) forgetInFlight();
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      ...detail,
      lane: normalizeSyncLane(detail.lane),
    },
  }));
}

export function subscribeKrcSync(eventName, handler) {
  if (typeof window === "undefined" || !eventName || typeof handler !== "function") {
    return () => {};
  }
  const wrapped = (event) => handler(event);
  window.addEventListener(eventName, wrapped);
  return () => window.removeEventListener(eventName, wrapped);
}

export function isOwnSyncEvent(event, source) {
  return !!source && event?.detail?.source === source;
}
