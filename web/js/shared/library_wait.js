// A card dropped on a stack slot is added only if the node's own library list has it.
// A freshly placed node may still be loading that list (or showing an older snapshot), so
// an early drop used to be ignored silently. Wait for the in-flight load, refresh the list
// once if the card still isn't there (it may be newer than the list), then answer.
// Shared by LoRA Loadout / LL mini and the Loadout Kit (RefMod, ...).

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

export async function ensureLibraryHas(panel, id, { timeoutMs = 15000 } = {}) {
  if (!panel || !id) return false;
  const canon = (value) => panel.canonicalId?.(value) || value;
  const has = () => {
    const want = canon(id);   // re-read: aliases arrive with the list
    return (panel.loras || []).some((item) => canon(item.sha256) === want);
  };
  if (has()) return true;
  const started = Date.now();
  while (panel.isLoadingLibrary && !panel._destroyed && Date.now() - started < timeoutMs) await frame();
  if (has()) return true;
  if (!panel.isLoadingLibrary && !panel._destroyed) await panel.loadLibrary?.();
  return has();
}

// A loadLibrary call while one is running (a sibling's change can land mid-load, after
// that load read the store) used to be dropped, leaving the list stale. Remember it
// instead, merged with any other, and run one more load when the current one ends.
export function queueLibraryLoad(panel, options = {}) {
  const queued = panel._queuedLibraryLoad;
  panel._queuedLibraryLoad = queued ? {
    ...queued,
    ...options,
    force: Boolean(queued.force || options.force),
    changed: Boolean(queued.changed || options.changed),
    restoreScroll: Boolean(queued.restoreScroll || options.restoreScroll),
    focusSelection: Boolean(queued.focusSelection || options.focusSelection),
    // It broadcasts unless every merged call came from a sync (no ping-pong).
    fromSync: Boolean(queued.fromSync && options.fromSync),
  } : { ...options };
}

export function runQueuedLibraryLoad(panel) {
  const queued = panel._queuedLibraryLoad;
  panel._queuedLibraryLoad = null;
  if (queued && !panel._destroyed) panel.loadLibrary(queued);
}
