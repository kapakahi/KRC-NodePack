/*
 * KRC per-node palette.
 *
 * A node can override the global palette for just itself. The chosen palette id
 * is stored on node.properties.krcTheme (so it serializes with the graph) and
 * stamped as data-krc-theme on the node's .krc-node root element. Because every
 * KRC color resolves through the --krc-* tokens and the palette selectors in
 * themes.css/design_tokens.css are not :root-anchored, stamping the attribute on
 * a node root recolors just that node's subtree; the global palette on :root
 * still applies to every node that has no per-node override.
 *
 * An empty/absent property means "inherit the global palette". A concrete id
 * (including "default") forces that palette on the node regardless of global.
 *
 * Note: distinct from LoRA Loadout's helpers.applyNodeTheme(), which sets the
 * LiteGraph node's title/body chrome color — this module is the DOM UI palette.
 */
import { menuSelect } from "./browser_controls.js";
import { el } from "./dom.js";
import { PALETTES, NATIVE_ID, getGlobalPalette } from "./palettes.js";

const PROP = "krcTheme";
const INHERIT = ""; // switcher value meaning "follow the global palette"

// Set or clear data-krc-theme on an element from a palette id ("" clears).
function stamp(element, id) {
  if (!element) return;
  if (id) element.dataset.krcTheme = id;
  else delete element.dataset.krcTheme;
}

// A node's stored per-node palette id, or "" when it inherits the global one.
export function nodePaletteId(node) {
  return node?.properties?.[PROP] || INHERIT;
}

// The palette actually in effect for a node: its per-node override, else global.
function effectivePaletteId(node) {
  return node?.properties?.[PROP] || getGlobalPalette();
}

// Floating surfaces live outside the node body. Native would make them
// translucent over the page instead of over a node color, so these surfaces use
// Gray whenever Native is the effective palette.
export function floatingPaletteId(id = "") {
  const effective = id || getGlobalPalette();
  return effective === NATIVE_ID ? "gray" : id;
}

export function modalPaletteIdForNode(node, id = nodePaletteId(node)) {
  return floatingPaletteId(id);
}

// The LiteGraph node chrome (title bar + body behind the transparent DOM widget)
// is drawn on the <canvas>, not via CSS, so it can't inherit the --krc-* tokens.
// For every palette except Native it is a FIXED dark; under Native the DOM goes
// translucent and the node shows its own ComfyUI/LiteGraph color, so KRC leaves
// the chrome alone.
const CANVAS_TITLE = "#262626"; // node.color  — title bar
const CANVAS_BODY = "#2e2e2e"; // node.bgcolor — body behind the DOM widget

// Paint the node chrome and redraw. Non-Native → fixed dark. Native → clear only
// KRC's own leftover dark so the node falls back to LiteGraph's / the user's
// picked color; never clobber a color the user set via ComfyUI's color picker.
// Safe to call every render (idempotent, preserves user colors under Native).
export function applyNodeCanvasColors(node) {
  if (!node) return;
  node._krcManaged = true; // let refreshAllNodeCanvasColors find this node
  if (effectivePaletteId(node) === NATIVE_ID) {
    if (node.color === CANVAS_TITLE) node.color = null;
    if (node.bgcolor === CANVAS_BODY) node.bgcolor = null;
  } else {
    node.color = CANVAS_TITLE;
    node.bgcolor = CANVAS_BODY;
  }
  node.setDirtyCanvas?.(true, true);
}

// Re-apply chrome to every KRC-managed node. Called when the GLOBAL palette
// changes so nodes without a per-node override flip in/out of Native's
// leave-the-canvas-alone behavior immediately (DOM recolors from CSS on its own).
export function refreshAllNodeCanvasColors(graph) {
  for (const node of graph?._nodes || []) {
    if (node?._krcManaged) applyNodeCanvasColors(node);
  }
}

// Stamp a node's stored palette onto its root (DOM theming) and repaint the
// canvas chrome. Call whenever the root (re)mounts or re-renders so a reloaded
// graph shows the saved per-node palette. Idempotent.
export function applyNodePalette(node, root) {
  stamp(root, nodePaletteId(node));
  applyNodeCanvasColors(node);
}

// Persist a palette choice on the node, re-stamp its root, and repaint the
// canvas chrome (so switching to/from Native updates the node body). "" clears
// the override (back to global).
export function setNodePalette(node, root, id) {
  node.properties ||= {};
  if (id) node.properties[PROP] = id;
  else delete node.properties[PROP];
  stamp(root, id);
  applyNodeCanvasColors(node);
  window.dispatchEvent?.(new CustomEvent("krc-node-palette-changed", { detail: { node, id } }));
}

// A panel's Options inside the KRC Portal: the Portal has one palette, set on the global
// Options page, so the panel shows where instead of a per-panel picker.
export function portalPaletteNote() {
  return el("div", "krc-options-description", {
    textContent: "Palette: set for the whole Portal in KRC Portal ▸ Options ▸ Appearance.",
  });
}

/*
 * Build a palette picker row for an Options modal body. Changing it persists the
 * choice, recolors the node's root live, and recolors the open modal too (found
 * via the select's enclosing .krc-modal-overlay) so the preview matches.
 *
 *   node   the LiteGraph node.
 *   root   the node's .krc-node root element to recolor.
 *   label  field label (default "Node palette").
 */
export function buildNodePaletteField({ node, root, label = "Node palette" }) {
  const field = el("div", "krc-modal-field");
  field.append(el("span", "krc-modal-field-label", { textContent: label }));

  const select = menuSelect({
    className: "krc-modal-select",
    title: label,
    value: nodePaletteId(node),
    options: [[INHERIT, "Global (default)"], ...PALETTES.map((p) => [p.id, p.label])],
    onChange: (id) => {
      setNodePalette(node, root, id);
      // Recolor the open modal itself so its preview tracks the choice. Native
      // nodes keep a solid Gray modal because the dialog has no node color behind it.
      stamp(select.closest(".krc-modal-overlay"), modalPaletteIdForNode(node, id));
    },
  });

  field.append(select);
  return field;
}
