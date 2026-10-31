// One visibility observer for Media previews. Detached cached boxes can return later;
// weak registration avoids keeping abandoned nodes/Portal previews alive indefinitely.
const states = new WeakMap();
const tracked = new Set();
let intersection = null;
let mutations = null;
let frame = null;
let installed = false;

function update(box, state) {
  const visible = box.isConnected && state.intersects && document.visibilityState !== "hidden";
  if (visible === state.visible) return;
  state.visible = visible;
  state.change(visible);
}

function checkBox(box, state) {
  if (box.isConnected !== state.connected) {
    state.connected = box.isConnected;
    if (intersection) {
      state.intersects = false;
      if (state.connected) intersection.observe(box);
      else intersection.unobserve(box);
    }
  }
  if (!intersection) {
    const rect = box.getBoundingClientRect?.();
    state.intersects = box.isConnected && (!box.getClientRects || box.getClientRects().length > 0)
      && (!rect || (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
        && rect.top < window.innerHeight && rect.left < window.innerWidth));
  }
  update(box, state);
}

function check() {
  frame = null;
  for (const ref of tracked) {
    const box = ref.deref();
    if (!box) { tracked.delete(ref); continue; }
    const state = states.get(box);
    if (!state) { tracked.delete(ref); continue; }
    checkBox(box, state);
  }
  if (!tracked.size) stop();
}

function schedule() {
  if (document.visibilityState === "hidden") {
    if (frame !== null) cancelAnimationFrame(frame);
    check();
    return;
  }
  if (frame === null) frame = requestAnimationFrame(check);
}

function visibility() {
  // Pause immediately on a hidden tab; animation frames may be suspended there.
  for (const ref of tracked) {
    const box = ref.deref();
    const state = box && states.get(box);
    if (!state) continue;
    if (document.visibilityState !== "hidden" && intersection && box.isConnected) {
      // Refresh geometry before resuming: the graph or Portal may have changed
      // while the tab was hidden, without an intersection callback yet.
      state.intersects = false;
      intersection.unobserve(box); intersection.observe(box);
    }
    update(box, state);
  }
  if (document.visibilityState !== "hidden") schedule();
}

function blur() {
  for (const ref of tracked) {
    const box = ref.deref();
    const state = box && states.get(box);
    state?.change(state.visible, "blur");
  }
}

function start() {
  if (installed) return;
  installed = true;
  if (typeof IntersectionObserver === "function") {
    intersection = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const state = states.get(entry.target);
        if (!state) continue;
        state.intersects = entry.isIntersecting && entry.intersectionRatio > 0;
        update(entry.target, state);
      }
    });
  }
  if (typeof MutationObserver === "function") {
    mutations = new MutationObserver(schedule);
    mutations.observe(document.documentElement, { childList: true, subtree: true,
      ...(!intersection ? { attributes: true, attributeFilter: ["style", "class", "hidden"] } : {}) });
  }
  document.addEventListener?.("visibilitychange", visibility);
  window.addEventListener("blur", blur);
  // IO tracks scrolling, ancestor visibility, resizing and graph transforms natively.
  if (!intersection) {
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
  }
}

function stop() {
  intersection?.disconnect(); mutations?.disconnect();
  intersection = mutations = null;
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
  document.removeEventListener?.("visibilitychange", visibility);
  window.removeEventListener("blur", blur);
  window.removeEventListener("scroll", schedule, true);
  window.removeEventListener("resize", schedule);
  installed = false;
}

export function watchPreviewVisibility(box, change) {
  start();
  const ref = new WeakRef(box);
  const state = { change, visible: false, intersects: false, connected: false };
  states.set(box, state); tracked.add(ref);
  checkBox(box, state);
  return () => {
    if (states.get(box) !== state) return;
    states.delete(box); tracked.delete(ref);
    if (state.connected) intersection?.unobserve(box);
    if (!tracked.size) stop();
  };
}
