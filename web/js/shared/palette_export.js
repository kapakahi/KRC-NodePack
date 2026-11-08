// Each KRC node's palette in API-format workflows (ext/v1 capability "palettes"):
// app.graphToPrompt, which ComfyUI's Export (API) and queueing both use, gets
// `_meta.krc_palette` on every KRC node with a DOM palette (node_palette.js marks them
// _krcManaged): node.properties.krcTheme, "" = follows the global palette.
//
// `_meta`, not an input: ComfyUI's execution and cache read only `inputs`, so a palette
// change never re-runs the node or anything after it. Old workflows simply lack it ("").
// Other per-node `_meta` for outside apps joins through registerExportMeta (Prompt Vault's
// profile, ext/v1 capability "prompts.profiles.meta").
// No `app` import here (installPaletteExport takes it), so this runs in tests.
import { getGraphNodeById, subgraphInnerGraph } from "./graph_walk.js";
import { nodePaletteId } from "./node_palette.js";

export const PALETTE_META_KEY = "krc_palette";

// More `_meta` stampers: (node) -> { key: value } | null, run for every node in the prompt.
const metaStampers = [];
export function registerExportMeta(stamp) {
  if (typeof stamp === "function" && !metaStampers.includes(stamp)) metaStampers.push(stamp);
}

// The node an API-format id names: "12", or "5:3" for node 3 inside subgraph node 5.
export function nodeForPromptId(root, id) {
  let graph = root;
  let node = null;
  const segments = String(id).split(":");
  for (let index = 0; index < segments.length; index += 1) {
    if (!graph) return null;
    const segment = segments[index];
    node = getGraphNodeById(graph, /^\d+$/.test(segment) ? Number(segment) : segment);
    if (!node) return null;
    if (index < segments.length - 1) graph = subgraphInnerGraph(node);
  }
  return node;
}

// Stamp the palette (and the registered stampers' keys) on `output` (graphToPrompt's
// { id: { inputs, class_type, _meta } }). A stamper that throws is skipped for that node.
export function stampPaletteMeta(output, root) {
  for (const [id, entry] of Object.entries(output || {})) {
    const node = entry && nodeForPromptId(root, id);
    if (!node) continue;
    const meta = node._krcManaged ? { [PALETTE_META_KEY]: nodePaletteId(node) } : {};
    for (const stamp of metaStampers) {
      try {
        const extra = stamp(node);
        if (extra && typeof extra === "object") Object.assign(meta, extra);
      } catch (error) {
        console.warn("[KRC Export] a _meta stamper failed:", error);
      }
    }
    if (Object.keys(meta).length) entry._meta = { ...(entry._meta || {}), ...meta };
  }
  return output;
}

// Wrap app.graphToPrompt once.
export function installPaletteExport(app) {
  if (!app || typeof app.graphToPrompt !== "function" || app.graphToPrompt.__krcPalette) return;
  const original = app.graphToPrompt;
  const wrapped = async function (...args) {
    const result = await original.apply(this, args);
    try {
      stampPaletteMeta(result?.output, app.graph);
    } catch (error) {
      console.warn("[KRC Palette] could not add node palettes to the prompt:", error);
    }
    return result;
  };
  wrapped.__krcPalette = true;
  app.graphToPrompt = wrapped;
}
