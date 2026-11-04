// The open workflow's KRC Media Loader nodes (GAMEPLAN.md section 4), read and written by the
// nodes and the Media: the hidden `loader_data` = { preset, slot (0-5),
// autoPreset }. A Loader may follow its optional `preset` input instead (when it's
// connected). Writes mark the workflow dirty and fire NODES_EVENT so the Media and the
// other nodes re-render.
import { app } from "../../../scripts/app.js";
import { markDirty } from "./krc.js";
import { SLOT_COUNT, presetById, presetSlots } from "./presets.js";

export const LOADER_TYPE = "KRC Media Loader";
export const LOADER_WIDGET = "loader_data";
export const FOLLOW_INPUT = "preset";
export const NODES_EVENT = "krc-media-nodes-changed";   // in-page: a node's pick changed
export const BYPASS_MODE = 4;                                // LiteGraph's "bypass"

function graphNodes(graph) {
  return [...(graph?._nodes || graph?.nodes || [])];
}

// Every node of `type` in the open workflow, subgraphs included (root first).
function workflowNodes(type) {
  const root = app.graph;
  const found = graphNodes(root).filter((node) => node?.comfyClass === type);
  for (const subgraph of root?.subgraphs?.values?.() || []) {
    found.push(...graphNodes(subgraph).filter((node) => node?.comfyClass === type));
  }
  return found;
}

export const loaderNodes = () => workflowNodes(LOADER_TYPE);

const widgetOf = (node, name) => node?.widgets?.find((widget) => widget.name === name) || null;

function readJson(node, name) {
  try {
    const value = JSON.parse(widgetOf(node, name)?.value || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeJson(node, name, value) {
  const widget = widgetOf(node, name);
  if (!widget) return;
  widget.value = JSON.stringify(value);
  markDirty(node);
  window.dispatchEvent(new CustomEvent(NODES_EVENT, { detail: { nodeId: node.id } }));
}

export function readLoader(node) {
  const raw = readJson(node, LOADER_WIDGET);
  const slot = Math.min(Math.max(Number.parseInt(raw.slot, 10) || 0, 0), SLOT_COUNT - 1);
  return { preset: String(raw.preset || ""), slot, autoPreset: Boolean(raw.autoPreset) };
}

export function writeLoader(node, fields) {
  writeJson(node, LOADER_WIDGET, { ...readLoader(node), ...fields });
}

// What a queued run sends: the pick plus the Media item in its slot right now, so a later
// hot swap or preset edit doesn't change runs already in the queue (ComfyUI's Load Image
// sends its file the same way). Following, the preset only arrives at run time.
export function loaderPromptValue(node) {
  const value = { ...readJson(node, LOADER_WIDGET) };
  delete value.media;
  if (!isFollowing(node)) {
    const pick = readLoader(node);
    const media = presetSlots(presetById(pick.preset))[pick.slot]?.id;
    if (media) value.media = String(media);
  }
  return JSON.stringify(value);
}

// The node loads its `preset` input's preset instead of its own (connected = following).
export function isFollowing(node) {
  const input = node?.inputs?.find((slot) => slot?.name === FOLLOW_INPUT);
  return input?.link != null;
}

export const isBypassed = (node) => node?.mode === BYPASS_MODE;

// The preset the Media's Presets page opens on: the first Media Loader's (not
// following), else "".
export function workflowPresetId() {
  for (const node of loaderNodes()) {
    if (isFollowing(node)) continue;
    const id = readLoader(node).preset;
    if (presetById(id)) return id;
  }
  return "";
}

// { item id: ["Untitled 2 · slot 3", …] }: what the open workflow's Loaders load (their
// selected slots; bypassed and following ones left out) — the Media's ACTIVE badges and
// the delete warning.
export function activeItems() {
  const map = {};
  for (const node of loaderNodes()) {
    if (isBypassed(node) || isFollowing(node)) continue;
    const pick = readLoader(node);
    const preset = presetById(pick.preset);
    const slot = presetSlots(preset)[pick.slot];
    if (slot?.id) (map[slot.id] ||= []).push(`${preset.name} · slot ${pick.slot + 1}`);
  }
  for (const id of Object.keys(map)) map[id] = [...new Set(map[id])];
  return map;
}

// A cheap fingerprint of every Loader's pick, mode and Follow state: the Media compares it
// while open to notice a workflow-tab switch or an edit made on the canvas.
export function nodesSignature() {
  return loaderNodes()
    .map((node) => `${node.id}:${node.mode}:${isFollowing(node)}:${widgetOf(node, LOADER_WIDGET)?.value || ""}`)
    .join("|");
}
