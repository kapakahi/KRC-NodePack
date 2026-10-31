// KRC Word Bank — node state: default shape, load from / save to node.properties.

// Presets are no longer part of node state — they live server-side with stable
// ids (see word_bank/api.js). State only carries the live rows + seed controls
// that must serialise into the workflow.
export const DEF_STATE = () => ({
  seed: 0,
  autoSeed: true,
  rows: [],
  activePreset: "",
  activePresetId: "",
  presetPrefixFilter: "__all__",
  tokenSyntax: "angle",
});

export function loadState(node) {
  const raw = node.properties?.wbState;
  if (!raw) return DEF_STATE();
  try {
    return { ...DEF_STATE(), ...JSON.parse(raw) };
  }
  catch { return DEF_STATE(); }
}

export function saveState(node, state) {
  if (!node.properties) node.properties = {};
  node.properties.wbState = JSON.stringify(state);
  // Keep the backing widget value in sync so ComfyUI serialises it into
  // widgets_values and passes it to Python's execute() as state_json.
  const w = node.widgets?.find(w => w.name === "state_json");
  if (w) w.value = JSON.stringify(state);
}
