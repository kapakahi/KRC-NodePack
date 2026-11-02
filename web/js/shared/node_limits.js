export const KRC_MAX_NODE_WIDTH = 882 * 4;

// ── Solo-DOM-widget node height derivation ───────────────────────────────────
// In the Node 2.0 (Vue) frontend a KRC DOM node's canvas height is:
//   header + connector-slot-rows + DOM content
// The DOM content min is per-node (each node's DOM_MIN_HEIGHT); the chrome AROUND it
// depends only on how many input/output connectors the node has. These two pieces are
// pack-wide — verified with the krcNodeSize() console diagnostic against Prompt Vault
// (1 in / 2 out), LoRA Loadout (1 in / 2 out) and Model Library (0 / 0):
//   header bar          = 26px
//   one connector row   = 20px   (Node 2.0 lays inputs and outputs in parallel columns,
//                                  so the number of ROWS is max(inputs, outputs))
// Derive a node's minimum height from its OWN connector counts instead of hardcoding a
// constant that silently bakes in some other node's connectors. That copy-the-constant
// trap is the recurring cause of "node too tall / DOM too short" when a node is cloned to
// a different connector layout: e.g. cloning Prompt Vault (734 = 668 + 66) into a
// connectorless node leaves a 40px slot budget it never uses.
export const KRC_NODE_HEADER_HEIGHT = 26;
export const KRC_NODE_SLOT_ROW_HEIGHT = 20;

export function krcNodeChromeHeight(inputCount = 0, outputCount = 0) {
  const slotRows = Math.max(0, inputCount || 0, outputCount || 0);
  return KRC_NODE_HEADER_HEIGHT + slotRows * KRC_NODE_SLOT_ROW_HEIGHT;
}

// Minimum canvas height for a solo-DOM-widget node: its DOM content min plus the chrome
// its own connector counts require. A new node just passes its DOM min and its input/
// output counts — no hand-tuned magic height, and krcNodeSize() confirms the result.
export function krcNodeMinHeight(domMinHeight, inputCount = 0, outputCount = 0) {
  return domMinHeight + krcNodeChromeHeight(inputCount, outputCount);
}

export const KRC_THUMB_LIST_VISIBLE_CARD_LIMIT = 20;
export const KRC_LIST_VIEW_CARD_BUFFER = 1;
export const KRC_GRID_VIEW_CARD_BUFFER = 2;
export const KRC_BROWSER_VIRTUAL_BUFFER_ROWS = 6;
export const KRC_BROWSER_GRID_COLUMNS = 2;

export const KRC_THUMB_LIST_CARD_HEIGHT = 66;
// The browser's list-view card (one text bar). Mirrored by
// --krc-browser-list-card-min-height in components.css.
export const KRC_BROWSER_LIST_CARD_HEIGHT = 34;
// The stack slot card (LoRA Loadout, LL mini, Loadout Kit / RefMod): the same 34px as
// the list-view card. Cards are never stretched (project rule): stacks use fixed rows of
// this height and nodes size around them. A stack panel = padding 8 + header 24 + slots x
// (card + gap 4) + padding 8 (LL: 6 slots = 268). Mirrored in
// lora_loadout/styles/stacks_presets.css.
export const KRC_SLOT_CARD_HEIGHT = KRC_BROWSER_LIST_CARD_HEIGHT;
export const KRC_BROWSER_GRID_CARD_HEIGHT = 218;
export const KRC_BROWSER_LIST_GAP = 8;

// Full-node vertical chrome around the browser card viewport:
// panel padding/header, search, folder/category controls, footer, and row gaps.
export const KRC_BROWSER_PANEL_VERTICAL_CHROME = 299;
export const KRC_MAX_NODE_HEIGHT =
  KRC_BROWSER_PANEL_VERTICAL_CHROME +
  (KRC_THUMB_LIST_VISIBLE_CARD_LIMIT * KRC_THUMB_LIST_CARD_HEIGHT) +
  ((KRC_THUMB_LIST_VISIBLE_CARD_LIMIT - 1) * KRC_BROWSER_LIST_GAP);

// Node min/max-size clamping, parameterized by a node's size bounds. LL/ML had a
// byte-identical minimumNodeSize/applyMinimumNodeSize/installResizeClamp trio that
// differed only by these four size constants. The "mini" surface is an LL concept
// (ML never sets __krcLoraSurface="mini"), so its branch is simply inert there.
export function makeNodeSizing({ minSize, miniSize, maxWidth, maxHeight }) {
  // Mini's height on the classic canvas comes from the shared edge (node_edge.js), via
  // the node's own __krcClassicMiniHeight (null until mounted there).
  const minimumNodeSize = (node) => {
    if (node.__krcLoraSurface !== "mini") return minSize;
    const classic = node.__krcClassicMiniHeight?.();
    return Number.isFinite(classic) ? [miniSize[0], classic] : miniSize;
  };

  const applyMinimumNodeSize = (node, requestedSize = node.size) => {
    const min = minimumNodeSize(node);
    const lockSize = node.__krcLoraSurface === "mini";
    const requestedWidth = Math.max(requestedSize?.[0] || 0, min[0]);
    const width = lockSize ? min[0] : Math.min(requestedWidth, maxWidth);
    const requestedHeight = Math.max(requestedSize?.[1] || 0, min[1]);
    const height = lockSize ? min[1] : Math.min(requestedHeight, maxHeight);
    node.size = [width, height];
    node.min_size = min;
    node.max_size = lockSize ? min : [maxWidth, maxHeight];
  };

  const installResizeClamp = (node) => {
    if (node.__krcLoraResizeClampInstalled) return;
    node.__krcLoraResizeClampInstalled = true;
    const onResize = node.onResize;
    node.onResize = function (size) {
      const result = onResize?.apply(this, arguments);
      if (Array.isArray(size) && this.__krcLoraSurface !== "mini") {
        size[0] = Math.min(Math.max(size[0], minSize[0]), maxWidth);
        size[1] = Math.min(Math.max(size[1], minSize[1]), maxHeight);
      }
      applyMinimumNodeSize(this, size);
      return result;
    };
  };

  return { minimumNodeSize, applyMinimumNodeSize, installResizeClamp };
}
