// One cancellable boot path for ML, LL and Loadout Kit DOM widgets. Detached
// subgraphs can mount much later: observe attachment instead of timing out or
// polling every frame while hidden. A brief connected settle keeps sizing stable.
import { markDirty } from "./widgets.js";

export function startPanelWhenReady(panel, { stylesReady, isReady = () => true, onSettled = () => {} } = {}) {
  let cancelled = false;
  let started = false;
  let observer = null;
  let frame = null;
  let remaining = 3;
  const alive = () => !cancelled && !panel._destroyed;
  const connected = () => panel.root.isConnected && isReady();
  const clearWatch = () => {
    observer?.disconnect();
    observer = null;
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  };
  const schedule = () => {
    if (!alive() || started || frame !== null) return;
    // MutationObserver will wake detached nodes when their subgraph is attached.
    if (!panel.root.isConnected && observer) return;
    frame = requestAnimationFrame(check);
  };
  const check = () => {
    frame = null;
    if (!alive()) { clearWatch(); return; }
    if (!connected()) { remaining = 3; schedule(); return; }
    if (--remaining > 0) { schedule(); return; }
    started = true;
    clearWatch();
    markDirty(panel.node);
    panel.start();
    markDirty(panel.node);
    let settle = 2;
    const finish = () => {
      frame = null;
      if (!alive()) return;
      if (--settle > 0) { frame = requestAnimationFrame(finish); return; }
      onSettled();
      if (panel.root.isConnected) markDirty(panel.node);
    };
    frame = requestAnimationFrame(finish);
  };
  Promise.resolve(stylesReady).then(() => {
    if (!alive()) return;
    if (typeof MutationObserver !== "undefined") {
      observer = new MutationObserver(schedule);
      observer.observe(panel.root.ownerDocument?.documentElement || document.documentElement, { childList: true, subtree: true });
    }
    schedule();
  });
  return () => { cancelled = true; clearWatch(); };
}
