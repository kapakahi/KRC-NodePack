import { app } from "../../../scripts/app.js";
// Registers window.krcNodeSize() for measuring node/DOM size mismatches from the console.
import "./node_size_diagnostics.js";
import { classicDomHeight, isClassicDom, isNode2Dom } from "./node_edge.js";

export { isNode2Dom };

export function markDirty(node) {
  if (node?.__krcDetached) return; // detached NodeHost stub: no canvas to invalidate
  const graph = node.graph || app.graph;
  node.setDirtyCanvas?.(true, true);
  graph?.change?.(node);
  graph?.setDirtyCanvas?.(true, true);
  graph?.onNodeChanged?.(node);
  app.canvas?.setDirty?.(true, true);
  app.canvas?.setDirtyCanvas?.(true, true);
}

export function forceNodeSize(node, size, { dirty = true } = {}) {
  if (!node || !Array.isArray(size)) return;
  const next = [size[0], size[1]];
  node.size = next;
  if (!node.__krcForcingSize && typeof node.setSize === "function") {
    node.__krcForcingSize = true;
    try {
      node.setSize(next);
    } finally {
      node.__krcForcingSize = false;
    }
  }
  if (dirty) markDirty(node);
}

export function findWidget(node, name) {
  return node.widgets?.find((widget) => widget.name === name);
}

export function hideWidget(widget) {
  if (!widget) return widget;
  // Node 2.0 (Vue @comfyorg/litegraph): reassigning `type = "hidden"` is what
  // actually stops a widget from rendering — including DOM-backed multiline
  // (`customtext`) textareas, which `hidden = true` alone does NOT tear down.
  // `hidden = true` still suppresses canvas-drawn widgets, and `computeSize`
  // [0,-4] keeps the old canvas frontend collapsing the row. Mirrors the
  // working KRC Resizer (now in KRC NodePack Extras: resizer/node_shell.js
  // hideManagedWidgets). The widget
  // stays in node.widgets and still serializes / exposes .value as a hidden
  // data carrier.
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  // Multiline STRING widgets are DOM-backed (a <textarea>); type="hidden" stops
  // them being drawn on the canvas but does NOT remove that element, so under
  // Node 2.0 they still render (e.g. Prompt Vault's text/prompt_b). Hide the
  // element directly too. No-op for canvas-only widgets (no .element/.inputEl).
  const domEl = widget.element || widget.inputEl;
  if (domEl?.style) domEl.style.display = "none";
  return widget;
}

// Node 2.0 (Vue @comfyorg/litegraph): after mounting the DOM widget, reorder
// node.widgets so the DOM widget is FIRST and every already-hidden backing
// widget is pushed LAST. Under the old canvas frontend hidden widgets collapsed
// in place, but the Vue frontend still reserves a layout slot for a hidden
// widget wherever it sits — so backing widgets left above the DOM widget leave a
// large empty band ("deadspace") above the UI. Floating the DOM widget to the
// top and sinking the hidden ones removes it. Also drops any input slot that
// belongs to a hidden backing widget so only the real I/O connectors remain.
// Mirrors the working KRC Resizer (KRC NodePack Extras: resizer/node_shell.js
// hideManagedWidgets).
export function promoteDomWidget(node, domWidget) {
  if (!node?.widgets || !domWidget) return;
  const isHidden = (w) => w.hidden === true || w.type === "hidden";
  const hidden = node.widgets.filter((w) => w !== domWidget && isHidden(w));
  const visible = node.widgets.filter((w) => w !== domWidget && !isHidden(w));
  node.widgets = [domWidget, ...visible, ...hidden];
  if (node.inputs) {
    const hiddenNames = new Set(hidden.map((w) => w.name));
    for (let i = node.inputs.length - 1; i >= 0; i--) {
      if (hiddenNames.has(node.inputs[i]?.name)) node.removeInput(i);
    }
  }
}

export function suspendDomWidgetLayout(node, domWidget, { dirty = true } = {}) {
  if (!node?.widgets || !domWidget) return false;
  if (!node.widgets.includes(domWidget)) return false;
  node.__krcSuspendedDomWidgets ||= new Map();
  if (!node.__krcSuspendedDomWidgets.has(domWidget)) {
    node.__krcSuspendedDomWidgets.set(domWidget, node.widgets.indexOf(domWidget));
  }
  node.widgets = node.widgets.filter((widget) => widget !== domWidget);
  if (dirty) markDirty(node);
  return true;
}

export function restoreDomWidgetLayout(node, domWidget, { dirty = true } = {}) {
  if (!node?.widgets || !domWidget) return false;
  const suspended = node.__krcSuspendedDomWidgets;
  const storedIndex = suspended?.get?.(domWidget);
  if (suspended?.has?.(domWidget)) suspended.delete(domWidget);
  if (node.widgets.includes(domWidget)) return false;
  const index = Number.isInteger(storedIndex)
    ? Math.min(Math.max(storedIndex, 0), node.widgets.length)
    : 0;
  node.widgets = [
    ...node.widgets.slice(0, index),
    domWidget,
    ...node.widgets.slice(index),
  ];
  if (dirty) markDirty(node);
  return true;
}

export function bindNodeShellSizeClamp(root, node, { className = "", maxSize = null, attempts = 12 } = {}) {
  if (!root || !node || !Array.isArray(maxSize)) return null;
  let cleanup = null;
  const attach = (remaining) => {
    const shell = root.closest?.(".lg-node");
    if (!shell) {
      if (remaining > 0) requestAnimationFrame(() => attach(remaining - 1));
      return;
    }
    if (className) shell.classList.add(className);
    cleanup?.();

    const originalSetProperty = shell.style.setProperty.bind(shell.style);
    const clamp = () => {
      const width = parseFloat(shell.style.getPropertyValue("--node-width"));
      const height = parseFloat(shell.style.getPropertyValue("--node-height"));
      if (Number.isFinite(width) && width > maxSize[0]) {
        originalSetProperty("--node-width", `${maxSize[0]}px`);
        if (node.size) node.size[0] = maxSize[0];
      }
      if (Number.isFinite(height) && height > maxSize[1]) {
        originalSetProperty("--node-height", `${maxSize[1]}px`);
        if (node.size) node.size[1] = maxSize[1];
      }
    };

    shell.style.setProperty = function (name, value, priority) {
      if (name === "--node-width") {
        const width = parseFloat(value);
        if (Number.isFinite(width) && width > maxSize[0]) value = `${maxSize[0]}px`;
      } else if (name === "--node-height") {
        const height = parseFloat(value);
        if (Number.isFinite(height) && height > maxSize[1]) value = `${maxSize[1]}px`;
      }
      return originalSetProperty(name, value, priority);
    };

    // Writes through setProperty are clamped above; any other style write (cssText, the
    // style attribute) is caught here. Observer callbacks run before the next paint, so
    // no per-frame polling is needed.
    const observer = new MutationObserver(clamp);
    observer.observe(shell, { attributes: true, attributeFilter: ["style"] });
    clamp();

    cleanup = () => {
      observer.disconnect();
      shell.style.setProperty = originalSetProperty;
    };
    node.__krcNodeShellSizeClampCleanup = cleanup;
  };
  attach(attempts);
  return () => cleanup?.();
}

export function createDomHeightController(node, root, {
  minNodeHeight,
  maxNodeHeight,
  minDomHeight,
  domWidget = null,
  cssVar = "--krc-dom-h",
  node2DomTrim = 0,
} = {}) {
  const hiddenWidgetCount = () =>
    (node.widgets || []).filter((w) => w !== domWidget && (w.hidden === true || w.type === "hidden")).length;
  const node2 = () => isNode2Dom(root);
  const node2Trim = () => node2() ? node2DomTrim : 0;
  // Keep the DOM widget's bottom gap consistent with the node's minimum size.
  // Hidden backing widgets are promoted below the DOM widget and collapsed, so
  // they must not become extra subtracted height at larger node sizes.
  const chromeOffset = Math.max(0, minNodeHeight - minDomHeight);
  // While the user is dragging the native resize handle, keep the DOM a little
  // lighter. The final settled stamp below still uses chromeOffset, so resting
  // padding stays tight without forcing full-height layout on every mousemove.
  const interactiveOffset = () => Math.max(chromeOffset, 82 + (hiddenWidgetCount() * 4));
  const clampNodeHeight = (height) => {
    const value = Number.isFinite(height) ? height : minNodeHeight;
    return Math.min(Math.max(value, minNodeHeight), maxNodeHeight);
  };
  const controller = {
    offset: chromeOffset,
    domHeightForNodeHeight(height, { interactive = false } = {}) {
      const nodeHeight = clampNodeHeight(height);
      // Classic canvas at rest: the shared edge (node_edge.js) from the frontend's own
      // layout, no calibrated offset.
      if (!interactive && domWidget && isClassicDom(root)) return Math.max(minDomHeight, classicDomHeight(node, domWidget, nodeHeight));
      const offset = (interactive ? interactiveOffset() : this.offset) + node2Trim();
      return Math.max(minDomHeight, nodeHeight - offset);
    },
    stamp(height = node.size?.[1], options = {}) {
      const domHeight = this.domHeightForNodeHeight(height, options);
      const px = `${domHeight}px`;
      root.style.height = px;
      root.style.overflow = "hidden";
      root.style.setProperty(cssVar, px);
      return domHeight;
    },
    calibrate() {
      const measured = root.offsetHeight || parseFloat(root.style.height) || minDomHeight;
      const nodeHeight = node.size?.[1];
      if (Number.isFinite(nodeHeight) && measured > 0) {
        this.offset = Math.max(0, Math.round(nodeHeight - measured));
      }
      this.stamp(node.size?.[1]);
    },
  };
  controller.stamp();
  // Calibrate once mounted (the renderer is known only then; classic sizes from the edge).
  let tries = 0;
  const calibrateWhenMounted = () => {
    if (!root.isConnected && tries++ < 30) requestAnimationFrame(calibrateWhenMounted);
    else controller.calibrate();
  };
  requestAnimationFrame(calibrateWhenMounted);
  return controller;
}

export function hideWidgets(node, names) {
  const nameSet = names instanceof Set ? names : new Set(names);
  for (const widget of node.widgets || []) {
    if (nameSet.has(widget.name)) hideWidget(widget);
  }
}

export function ensureHiddenWidget(node, name, defaultValue) {
  node.properties ||= {};
  let widget = findWidget(node, name);
  if (!widget) {
    const type = typeof defaultValue === "boolean" ? "toggle" : "text";
    widget = node.addWidget(type, name, defaultValue, () => {});
  }

  if (node.properties[name] !== undefined && widget.value === defaultValue) {
    widget.value = node.properties[name];
  }

  widget.serialize = true;
  return hideWidget(widget);
}

export function hiddenWidgetValue(node, name, defaultValue) {
  const widget = ensureHiddenWidget(node, name, defaultValue);
  if (widget.value !== defaultValue) {
    return widget.value;
  }
  return node.properties?.[name] ?? widget.value;
}

export function setWidgetValue(node, widget, name, value, {
  callback = true,
  nodeEvents = true,
  syncWidgetsValues = true,
  dirty = true,
} = {}) {
  if (!widget) return;
  const previous = widget.value;
  widget.value = value;

  node.properties ||= {};
  if (typeof node.setProperty === "function") {
    node.setProperty(name, value);
  } else {
    node.properties[name] = value;
  }

  const index = node.widgets?.indexOf(widget) ?? -1;
  if (syncWidgetsValues && index >= 0 && Array.isArray(node.widgets_values)) {
    node.widgets_values[index] = value;
  }

  if (callback) widget.callback?.(value, app.canvas, node);
  if (nodeEvents) {
    node.onWidgetChanged?.(name, value, previous, widget);
    node.onPropertyChanged?.(name, value, previous);
  }
  if (dirty) markDirty(node);
}

// Node-facing hidden-widget accessors, parameterized by the node's hidden-widget
// registry. Each node did `ensureWidget`/`widgetValue`/`setWidgetValue` identically
// against its own HIDDEN_WIDGETS map; this collapses those copies to one factory.
export function makeWidgetAccessors(hiddenWidgets) {
  return {
    ensureWidget: (node, name, defaultValue) =>
      ensureHiddenWidget(node, name, defaultValue),
    widgetValue: (node, name) =>
      hiddenWidgetValue(node, name, hiddenWidgets[name]),
    setWidgetValue: (node, name, value) =>
      setWidgetValue(node, ensureHiddenWidget(node, name, hiddenWidgets[name]), name, value),
  };
}
