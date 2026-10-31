// Node-size diagnostics for KRC DOM nodes. Exposes window.krcNodeSize() and
// window.krcNodeSizeDump() in the browser console so node/DOM height mismatches can be
// measured precisely instead of guessed.
//
//   krcNodeSize()                 → table for every KRC DOM node in the graph
//   krcNodeSize("model library")  → only nodes whose type matches the filter
//   krcNodeSizeDump("model lib")  → per node, the DOM ancestor chain + node-wrapper
//                                    child heights, to read the header height directly
//                                    and confirm/fix the chrome constants
//
// Columns:
//   logical      node.size [w x h] in LiteGraph units (what our constants set)
//   nodeDom      the node wrapper element's rendered [w x h]
//   domRoot      the .krc-node DOM widget's rendered [w x h] (your UI area)
//   header       measured header/title height (px) — the piece that was being GUESSED
//   chrome       nodeDom.h - domRoot.h  → total space around the DOM (header + slots + gap)
//   slotArea     chrome - header        → space connectors occupy (0 = none)
//   inputs/outputs   connector slot counts
//   computeSizeH the height the DOM widget reports to the frontend
//   cssDomH      the --krc-dom-h the height controller stamped
//
// For a connectorless node (Model Library: 0/0) chrome === header, so its min height
// should be domRoot + header exactly — any leftover is the excess footer gap.

function domRootFor(node) {
  for (const widget of node?.widgets || []) {
    const el = widget?.element;
    if (el instanceof HTMLElement) {
      if (el.classList?.contains("krc-node")) return el;
      const inner = el.querySelector?.(".krc-node");
      if (inner) return inner;
    }
  }
  // Fallback: some nodes wrap the UI without the .krc-node class on the widget element.
  for (const widget of node?.widgets || []) {
    if (widget?.element instanceof HTMLElement) return widget.element;
  }
  return null;
}

function domWidgetFor(node, root) {
  return (node?.widgets || []).find(
    (w) => w?.element === root || (w?.element instanceof HTMLElement && w.element.contains?.(root))
  );
}

// Walk up from the DOM widget to the node wrapper. Don't assume a class name (it differs
// across ComfyUI frontend versions): pick the nearest ancestor whose rendered height is at
// least the node's logical height (the wrapper encloses header + slots + the DOM widget).
function nodeWrapperFor(root, node) {
  const target = Number(node?.size?.[1]) || 0;
  let el = root?.parentElement || null;
  let best = null;
  for (let i = 0; i < 8 && el && el !== document.body; i += 1) {
    const h = el.offsetHeight || 0;
    if (h >= target - 2 && (!best || h < best.offsetHeight)) best = el;
    // A LiteGraph/Comfy node wrapper commonly carries one of these hooks.
    if (el.classList?.contains("lg-node") || el.classList?.contains("comfy-node") ||
        /(^|\s)(lg-node|comfy-node)/.test(el.className || "") || el.dataset?.nodeId) {
      return el;
    }
    el = el.parentElement;
  }
  return best;
}

// Best-effort header/title element within the wrapper.
function headerIn(wrapper) {
  if (!wrapper) return null;
  return (
    wrapper.querySelector('[class*="header-surface"]') ||
    wrapper.querySelector('[class*="node-header"]') ||
    wrapper.querySelector('[class*="lg-node-header"]') ||
    wrapper.querySelector('[class*="header"]') ||
    wrapper.querySelector('[class*="title"]') ||
    null
  );
}

function px(v) {
  return v == null || Number.isNaN(v) ? null : Math.round(v);
}

function reportNode(node) {
  const root = domRootFor(node);
  const wrapper = nodeWrapperFor(root, node);
  const header = headerIn(wrapper);
  const widget = domWidgetFor(node, root);
  let computeSizeH = null;
  try {
    computeSizeH = px(widget?.computeSize?.()?.[1]);
  } catch {
    computeSizeH = null;
  }

  const domH = px(root?.offsetHeight);
  const domW = px(root?.offsetWidth);
  const nodeDomH = px(wrapper?.offsetHeight);
  const nodeDomW = px(wrapper?.offsetWidth);
  const headerH = px(header?.offsetHeight);
  // Prefer the measured wrapper height; fall back to the logical node height so chrome is
  // never null even when the wrapper can't be located.
  const outerH = nodeDomH != null ? nodeDomH : px(node.size?.[1]);
  const chrome = outerH != null && domH != null ? outerH - domH : null;
  const slotArea = chrome != null && headerH != null ? chrome - headerH : null;
  const cssDomH = root ? getComputedStyle(root).getPropertyValue("--krc-dom-h").trim() || null : null;

  const summary = {
    type: node.type || node.comfyClass || "(?)",
    logical: `${px(node.size?.[0])}x${px(node.size?.[1])}`,
    nodeDom: `${nodeDomW}x${nodeDomH}`,
    domRoot: `${domW}x${domH}`,
    header: headerH,
    chrome,
    slotArea,
    inputs: node.inputs?.length || 0,
    outputs: node.outputs?.length || 0,
    computeSizeH,
    cssDomH,
  };
  return { node, root, wrapper, header, summary };
}

function graphNodes() {
  const graph = window.app?.graph || window.graph || window.LGraphCanvas?.active_canvas?.graph;
  return graph?._nodes || graph?.nodes || [];
}

function matching(filter) {
  const needle = filter ? String(filter).toLowerCase() : "";
  return graphNodes()
    .filter((n) => domRootFor(n))
    .filter((n) => !needle || String(n.type || n.comfyClass || "").toLowerCase().includes(needle));
}

function krcNodeSize(filter) {
  const reports = matching(filter).map(reportNode);
  if (!reports.length) {
    console.warn(`[KRC Node Size] No KRC DOM nodes found${filter ? ` matching "${filter}"` : ""}.`);
  } else {
    // eslint-disable-next-line no-console
    console.table(reports.map((r) => r.summary));
    if (reports.some((r) => r.summary.header == null)) {
      console.info("[KRC Node Size] header unresolved for some nodes; run krcNodeSizeDump() to read the DOM structure and the true header height.");
    }
  }
  return reports;
}

// Print the DOM ancestor chain from the DOM widget up, plus the node wrapper's direct
// children with their heights — so the header element (and its exact px height) can be
// read directly for this ComfyUI frontend version, independent of any forced node min.
function krcNodeSizeDump(filter) {
  for (const node of matching(filter)) {
    const root = domRootFor(node);
    const wrapper = nodeWrapperFor(root, node);
    console.group(`%c[KRC Node Size] ${node.type || node.comfyClass}: logical ${px(node.size?.[0])}x${px(node.size?.[1])}`, "font-weight:bold");
    const chain = [];
    let el = root;
    for (let i = 0; i < 8 && el && el !== document.body; i += 1) {
      chain.push({
        level: i,
        tag: el.tagName?.toLowerCase(),
        class: (el.className || "").toString().slice(0, 80),
        offsetH: el.offsetHeight,
        offsetW: el.offsetWidth,
        isWrapper: el === wrapper,
        isDomRoot: el === root,
      });
      el = el.parentElement;
    }
    console.table(chain);
    if (wrapper) {
      const kids = [...wrapper.children].map((c, idx) => ({
        idx,
        tag: c.tagName?.toLowerCase(),
        class: (c.className || "").toString().slice(0, 80),
        offsetH: c.offsetHeight,
      }));
      console.info("[KRC Node Size] node wrapper children (the header is the non-DOM-widget one):");
      console.table(kids);
    }
    console.groupEnd();
  }
}

if (typeof window !== "undefined") {
  window.krcNodeSize = window.krcNodeSize || krcNodeSize;
  window.krcNodeSizeDump = window.krcNodeSizeDump || krcNodeSizeDump;
}

export { krcNodeSize, krcNodeSizeDump };
