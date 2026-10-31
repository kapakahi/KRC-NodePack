// Node-local output settings. Only stills have a format; a VIDEO is saved as it arrives.
export const OUTPUT_TYPE = "KRC Media Output";
export const OUTPUT_WIDGET = "output_data";
export const OUTPUT_DEFAULTS = Object.freeze({
  folder: "", prefix: "ComfyUI_output", format: "png", saveMetadata: true, key: "",
  // Show in queue and Assets (output_node.js). On by default.
  native: true,
});
const ID = /^[0-9a-f]{32}$/;
// The node's own key: its saved records carry it (outputKey), so the node's history comes
// back from Media even when the run's "executed" message never reached it. getRandomValues,
// not randomUUID: that needs a secure page, and ComfyUI is often served over plain http.
export const newOutputKey = () => [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, "0")).join("");
export const OUTPUT_FORMATS = Object.freeze([
  { value: "png", label: "PNG" },
  { value: "webp", label: "WebP · lossless" },
]);
export function normalizeOutput(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const format = OUTPUT_FORMATS.find(entry => entry.value === raw.format) || OUTPUT_FORMATS[0];
  return {
    // "" = Default (output/KRC-Media/Default, the Output view's Unsorted); "output" was its old name.
    folder: ID.test(raw.folder) ? raw.folder : OUTPUT_DEFAULTS.folder,
    prefix: typeof raw.prefix === "string" ? raw.prefix : OUTPUT_DEFAULTS.prefix,
    format: format.value,
    saveMetadata: typeof raw.saveMetadata === "boolean" ? raw.saveMetadata : OUTPUT_DEFAULTS.saveMetadata,
    key: ID.test(raw.key) ? raw.key : "",
    native: typeof raw.native === "boolean" ? raw.native : OUTPUT_DEFAULTS.native,
  };
}
export function readOutput(node) {
  try {
    return normalizeOutput(JSON.parse(node.widgets?.find(widget => widget.name === OUTPUT_WIDGET)?.value || "{}"));
  } catch {
    return normalizeOutput();
  }
}

// History is workflow UI state, not an execution input. Never delete files on eviction.
export function mergeOutputHistory(previous, incoming) {
  const ids = [...incoming].reverse().concat(previous || []).map(item => typeof item === "string" ? item : item?.id);
  return [...new Set(ids.filter(id => ID.test(id)))].slice(0, 6).map(id => ({ id }));
}

// The node's six newest outputs: Media's items carrying its key (newest first), then what
// the workflow remembered (outputs saved before keys, or ones since deleted).
export function outputHistory(remembered, items, key) {
  const mine = key ? items.filter(item => item?.outputKey === key).sort((a, b) => (a.created || 0) - (b.created || 0)) : [];
  return mergeOutputHistory(remembered, mine);
}
