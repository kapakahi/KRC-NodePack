// ID-based membership and lifecycle; no DOM, storage, or provider mutations.
// The clock is injectable so inactivity and operation suspension can be tested.
export function createSelectionController({
  items, keyOf, allItems = items, scope = () => "", filters = () => "",
  timeoutMs = 120000, schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (typeof items !== "function" || typeof keyOf !== "function") throw new TypeError("Selection requires items() and keyOf(item)");
  let active = false;
  let busy = 0;
  let anchor = null;
  let timer = null;
  let destroyed = false;
  let context = null;
  let reason = "initial";
  let ids = new Set();
  let availableSource = null;
  let availableLength = -1;
  let available = new Set();
  const listeners = new Set();
  const rows = (get) => (get() || []).filter((item) => !item.__draft && keyOf(item) != null && String(keyOf(item)) !== "");
  const readContext = () => ({ scope: JSON.stringify(scope()), filters: JSON.stringify(filters()) });
  const status = () => ({ active, busy: busy > 0, count: ids.size, reason });
  const snapshot = () => ({ ...status(), ids: [...ids] });
  const emit = (why) => { reason = why; for (const listener of listeners) listener(snapshot()); };
  const stopTimer = () => { if (timer !== null) cancel(timer); timer = null; };
  function touch() {
    stopTimer();
    if (active && !busy && !destroyed) timer = schedule(() => { timer = null; exit("inactivity"); }, timeoutMs);
  }
  function exit(why = "done", force = false) {
    if (busy && !force) return false;
    const changed = active || ids.size > 0;
    stopTimer();
    active = false;
    ids.clear();
    anchor = null;
    if (changed) emit(why);
    return changed;
  }
  function refresh({ invalidate = true } = {}) {
    if (destroyed) return;
    if (invalidate) availableSource = null;
    const next = readContext();
    const previous = context;
    context = next;
    if (!active || busy) return;
    if (previous && next.scope !== previous.scope) { exit("scope"); return; }
    if (previous && next.filters !== previous.filters) {
      ids.clear(); anchor = null; emit("filters"); return;
    }
    if (!ids.size) return;
    const source = allItems() || [];
    if (source !== availableSource || source.length !== availableLength) {
      available = new Set(rows(() => source).map((item) => String(keyOf(item))));
      availableSource = source; availableLength = source.length;
    } else return;
    const removed = [...ids].filter((id) => !available.has(id));
    if (removed.length) {
      removed.forEach((id) => ids.delete(id));
      if (!available.has(anchor)) anchor = null;
      emit("removed");
    }
  }
  function enter() {
    if (destroyed || busy) return;
    context = readContext(); active = true; ids.clear(); anchor = null;
    touch(); emit("enter");
  }
  function toggle(id, { range = false } = {}) {
    refresh();
    if (!active || busy || destroyed) return;
    id = String(id);
    const ordered = rows(items).map((item) => String(keyOf(item)));
    const target = ordered.indexOf(id);
    if (target < 0) return;
    const start = range && anchor !== null ? ordered.indexOf(anchor) : -1;
    if (start >= 0) {
      ordered.slice(Math.min(start, target), Math.max(start, target) + 1).forEach((key) => ids.add(key));
    } else {
      if (ids.has(id)) ids.delete(id); else ids.add(id);
      anchor = id;
    }
    touch(); emit("toggle");
  }
  function selectAll() {
    refresh();
    if (!active || busy || destroyed) return;
    rows(items).forEach((item) => ids.add(String(keyOf(item))));
    anchor = null; touch(); emit("select-all");
  }
  function clear() {
    if (!active || busy || destroyed) return;
    ids.clear(); anchor = null; touch(); emit("clear");
  }
  function remapIds(resolve) {
    if (destroyed || !active) return;
    const next = new Set([...ids].map((id) => String(resolve(id) || id)));
    const changed = next.size !== ids.size || [...ids].some((id) => !next.has(id));
    ids = next;
    availableSource = null;
    if (anchor !== null) anchor = String(resolve(anchor) || anchor);
    if (changed) emit("identity");
  }
  function selectedItems() {
    refresh();
    return rows(allItems).filter((item) => ids.has(String(keyOf(item))));
  }
  return {
    snapshot, status, has: (id) => ids.has(String(id)), enter, exit, toggle, selectAll, clear, touch, refresh, selectedItems, remapIds,
    remap: (oldId, newId) => remapIds((id) => id === String(oldId) ? newId : id),
    eligibleCount: (eligible) => selectedItems().filter(eligible).length,
    retain(remaining) {
      if (!active || busy || destroyed) return;
      const keep = new Set(remaining.map(String));
      ids = new Set([...ids].filter((id) => keep.has(id)));
      anchor = null; touch(); emit("retry");
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // All lifecycle edits go through this: a batch's own writes cannot end it midway.
    endForEdit() { return exit("edit"); },
    beginOperation() {
      refresh();
      if (!active || destroyed) throw new Error("Selection mode is not active");
      busy++; stopTimer(); emit("operation-start");
      return [...ids];
    },
    finishOperation({ exit: shouldExit = true } = {}) {
      if (!busy || destroyed) return;
      busy--;
      if (busy) return;
      if (shouldExit) exit("operation-complete");
      else { refresh(); touch(); emit("operation-complete"); }
    },
    destroy() { exit("destroy", true); destroyed = true; listeners.clear(); },
  };
}
