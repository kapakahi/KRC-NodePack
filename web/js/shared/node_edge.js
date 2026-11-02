// One edge under every KRC node's UI on the classic canvas (2026-11-01).
//
// The classic frontend places a DOM widget at its LiteGraph row (widget.last_y) plus the
// widget's margin (ComfyUI's default 10px, which is also its side inset). The gap under
// the UI is that same margin, so the edge matches the sides and native DOM widgets:
//
//   node height = DOM top (last_y + margin) + DOM height + margin
//
// Content-sized nodes (Config Switcher, Media, LoRA Loadout Mini) pass their content
// height and get the node height; resizable ones (LoRA Loadout, Model Library, Prompt
// Vault) pass the node height and get the DOM height. Nothing here is tuned by eye: a
// frontend change to the title bar, slot rows or widget margin moves every node alike.
// Node 2.0 (an .lg-node shell) sizes DOM widgets itself and never comes here.
//
// window.krcEdgeCheck() prints each classic KRC node's measured edge.

// ComfyUI's default DOM widget margin: the edge for a widget that sets none.
export const KRC_EDGE = 10;

// The node UI is in a Node 2.0 (Vue) node; false on the classic canvas, and before
// the element is mounted.
export function isNode2Dom(element) {
  return Boolean(element?.closest?.(".lg-node"));
}

// Mounted on the classic canvas. Before mounting a node's renderer is unknown, so
// callers keep their own sizing until this is true.
export function isClassicDom(element) {
  return Boolean(element?.isConnected) && !isNode2Dom(element);
}

export function widgetMargin(widget) {
  const margin = widget?.margin ?? widget?.options?.margin;
  return Number.isFinite(margin) ? margin : KRC_EDGE;
}

function slotHeight() {
  const height = globalThis.LiteGraph?.NODE_SLOT_HEIGHT;
  return Number.isFinite(height) ? height : 20;
}

// Where LiteGraph starts the widget rows: below the taller slot column (its own
// layout, used until the node is first drawn and last_y exists).
function estimatedWidgetY(node) {
  if (Number.isFinite(node?.widgets_start_y)) return node.widgets_start_y;
  const rows = Math.max(node?.inputs?.length || 0, node?.outputs?.length || 0);
  return rows * slotHeight() + 6;
}

// The DOM widget's top inside the node body (below the title).
export function classicDomTop(node, widget) {
  const y = Number.isFinite(widget?.last_y) ? widget.last_y : estimatedWidgetY(node);
  return y + widgetMargin(widget);
}

export function classicNodeHeight(node, widget, domHeight) {
  return Math.ceil(classicDomTop(node, widget) + domHeight + widgetMargin(widget));
}

export function classicDomHeight(node, widget, nodeHeight) {
  return Math.floor(nodeHeight - classicDomTop(node, widget) - widgetMargin(widget));
}

// Console diagnostic: each classic KRC node's gap under its UI (should read its margin).
// `content` is the element whose bottom is the visible edge (Media's panel, else the
// DOM widget itself).
export function edgeReport(graph = globalThis.app?.graph) {
  const rows = [];
  for (const node of graph?._nodes || []) {
    if (!/krc/i.test(node.type || "")) continue;
    const widget = (node.widgets || []).find((entry) => entry.element instanceof HTMLElement && entry.element.isConnected);
    if (!widget || isNode2Dom(widget.element)) continue;
    const content = widget.element.querySelector(".krc-mio-panel") || widget.element;
    const domHeight = content.offsetHeight;
    rows.push({
      id: node.id,
      type: node.type,
      "node h": Math.round(node.size?.[1] ?? 0),
      "dom top": classicDomTop(node, widget),
      "dom h": domHeight,
      edge: Math.round((node.size?.[1] ?? 0) - classicDomTop(node, widget) - domHeight),
      margin: widgetMargin(widget),
    });
  }
  return rows;
}

if (typeof window !== "undefined" && !window.krcEdgeCheck) {
  window.krcEdgeCheck = () => {
    const rows = edgeReport();
    console.log("[KRC Edge] classic canvas: each KRC node's edge should equal its margin");
    console.table(rows);
    return rows;
  };
}
