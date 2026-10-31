/*
 * KRC shared DOM helpers.
 * Keep this browser-only and state-free; ComfyUI node/widget helpers live in
 * shared/widgets.js.
 */

export function el(tag, cls = "", extra) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (extra) Object.assign(node, extra);
  return node;
}

export function stopCanvasEvents(element) {
  ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "keydown", "keyup", "keypress"].forEach((type) => {
    element.addEventListener(type, (event) => event.stopPropagation());
  });
}

export function waitFrames(count = 1) {
  return new Promise((resolve) => {
    const step = (remaining) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(() => step(remaining - 1));
    };
    step(count);
  });
}

export async function waitForDomReady(element, {
  isReady = null,
  maxFrames = 45,
  settleFrames = 2,
} = {}) {
  const ready = () => (
    !!element?.isConnected
    && (!isReady || isReady())
  );

  for (let i = 0; i < maxFrames; i += 1) {
    if (ready()) {
      await waitFrames(settleFrames);
      if (ready()) return true;
    }
    await waitFrames(1);
  }
  return ready();
}

let _krcCanvasDragSelectionGuardInstalled = false;
export function installCanvasDragSelectionGuard() {
  installKrcDragLayoutProfiler();
  if (_krcCanvasDragSelectionGuardInstalled) return;
  _krcCanvasDragSelectionGuardInstalled = true;

  let pointerId = null;
  let editableStart = null;
  const docEl = document.documentElement;
  const stop = () => {
    pointerId = null;
    editableStart = null;
    docEl.classList.remove("krc-canvas-select-guard");
    docEl.classList.remove("krc-canvas-dragging");
  };
  const clearSelection = () => {
    const selection = window.getSelection?.();
    if (selection && !selection.isCollapsed) selection.removeAllRanges();
  };
  const isEditableGesture = (target) => {
    const editable = target?.closest?.([
      "input",
      "textarea",
      "select",
      "button",
      "a[href]",
      "[contenteditable='true']",
      "[role='button']",
      ".krc-selectable",
    ].join(","));
    return !!editable;
  };
  // A gesture that begins inside a real text control (a text/number input, a
  // textarea, or a contenteditable) is caret placement or a drag-to-highlight,
  // never a canvas pan. The guard must stay OFF for the whole gesture: it forces
  // user-select:none !important and blocks `selectstart`, and its 6px threshold
  // would clear any range the moment you drag past it — making text impossible to
  // select with the mouse. `<select>`/buttons/links aren't text-selectable, so
  // they stay on the normal (threshold) path.
  const isTextEditable = (target) =>
    !!target?.closest?.("input:not([type='button']):not([type='checkbox']):not([type='radio']):not([type='range']), textarea, [contenteditable='true']");

  window.addEventListener("pointerdown", (event) => {
    // A gesture that begins on a native-draggable element (a stack reorder handle,
    // a browser card, the info thumb) is an HTML5 drag, not a canvas pan — so the
    // selection guard must NOT engage: Firefox refuses to start a drag on an
    // element carrying user-select:none, and the guard sets exactly that on
    // everything while the pointer is down. Engaging it here silently kills
    // drag-to-reorder / drag-to-stack. Leave those gestures alone.
    if (event.target?.closest?.('[draggable="true"]')) {
      return;
    }
    // Keep normal editing when the gesture starts in a real control. Everything
    // else may become a LiteGraph canvas/node drag under the Vue frontend, even
    // when it begins on a KRC DOM surface; those drags sweep across text fields
    // in many nodes and create flashing selection ranges.
    pointerId = event.pointerId;
    // Real text controls: never engage the guard, so native selection/caret work.
    if (isTextEditable(event.target)) {
      editableStart = null;
      return;
    }
    docEl.classList.add("krc-canvas-select-guard");
    editableStart = isEditableGesture(event.target)
      ? { x: event.clientX, y: event.clientY }
      : null;
    if (editableStart) return;
    docEl.classList.add("krc-canvas-dragging");
    clearSelection();
  }, { capture: true });

  window.addEventListener("pointermove", (event) => {
    if (pointerId === null || event.pointerId !== pointerId || !editableStart) return;
    const dx = event.clientX - editableStart.x;
    const dy = event.clientY - editableStart.y;
    if ((dx * dx + dy * dy) < 36) return;
    editableStart = null;
    docEl.classList.add("krc-canvas-dragging");
    clearSelection();
  }, { capture: true });

  window.addEventListener("pointerup", stop, { capture: true });
  window.addEventListener("pointercancel", stop, { capture: true });
  window.addEventListener("blur", stop);
  window.addEventListener("selectstart", (event) => {
    if (!docEl.classList.contains("krc-canvas-select-guard")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, { capture: true });
}

let _krcDragLayoutProfilerInstalled = false;
function installKrcDragLayoutProfiler() {
  if (_krcDragLayoutProfilerInstalled || typeof window === "undefined") return;
  _krcDragLayoutProfilerInstalled = true;

  const percent = (values, pct) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    return Number(sorted[Math.min(sorted.length - 1, Math.floor((pct / 100) * sorted.length))].toFixed(2));
  };

  const addStat = (stats, key, elapsed) => {
    const item = stats[key] || (stats[key] = { count: 0, totalMs: 0, maxMs: 0 });
    item.count += 1;
    item.totalMs += elapsed;
    item.maxMs = Math.max(item.maxMs, elapsed);
  };

  const summarizeStats = (stats) => Object.fromEntries(
    Object.entries(stats).map(([key, item]) => [key, {
      count: item.count,
      totalMs: Number(item.totalMs.toFixed(2)),
      avgMs: Number((item.totalMs / Math.max(1, item.count)).toFixed(3)),
      maxMs: Number(item.maxMs.toFixed(2)),
    }])
  );

  const wrapMethod = (target, method, label, stats, restore) => {
    if (!target || typeof target[method] !== "function") return;
    const original = target[method];
    target[method] = function (...args) {
      const start = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        addStat(stats, label, performance.now() - start);
      }
    };
    restore.push(() => {
      target[method] = original;
    });
  };

  const describeNode = (node) => ({
    id: node?.id,
    type: node?.comfyClass || node?.type,
    pos: node?.pos ? [...node.pos] : null,
    size: node?.size ? [...node.size] : null,
    widgets: (node?.widgets || []).map((widget, index) => ({
      index,
      name: widget.name,
      type: widget.type,
      hidden: !!widget.hidden,
      hasElement: !!widget.element,
    })),
  });

  window.krcDragLayoutStats = (options = {}) => {
    const countdownMs = Number(options.countdownMs ?? options.countdown ?? 2500);
    const durationMs = Number(options.durationMs ?? options.duration ?? 5000);
    const canvasApi = window.app?.canvas;
    const canvas = canvasApi?.canvas || document.querySelector("canvas");
    const graph = window.app?.graph;
    if (!canvasApi || !graph) {
      console.error("[KRC Drag Layout] stats: app.canvas/app.graph not found");
      return null;
    }

    const nodes = Object.values(canvasApi.selected_nodes || {});
    const selectedAtStart = nodes.map(describeNode);
    const nodeStats = {};
    const canvasStats = {};
    const restore = [];
    const frames = [];
    const pointerGaps = [];
    const mouseGaps = [];
    const nodePositions = [];
    const nodeSizes = [];
    const errors = [];
    let pointerEvents = 0;
    let mouseEvents = 0;
    let lastPointerTs = 0;
    let lastMouseTs = 0;
    let rafId = 0;
    let startedAt = 0;
    let lastRaf = 0;

    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      top: "14px",
      right: "14px",
      zIndex: 999999,
      padding: "9px 11px",
      borderRadius: "6px",
      background: "rgba(20, 20, 20, 0.9)",
      color: "white",
      font: "12px system-ui, sans-serif",
      pointerEvents: "none",
    });
    document.body.appendChild(box);

    for (const node of nodes) {
      const prefix = `${node.id}:${node.comfyClass || node.type}`;
      wrapMethod(node, "computeSize", `${prefix}.node.computeSize`, nodeStats, restore);
      wrapMethod(node, "onResize", `${prefix}.node.onResize`, nodeStats, restore);
      wrapMethod(node, "onDrawForeground", `${prefix}.node.onDrawForeground`, nodeStats, restore);
      wrapMethod(node, "onDrawBackground", `${prefix}.node.onDrawBackground`, nodeStats, restore);
      wrapMethod(node, "onDrawTitle", `${prefix}.node.onDrawTitle`, nodeStats, restore);
      for (const [index, widget] of (node.widgets || []).entries()) {
        const widgetPrefix = `${prefix}.widget[${index}:${widget.name || widget.type || "unnamed"}]`;
        wrapMethod(widget, "computeSize", `${widgetPrefix}.computeSize`, nodeStats, restore);
        wrapMethod(widget, "getMinHeight", `${widgetPrefix}.getMinHeight`, nodeStats, restore);
        wrapMethod(widget, "draw", `${widgetPrefix}.draw`, nodeStats, restore);
      }
    }

    wrapMethod(canvasApi, "draw", "canvas.draw", canvasStats, restore);
    wrapMethod(canvasApi, "drawFrontCanvas", "canvas.drawFrontCanvas", canvasStats, restore);
    wrapMethod(canvasApi, "drawBackCanvas", "canvas.drawBackCanvas", canvasStats, restore);
    wrapMethod(canvasApi, "drawNode", "canvas.drawNode", canvasStats, restore);

    const onPointerMove = () => {
      const now = performance.now();
      pointerEvents += 1;
      if (lastPointerTs) pointerGaps.push(now - lastPointerTs);
      lastPointerTs = now;
    };
    const onMouseMove = () => {
      const now = performance.now();
      mouseEvents += 1;
      if (lastMouseTs) mouseGaps.push(now - lastMouseTs);
      lastMouseTs = now;
    };
    const onError = (event) => {
      errors.push(String(event.message || event.error || event));
    };

    const cleanup = () => {
      cancelAnimationFrame(rafId);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("mousemove", onMouseMove, true);
      canvas.removeEventListener("pointermove", onPointerMove, true);
      canvas.removeEventListener("mousemove", onMouseMove, true);
      window.removeEventListener("error", onError, true);
      for (const restoreOne of restore.reverse()) restoreOne();
    };

    const finish = () => {
      cleanup();
      const elapsedMs = performance.now() - startedAt;
      const movedFrames = nodePositions.filter((frame, index) => {
        if (!index) return false;
        return JSON.stringify(frame) !== JSON.stringify(nodePositions[index - 1]);
      }).length;
      const resizedFrames = nodeSizes.filter((frame, index) => {
        if (!index) return false;
        return JSON.stringify(frame) !== JSON.stringify(nodeSizes[index - 1]);
      }).length;
      const selectedAtEnd = Object.values(canvasApi.selected_nodes || {}).map(describeNode);
      const startSelectionKey = selectedAtStart.map((node) => node.id).sort().join(",");
      const endSelectionKey = selectedAtEnd.map((node) => node.id).sort().join(",");
      const warnings = [];
      if (startSelectionKey !== endSelectionKey) {
        warnings.push("Selected node changed during capture; selectedNode hook stats only cover the start selection.");
      }
      const result = {
        selectedAtStart,
        selectedAtEnd,
        elapsedMs: Number(elapsedMs.toFixed(1)),
        raf: {
          frames: frames.length,
          approxFps: Number((frames.length / (elapsedMs / 1000)).toFixed(1)),
          frameMs_p50: percent(frames, 50),
          frameMs_p95: percent(frames, 95),
          frameMs_p99: percent(frames, 99),
          frameMs_max: frames.length ? Number(Math.max(...frames).toFixed(2)) : 0,
          framesOver33ms: frames.filter((value) => value > 33.33).length,
          framesOver50ms: frames.filter((value) => value > 50).length,
        },
        events: {
          pointer: {
            count: pointerEvents,
            gapMs_p95: percent(pointerGaps, 95),
            gapMs_max: pointerGaps.length ? Number(Math.max(...pointerGaps).toFixed(2)) : 0,
          },
          mouse: {
            count: mouseEvents,
            gapMs_p95: percent(mouseGaps, 95),
            gapMs_max: mouseGaps.length ? Number(Math.max(...mouseGaps).toFixed(2)) : 0,
          },
        },
        movedFrames,
        resizedFrames,
        canvas: summarizeStats(canvasStats),
        selectedNode: summarizeStats(nodeStats),
        warnings,
        errors: [...new Set(errors)].slice(0, 12),
      };

      window.__krcLastDragLayoutStats = result;
      box.textContent = "KRC layout stats: done";
      setTimeout(() => box.remove(), 1600);
      console.log("[KRC Drag Layout] stats summary:");
      console.table({
        node: result.selectedAtStart.map((node) => node.type).join(", ") || "none",
        fps: result.raf.approxFps,
        p95_ms: result.raf.frameMs_p95,
        max_ms: result.raf.frameMs_max,
        over33: result.raf.framesOver33ms,
        resized_frames: result.resizedFrames,
        mouse_events: result.events.mouse.count,
        pointer_events: result.events.pointer.count,
        selected_hook_calls: Object.values(result.selectedNode).reduce((sum, item) => sum + item.count, 0),
        canvas_hook_calls: Object.values(result.canvas).reduce((sum, item) => sum + item.count, 0),
        warnings: result.warnings.length,
        errors: result.errors.length,
      });
      if (result.warnings.length) console.warn("[KRC Drag Layout] stats warnings:", result.warnings);
      console.log("[KRC Drag Layout] Full JSON is stored at window.__krcLastDragLayoutStats");
      console.log(JSON.stringify(result, null, 2));
      return result;
    };

    const measureTick = () => {
      const now = performance.now();
      frames.push(now - lastRaf);
      lastRaf = now;
      nodePositions.push(nodes.map((node) => ({
        id: node.id,
        x: Number((node.pos?.[0] ?? 0).toFixed(2)),
        y: Number((node.pos?.[1] ?? 0).toFixed(2)),
      })));
      nodeSizes.push(nodes.map((node) => ({
        id: node.id,
        w: Number((node.size?.[0] ?? 0).toFixed(2)),
        h: Number((node.size?.[1] ?? 0).toFixed(2)),
      })));
      const remaining = Math.max(0, durationMs - (now - startedAt));
      box.textContent = `KRC layout stats: DRAG NOW ${(remaining / 1000).toFixed(1)}s`;
      if (remaining > 0) rafId = requestAnimationFrame(measureTick);
      else finish();
    };

    const countdownStart = performance.now();
    const countdownTick = () => {
      const now = performance.now();
      const remaining = Math.max(0, countdownMs - (now - countdownStart));
      box.textContent = `KRC layout stats: ready in ${(remaining / 1000).toFixed(1)}s`;
      if (remaining > 0) {
        rafId = requestAnimationFrame(countdownTick);
        return;
      }
      window.addEventListener("pointermove", onPointerMove, true);
      window.addEventListener("mousemove", onMouseMove, true);
      canvas.addEventListener("pointermove", onPointerMove, true);
      canvas.addEventListener("mousemove", onMouseMove, true);
      window.addEventListener("error", onError, true);
      startedAt = performance.now();
      lastRaf = startedAt;
      rafId = requestAnimationFrame(measureTick);
    };

    rafId = requestAnimationFrame(countdownTick);
    return "KRC drag layout stats armed";
  };
}

// Node 2.0: wheel events over a DOM widget reach the LiteGraph canvas and ZOOM
// it instead of scrolling the widget's overflow containers. The Vue canvas
// catches wheel in the CAPTURE phase on an ancestor of the DOM widget, so a
// per-root listener (bubble OR capture) never fires — capture runs top-down, so
// the ancestor wins. Beat it by listening at the very top of the capture chain
// (window). Scoped to `.krc-node` roots so the rest of ComfyUI is untouched:
// over a KRC node we scroll the nearest scrollable ancestor and fully consume
// the event; anywhere else we do nothing and the canvas zooms as normal.
// (stopCanvasEvents deliberately omits wheel; the old canvas frontend handled it,
// the Vue frontend does not.) One global listener; the element arg is ignored.
let _krcWheelInstalled = false;
export function stopCanvasWheel() {
  installCanvasDragSelectionGuard();
  if (_krcWheelInstalled) return;
  _krcWheelInstalled = true;
  window.addEventListener("wheel", (event) => {
    const root = event.target?.closest?.(".krc-node");
    if (!root) return; // not over a KRC DOM node → let the canvas zoom

    // Over a scrollable <textarea>, let the browser scroll it NATIVELY. We still
    // stop propagation so the canvas-zoom listener (capture phase, on an ancestor
    // below us) never runs, but we deliberately do NOT preventDefault — that is
    // what allows the native textarea scroll. Replicating it via scrollTop was
    // unreliable in Firefox (a textarea's default computed overflow-y is "visible"
    // there, so the manual path below skipped it and killed native scroll too).
    const ta = event.target?.closest?.("textarea");
    if (ta && root.contains(ta) && ta.scrollHeight > ta.clientHeight) {
      event.stopPropagation();
      event.stopImmediatePropagation();
      return;
    }

    let node = event.target;
    let scroller = null;
    while (node && node !== root.parentElement) {
      if (node.scrollHeight > node.clientHeight) {
        const overflowY = getComputedStyle(node).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") { scroller = node; break; }
      }
      node = node.parentElement;
    }
    if (scroller) {
      // Normalize wheel units: Firefox may report deltas in lines (1) or pages (2)
      // rather than pixels (0), which would otherwise scroll a near-imperceptible
      // amount through the manual path.
      let dy = event.deltaY;
      if (event.deltaMode === 1) dy *= 16;                       // lines → px
      else if (event.deltaMode === 2) dy *= scroller.clientHeight; // pages → px
      scroller.scrollTop += dy;
    }
    // Consume the event either way: over KRC UI, wheel scrolls the list (or does
    // nothing on non-scrollable UI) but never zooms the canvas.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }, { passive: false, capture: true });
}

export function appendFragment(parent, children) {
  const fragment = document.createDocumentFragment();
  for (const child of children) {
    fragment.append(child);
  }
  parent.append(fragment);
  return parent;
}

export function cancelFrame(owner, prop) {
  if (!owner?.[prop]) {
    return;
  }
  cancelAnimationFrame(owner[prop]);
  owner[prop] = 0;
}

export function scheduleFrame(owner, prop, callback) {
  cancelFrame(owner, prop);
  owner[prop] = requestAnimationFrame(() => {
    owner[prop] = 0;
    callback();
  });
  return owner[prop];
}

// Time-based trailing-edge debounce. `scheduleFrame` coalesces to the next
// paint; this coalesces to `wait` ms of quiet — for high-frequency inputs
// (search typing, slider dragging) where the work should run once the user
// pauses, not every event. The returned function carries `.cancel()` to drop a
// pending call and `.flush()` to run a pending call immediately with its own
// args (e.g. on drag-end); both no-op when nothing is pending.
export function debounce(fn, wait = 0) {
  let timer = null;
  let lastArgs = null;
  const debounced = (...args) => {
    lastArgs = args;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const args = lastArgs;
      lastArgs = null;
      fn(...args);
    }, wait);
  };
  debounced.cancel = () => {
    clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  debounced.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    const args = lastArgs;
    lastArgs = null;
    fn(...args);
  };
  return debounced;
}

// An image URL kept only when it's this server's own (root-relative "/...") or the
// page's own (blob: / data:image/), else "". Card data from an imported preset or a shared
// workflow must never make the page fetch an outside address (a tracking pixel). Stored
// thumbnails follow local_url in config_switcher_presets.py.
export function localImageUrl(value) {
  const text = String(value || "");
  if (text.startsWith("blob:") || text.startsWith("data:image/")) return text;
  if (text.startsWith("/")) return text.startsWith("//") || text.startsWith("/\\") ? "" : text;
  try {
    return new URL(text).origin === window.location.origin ? text : "";
  } catch {
    return "";
  }
}

export function cssEscape(value) {
  const raw = String(value ?? "");
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(raw);
  }
  return raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function queryDataAttr(root, selector, attr, value) {
  if (!root || value == null || value === "") return null;
  return root.querySelector(`${selector}[${attr}="${cssEscape(value)}"]`);
}

export function queryDataAttrAny(roots, selector, attr, value) {
  for (const root of roots || []) {
    const element = queryDataAttr(root, selector, attr, value);
    if (element) return element;
  }
  return null;
}

export function scrollNearest(element, { defer = false } = {}) {
  if (!element) return;
  const scroll = () => element.scrollIntoView({ block: "nearest" });
  if (defer) requestAnimationFrame(scroll);
  else scroll();
}
