// Standby branches in API-format workflows (ext/v1 capability "workflows.standby"). ComfyUI's
// graphToPrompt leaves muted nodes (mode "Never": a KRC Resizer's DISABLE, Ctrl+M) out of
// the prompt and deletes, in one pass, every input that pointed at a node that isn't there
// (ComfyUI_frontend executionUtil.ts graphToPrompt). So a disabled Resizer, and anything muted
// that only fed it, can't be found in the export, let alone turned back on.
//
// recordStandby asks ComfyUI to serialize the graph a second time with every muted node set
// to Always (the modes are put back before anything else runs on the canvas; nothing is
// saved), and writes what was left out to one node's `_meta.krc_standby` (ComfyUI reads only
// `_meta.title`, so the prompt runs exactly as before):
//
//   { version: 1, classes: ["KRC Resizer"],
//     nodes:  { "<id>": <its entry as ComfyUI would serialize it if it weren't muted> },
//     inputs: { "<present node id>": { "<input>": ["<standby id>", slot] } } }
//
// `nodes` holds the muted KRC Resizers and the muted nodes that feed them; `inputs` the links
// ComfyUI deleted from present nodes because they pointed at those. NodePack's
// /krc/ext/v1/workflows routes rebuild the graph from it (utils/ext_api_workflows.py).
// No `app` import (recordStandby takes what it needs), so this runs in tests.
import { allGraphs, graphNodes } from "./graph_walk.js";

export const STANDBY_META_KEY = "krc_standby";
export const STANDBY_VERSION = 1;
export const STANDBY_CLASSES = Object.freeze(["KRC Resizer"]);
const NEVER = 2;
const ALWAYS = 0;

const isLink = (value) => Array.isArray(value) && value.length === 2 && typeof value[0] === "string";

// API ids sort as ComfyUI writes them: "2" < "10", then "5:3" after "5".
export function compareIds(a, b) {
  const pa = String(a).split(":").map(Number);
  const pb = String(b).split(":").map(Number);
  for (let index = 0; index < Math.max(pa.length, pb.length); index += 1) {
    const x = pa[index] ?? -1;
    const y = pb[index] ?? -1;
    if (x !== y) return Number.isNaN(x) || Number.isNaN(y) ? String(a).localeCompare(String(b)) : x - y;
  }
  return 0;
}

// What the real prompt left out, from the prompt serialized with nothing muted. -> the
// standby record, or null when no KRC Resizer was left out.
export function computeStandby(real, full) {
  const absent = (id) => !Object.hasOwn(real, id);
  const anchors = Object.keys(full || {}).filter((id) => absent(id) && STANDBY_CLASSES.includes(full[id]?.class_type));
  if (!anchors.length) return null;
  const standby = new Set();
  const stack = [...anchors];
  while (stack.length) {
    const id = stack.pop();
    if (standby.has(id)) continue;
    standby.add(id);
    for (const value of Object.values(full[id]?.inputs || {})) {
      if (isLink(value) && absent(value[0]) && Object.hasOwn(full, value[0])) stack.push(value[0]);
    }
  }
  const nodes = {};
  for (const id of [...standby].sort(compareIds)) {
    const entry = structuredClone(full[id]);
    if (entry._meta) delete entry._meta[STANDBY_META_KEY];
    nodes[id] = entry;
  }
  const inputs = {};
  for (const id of Object.keys(real).sort(compareIds)) {
    for (const [name, value] of Object.entries(full[id]?.inputs || {})) {
      if (isLink(value) && standby.has(value[0]) && !Object.hasOwn(real[id].inputs || {}, name)) {
        (inputs[id] ||= {})[name] = value;
      }
    }
  }
  return { version: STANDBY_VERSION, classes: [...STANDBY_CLASSES], nodes, inputs };
}

// The node that carries the record: the first present one, in id order.
export function standbyCarrier(output) {
  return Object.keys(output || {}).sort(compareIds)[0] || null;
}

// Every muted node, subgraphs included (a muted subgraph container mutes what's inside it).
export function mutedNodes(root) {
  const found = [];
  for (const graph of allGraphs(root)) {
    for (const node of graphNodes(graph)) if (node?.mode === NEVER) found.push(node);
  }
  return found;
}

// After the real serialization: when muted nodes exist, serialize again with them on, then
// record what was left out. `serialize()` re-runs ComfyUI's own graphToPrompt; `stamp(output)`
// adds KRC's per-node _meta (palettes, profiles) to that second output as to the first.
// Errors are logged and leave the prompt as ComfyUI made it.
export async function recordStandby(result, root, serialize, stamp) {
  const output = result?.output;
  if (!output || !Object.keys(output).length) return;
  const muted = mutedNodes(root);
  if (!muted.length) return;
  let full = null;
  for (const node of muted) node.mode = ALWAYS;
  try {
    full = (await serialize())?.output || null;
  } finally {
    for (const node of muted) node.mode = NEVER;
  }
  if (!full) return;
  stamp?.(full);
  const record = computeStandby(output, full);
  if (!record) return;
  const carrier = standbyCarrier(output);
  output[carrier]._meta = { ...(output[carrier]._meta || {}), [STANDBY_META_KEY]: record };
}
