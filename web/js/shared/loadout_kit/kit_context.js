// One context per registered kit node type: widget accessors, node size, routes and the
// preset cache right away; the descriptor (fields, source, slots — from the Python kit)
// and the node size that follows from it once `kit.ensureDescriptor()` resolves. Panels reach it as `this.kit`.
import { makeNodeApi, getJson } from "../api.js";
import { makeWidgetAccessors } from "../widgets.js";
import { krcNodeMinHeight, makeNodeSizing } from "../node_limits.js";
import { BASE_HIDDEN_WIDGETS, NODE_WIDTH, kitGeometry } from "./constants.js";

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);

const descriptorRequests = new Map();

// One kit's descriptor (GET /krc/loadout/{kit}/descriptor), fetched when its first node
// is created: by then ComfyUI has called the node's INPUT_TYPES, so a kit the node
// creates lazily there exists whatever order the packs loaded in. A failed fetch is
// retried by the next node. Resolves to the descriptor or null.
export function loadKitDescriptor(kitId) {
  if (!descriptorRequests.has(kitId)) {
    const request = getJson(`/krc/loadout/${encodeURIComponent(kitId)}/descriptor`, { fallback: null }).then((data) => {
      const ok = data && typeof data === "object" && data.id === kitId && Array.isArray(data.fields);
      if (!ok) descriptorRequests.delete(kitId);
      return ok ? data : null;
    });
    descriptorRequests.set(kitId, request);
  }
  return descriptorRequests.get(kitId);
}

// Sockets (not widgets) a node def draws: the kit's node size accounts for them like LL
// mini's does (1 preset input + its outputs).
function socketCounts(nodeData) {
  let inputs = 0;
  for (const group of ["required", "optional"]) {
    for (const spec of Object.values(nodeData?.input?.[group] || {})) {
      const type = Array.isArray(spec) ? spec[0] : spec;
      const isWidget = Array.isArray(type) || WIDGET_TYPES.has(type);
      if (!isWidget || spec?.[1]?.forceInput) inputs += 1;
    }
  }
  return { inputs, outputs: Array.isArray(nodeData?.output) ? nodeData.output.length : 0 };
}

// "KRC RefMod Loadout" -> "RefMod Loadout" (options modal title).
function shortTitle(nodeData, fallback) {
  return String(nodeData?.display_name || nodeData?.name || fallback || "").replace(/^KRC\s+/, "");
}

// Node 2.0 pins the widget's height with !important rules (LL pins every mini node to
// 668px); a kit's own height overrides them for its node type (more specific selector).
function injectNode2HeightRules(kit) {
  const id = `krc-loadout-kit-${kit.id}-height-css`;
  if (document.getElementById(id)) return;
  const root = `.krc-lora-stacker.krc-kit-${kit.id}.is-mini`;
  const style = document.createElement("style");
  style.id = id;
  style.textContent = `
.lg-node:has(${root}) .lg-node-widget:has(${root}),
.lg-node:has(${root}) .lg-node-widget:has(${root}) > .flex.flex-col,
.lg-node:has(${root}) ${root} { min-height: ${kit.domHeight}px !important; }
.lg-node:has(${root}) .lg-node-widget:has(${root}) > .flex.flex-col,
.lg-node:has(${root}) ${root} { height: ${kit.domHeight}px !important; flex: 0 0 ${kit.domHeight}px !important; }
`;
  document.head.append(style);
}

// The descriptor-derived part of a kit context: fields, source, slots, and the node size
// that follows from them (cards are fixed; the node grows or shrinks around them).
function applyDescriptor(kit, descriptor, nodeData) {
  const hasFields = descriptor.fields.length > 0;
  const geometry = kitGeometry(descriptor.slots, hasFields);
  const { inputs, outputs } = socketCounts(nodeData);
  const size = [NODE_WIDTH, krcNodeMinHeight(geometry.domHeight, inputs, outputs)];
  Object.assign(kit, {
    descriptor,
    fields: descriptor.fields,
    source: descriptor.source,
    slots: descriptor.slots,
    hasFields,
    ...geometry,
    size,
    sizing: makeNodeSizing({ minSize: size, miniSize: size, maxWidth: size[0], maxHeight: size[1] }),
  });
  injectNode2HeightRules(kit);
}

export function createKitContext(options, nodeData) {
  const kitId = String(options.kit);
  const hiddenWidgets = { ...BASE_HIDDEN_WIDGETS, ...(options.hiddenWidgets || {}) };
  const accessors = makeWidgetAccessors(hiddenWidgets);
  const noun = String(options.noun || "Card");
  const kit = {
    id: kitId,
    nodeType: options.nodeType,
    descriptor: null,
    options,
    noun,
    nounPlural: String(options.nounPlural || `${noun}s`),
    title: shortTitle(nodeData, options.nodeType),
    hiddenWidgets,
    ...accessors,
    api: makeNodeApi(`/krc/loadout/${encodeURIComponent(kitId)}`),
    presetCache: null,
    // Per-kit drag type for reordering stack entries, so another kit's slots never read
    // this kit's entries (MIME subtypes are lowercase; ids are already).
    entryMime: `application/x-krc-loadout-${kitId.replace(/_/g, "-")}-entry`,
  };
  // Resolves to true once the descriptor is in; a failed fetch leaves a retry for the
  // next node (kit.ensureDescriptor()).
  kit.ensureDescriptor = () => {
    if (kit.descriptor) return Promise.resolve(true);
    return loadKitDescriptor(kitId).then((descriptor) => {
      if (descriptor && !kit.descriptor) applyDescriptor(kit, descriptor, nodeData);
      return Boolean(kit.descriptor);
    });
  };
  return kit;
}
