// ← / → step a Media node: KRC Media Loader through its 6 slots, KRC Media Output through its
// history. Which node: the one whose panel has keyboard focus (clicking anywhere in a Media
// panel focuses it, like Prompt Vault / Model Library panels), else the one node selected on
// the canvas. Only without a modifier and when focus isn't in a text field; then the key is
// claimed (ComfyUI's own "move selected nodes" arrows don't move that node). Every other key,
// node and arrow passes straight through.
import { app } from "../../../scripts/app.js";

const STEPS = { ArrowLeft: -1, ArrowRight: 1 };
const isElement = (value) => typeof Element === "function" && value instanceof Element;

function typing(target) {
  const element = isElement(target) ? target : null;
  if (!element) return false;
  if (element.isContentEditable) return true;
  const tag = element.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(element.type);
}

// The Media node whose panel holds `element` (bindMediaKeys marks each root).
function focusedNode(element) {
  let current = isElement(element) ? element : null;
  while (current) {
    if (current._krcMioNode) return current._krcMioNode;
    current = current.parentElement || current.parentNode || null;
  }
  return null;
}

function selectedNode() {
  const canvas = app.canvas;
  // Newer frontends keep the selection in selectedItems (a Set); older ones in selected_nodes.
  const nodes = canvas?.selectedItems ? [...canvas.selectedItems] : Object.values(canvas?.selected_nodes || {});
  return nodes.length === 1 ? nodes[0] : null;
}

export function installMediaArrowKeys() {
  if (window.__krcMediaArrowKeys) return;
  window.__krcMediaArrowKeys = true;
  window.addEventListener("keydown", (event) => {
    const delta = STEPS[event.key];
    if (!delta || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) return;
    if (typing(event.target) || typing(document.activeElement)) return;
    const node = focusedNode(event.target) || focusedNode(document.activeElement) || selectedNode();
    if (typeof node?._krcMioStep !== "function") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    node._krcMioStep(delta);
  }, true);
}

// A Media node's panel root: a click anywhere in it gives it keyboard focus (no scroll, no
// outline), so the arrows step this node at once, selected on the canvas or not.
export function bindMediaKeys(root, node) {
  root._krcMioNode = node;
  if (!root.hasAttribute?.("tabindex")) root.setAttribute?.("tabindex", "-1");
  root.addEventListener("pointerdown", (event) => {
    if (typing(event.target)) return;
    // A button takes focus itself where the browser allows it; elsewhere the panel does.
    if (!root.contains(document.activeElement)) root.focus?.({ preventScroll: true });
  });
  installMediaArrowKeys();
}

// The next index from `index` by `delta` among `count` entries, wrapping at both ends.
export function wrapIndex(index, delta, count) {
  if (count <= 0) return -1;
  return (((index + delta) % count) + count) % count;
}
