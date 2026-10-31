/*
 * KRC shared local-status engine (LOCAL_STATUS_AND_DRAFT_GAMEPLAN.md step 1).
 *
 * A node carries local values that can differ from a shared global store (a LoRA
 * Loadout preset, a Prompt Vault record, LoRA/Model metadata). Today every
 * difference reads as "Modified", which conflates two very different situations:
 *   - the user edited THIS node in THIS session               -> Modified
 *   - a newer global version was saved from somewhere ELSE     -> Stale
 * and a brand-new Prompt Vault prompt that has no global record yet is a third:
 *   - node-local draft not yet saved                           -> Draft
 *
 * This module is the single classifier + copy source for those states. It is
 * intentionally framework-free and DOM-free (no imports, no `document`), so every
 * node can call it the same way; the DOM badge/button that renders the result
 * lives in the shared badge layer (step 2).
 */

// Canonical stringification: key-sorted JSON so two structurally-equal values
// produce the same signature regardless of key insertion order. Handles the plain
// data (objects / arrays / primitives) that presets, prompts, and metadata are;
// mirrors JSON's own undefined handling (dropped in objects, null in arrays).
function canonicalJson(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return "[" + value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",") + "]";
  }
  if (typeof value === "object") {
    const parts = [];
    for (const key of Object.keys(value).sort()) {
      const child = value[key];
      if (child === undefined || typeof child === "function") continue;
      parts.push(JSON.stringify(key) + ":" + canonicalJson(child));
    }
    return "{" + parts.join(",") + "}";
  }
  if (typeof value === "function" || typeof value === "undefined") return "null";
  return JSON.stringify(value);
}

/**
 * A stable, comparable signature for a local/global value. Equal values (ignoring
 * key order) yield equal strings; empty/absent values yield "" so callers can treat
 * "no value" uniformly. Pass the already-normalized shape you want to compare — this
 * does not know a consumer's field vocabulary, only how to canonicalize it.
 */
export function stableSignature(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return canonicalJson(value);
}

const STATUS_CLEAN = "clean";
const STATUS_MODIFIED = "modified";
const STATUS_STALE = "stale";
const STATUS_DRAFT = "draft";
const STATUS_MISSING = "missing";
const STATUS_CONFLICT = "conflict";
const STATUS_OTHER = "other";

export const LOCAL_STATUS = Object.freeze({
  CLEAN: STATUS_CLEAN,
  MODIFIED: STATUS_MODIFIED,
  STALE: STATUS_STALE,
  DRAFT: STATUS_DRAFT,
  MISSING: STATUS_MISSING,
  CONFLICT: STATUS_CONFLICT,
  OTHER: STATUS_OTHER,
});

// The statuses whose save pushes this node's version over a newer saved one (the save
// button reads OVERWRITE): Stale, and Conflict (STATUS_CONFLICT_GAMEPLAN.md).
export function statusOverwrites(status) {
  return status === STATUS_STALE || status === STATUS_CONFLICT;
}

function toMillis(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Classify a node's local value against the global store.
 *
 * Inputs (all optional; sensible defaults):
 *   isDraft               - node-local record with no global counterpart yet. Wins
 *                           outright: a draft is never modified/stale (no global to
 *                           compare), it is just a Draft until saved.
 *   currentSignature      - signature of the value currently in the node.
 *   globalSignature       - signature of the value currently in the global store.
 *   loadedGlobalSignature - the global signature captured when this node last loaded
 *                           the global value (its baseline). Enables the fallback
 *                           "global changed since I loaded it" stale proof.
 *   currentGlobalModifiedAt / loadedGlobalModifiedAt - the store's modified/revision
 *                           value now vs. when the node loaded. The PREFERRED stale
 *                           signal: a freshness stamp, not a bare mismatch.
 *   userTouched           - whether the user edited the local value after load.
 *
 * Returns one of LOCAL_STATUS. "Stale" is only ever claimed from a freshness signal
 * (a newer timestamp, or a proven baseline change) — never from mismatch alone, so a
 * node that merely holds an older copy without proof of "newer" reads as Modified.
 * "Conflict" is a local edit AND a saved version that moved since this node loaded it
 * (judged by content when there's a baseline, since a regroup re-stamps the date alone).
 */
export function classifyLocalStatus({
  isDraft = false,
  currentSignature = "",
  globalSignature = "",
  loadedGlobalSignature = "",
  currentGlobalModifiedAt = 0,
  loadedGlobalModifiedAt = 0,
  userTouched = false,
} = {}) {
  if (isDraft) return STATUS_DRAFT;
  // No global version: either the node holds orphaned local values (the global
  // record/preset was deleted elsewhere) or there is genuinely nothing yet.
  if (!globalSignature) return currentSignature ? STATUS_MISSING : STATUS_CLEAN;
  if (currentSignature === globalSignature) return STATUS_CLEAN;
  // A local edit reads as the user's own change, never stale; when the saved version
  // also moved since this node loaded it, both changed: Conflict.
  if (userTouched) {
    // No baseline at all (nothing loaded to compare with) is no proof it moved.
    const globalMoved = loadedGlobalSignature
      ? globalSignature !== loadedGlobalSignature
      : toMillis(loadedGlobalModifiedAt) > 0 && toMillis(currentGlobalModifiedAt) > toMillis(loadedGlobalModifiedAt);
    return globalMoved ? STATUS_CONFLICT : STATUS_MODIFIED;
  }
  // Preferred: the global store is provably newer than the copy this node loaded.
  if (toMillis(currentGlobalModifiedAt) > toMillis(loadedGlobalModifiedAt)) return STATUS_STALE;
  // Fallback: the node captured a global baseline at load and that baseline has
  // since changed — proof the global moved even without a usable timestamp.
  if (loadedGlobalSignature && globalSignature !== loadedGlobalSignature) return STATUS_STALE;
  // Difference with no freshness proof: treat as the user's local change.
  return STATUS_MODIFIED;
}

// Default copy profiles, one per surface. Text is the product vocabulary from
// LOCAL_STATUS_AND_DRAFT_GAMEPLAN.md; a consumer may pass its own profile of the
// same shape to localStatusCopy() to override any noun. `draftSave` is only used by
// surfaces that have a Draft state (Prompt Vault).
export const LOCAL_STATUS_COPY = Object.freeze({
  preset: {
    badge: {
      modified: "This preset has unsaved changes. Click to discard them.",
      stale: "A newer saved version of this preset exists. Click to pull latest.",
      conflict: "You changed this preset here, and a newer version was saved elsewhere. Click to choose which to keep.",
      missing: "The saved preset no longer exists. Click to discard this node's copy.",
    },
    action: {
      save: { label: "SAVE", title: "Save this node's preset as the global preset." },
      sync: { label: "OVERWRITE", title: "Overwrite the newer saved preset with this node's version." },
    },
  },
  prompt: {
    badge: {
      modified: "This prompt has unsaved changes. Click to discard them.",
      stale: "A newer saved version of this prompt exists. Click to pull latest.",
      conflict: "You changed this prompt here, and a newer version was saved elsewhere. Click to choose which to keep.",
      draft: "Draft prompt has not been saved to Prompt Vault.",
      missing: "The saved prompt no longer exists. Click to discard this node's copy.",
      other: "This prompt belongs to another profile. SAVE a copy in the active profile, or DISCARD to clear and return to NEW.",
    },
    action: {
      save: { label: "SAVE", title: "Save this node's prompt to Prompt Vault." },
      sync: { label: "OVERWRITE", title: "Overwrite the newer saved prompt with this node's version." },
      draftSave: { label: "SAVE", title: "Save draft to Prompt Vault." },
    },
  },
  metadata: {
    badge: {
      modified: "This metadata has unsaved changes. Click to discard them.",
      stale: "A newer saved version of this metadata exists. Click to pull latest.",
      conflict: "You changed this metadata here, and a newer version was saved elsewhere. Click to choose which to keep.",
      missing: "The saved metadata no longer exists. Click to discard this node's copy.",
    },
    action: {
      save: { label: "SAVE", title: "Save this node's metadata as global metadata." },
      sync: { label: "OVERWRITE", title: "Overwrite the newer saved metadata with this node's version." },
    },
  },
});

// Badge label + semantic class per status (color/label change only; see the
// .krc-status-badge.is-* / .krc-action-button.is-* classes in the gameplan).
const BADGE_META = {
  [STATUS_MODIFIED]: { label: "Modified", badgeClass: "is-modified" },
  [STATUS_STALE]: { label: "Stale", badgeClass: "is-stale" },
  [STATUS_DRAFT]: { label: "Draft", badgeClass: "is-draft" },
  [STATUS_MISSING]: { label: "Missing", badgeClass: "is-missing" },
  [STATUS_CONFLICT]: { label: "Conflict", badgeClass: "is-conflict" },
  // Ownership is independent of content modification. Reuse the established badge
  // sizing/palette; consumers opt in without changing the content classifier.
  [STATUS_OTHER]: { label: "OTHER", badgeClass: "is-other is-stale" },
};

// Which action (and its class) each status drives. Stale is the only push-that-
// -isn't-a-plain-save, so it maps to SYNC; a draft saves via the draftSave copy.
function actionKeyForStatus(status) {
  if (status === STATUS_STALE || status === STATUS_CONFLICT) return { key: "sync", actionClass: "is-sync" };
  if (status === STATUS_DRAFT) return { key: "draftSave", actionClass: "is-save" };
  return { key: "save", actionClass: "is-save" };
}

/**
 * Resolve a classified status into render-ready copy for one surface.
 *
 * `profile` is a LOCAL_STATUS_COPY entry (or the string key of one: "preset" /
 * "prompt" / "metadata"). Returns:
 *   {
 *     status,
 *     badge:  null when clean, else { label, title, badgeClass },
 *     action: { label, title, actionClass },
 *   }
 * The badge is null for a clean surface (nothing to show). The action is always
 * present so a save/sync button can read its label/title/class directly.
 */
export function localStatusCopy(status, profile) {
  const resolved = typeof profile === "string" ? LOCAL_STATUS_COPY[profile] : profile;
  const copy = resolved || {};
  const badgeCopy = copy.badge || {};
  const actionCopy = copy.action || {};

  const { key: actionKey, actionClass } = actionKeyForStatus(status);
  const action = actionCopy[actionKey] || actionCopy.save || { label: "SAVE", title: "" };

  const meta = BADGE_META[status];
  const badge = meta
    ? {
        label: meta.label,
        title: badgeCopy[status] || "",
        badgeClass: meta.badgeClass,
      }
    : null;

  return {
    status,
    badge,
    action: { label: action.label, title: action.title, actionClass },
  };
}
