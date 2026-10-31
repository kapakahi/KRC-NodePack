// Slot card snapshots (CARD_MISSING_STATUS_GAMEPLAN.md step 2b): a stack slot stores only
// its card id, so a card that isn't in this machine's library (moved away, or a workflow
// shared from another machine) used to read "Unknown LoRA". Like Config Switcher's options,
// each slot now keeps how its card looked: title + badges (no thumbnail, which is a file
// on the original machine).
//
// Display only: the id stays the entry's whole identity, nothing resolves by a snapshot
// and it never enters a preset's Modified / Stale signature.
//
// Where it lives:
//   node.properties.krcCardSnapshots = { id: snapshot }
//     saved with the workflow but not a run input, so refreshing it (a rename in the
//     Portal) never makes ComfyUI re-run the loader. Written silently (no "unsaved"
//     mark); it rides along with the next workflow save.
//   preset entries' `card`
//     so a preset loaded elsewhere shows real names too. The LL and Loadout Kit preset
//     stores keep unknown entry fields.

const PROP = "krcCardSnapshots";

// A library item's display fields (LL / Model Library rows, kit provider items).
export function cardSnapshotOf(item) {
  if (!item || typeof item !== "object") return null;
  const title = String(item.display_name || item.title || item.name || "").trim();
  if (!title) return null;
  return {
    title,
    cardColor: String(item.cardColor || ""),
    favorite: Boolean(item.favorite),
    nsfw: Boolean(item.nsfw),
    customBadge: String(item.customBadge || ""),
  };
}

function snapshots(node) {
  const map = node?.properties?.[PROP];
  return map && typeof map === "object" ? map : null;
}

function writeSnapshots(node, map) {
  if (!node) return;
  node.properties ||= {};
  node.properties[PROP] = map;
}

export function readCardSnapshot(node, id) {
  const snap = id ? snapshots(node)?.[id] : null;
  return snap && typeof snap === "object" && snap.title ? snap : null;
}

// Keep the node's snapshot of a present card current. Returns whether it changed.
export function rememberCardSnapshot(node, id, item) {
  const next = cardSnapshotOf(item);
  if (!id || !next) return false;
  const current = readCardSnapshot(node, id);
  if (current && JSON.stringify(current) === JSON.stringify(next)) return false;
  writeSnapshots(node, { ...(snapshots(node) || {}), [id]: next });
  return true;
}

// A preset's saved entries carry `card`: take those the node doesn't know yet (a live
// card refreshes its own snapshot as soon as it renders).
export function adoptCardSnapshots(node, entries) {
  const map = { ...(snapshots(node) || {}) };
  let changed = false;
  for (const entry of entries || []) {
    const id = String(entry?.sha256 || entry?.id || "");
    const card = entry?.card;
    if (!id || map[id] || !card || typeof card !== "object" || !card.title) continue;
    map[id] = { ...card };
    changed = true;
  }
  if (changed) writeSnapshots(node, map);
}

// Drop snapshots for ids no longer in any of the node's stacks.
export function pruneCardSnapshots(node, ids) {
  const map = snapshots(node);
  if (!map) return;
  const keep = new Set(ids);
  const next = Object.fromEntries(Object.entries(map).filter(([id]) => keep.has(id)));
  if (Object.keys(next).length !== Object.keys(map).length) writeSnapshots(node, next);
}

// The `card` field for a saved preset entry ({} spread when there is none).
export function presetEntryCard(node, id) {
  const snap = readCardSnapshot(node, id);
  return snap ? { card: { ...snap } } : {};
}

// The item a missing slot renders: the snapshot's title and badges (the shared missing
// look drops the colour). Without one, only the id.
export function missingSlotItem(node, id) {
  const snap = readCardSnapshot(node, id);
  return {
    sha256: id,
    __missing: true,
    ...(snap ? { display_name: snap.title, favorite: snap.favorite, nsfw: snap.nsfw, customBadge: snap.customBadge } : {}),
  };
}
