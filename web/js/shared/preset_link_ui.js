// The preset link indicator on a loadout's preset row (PRESET_LINK_GAMEPLAN.md step 5):
// a plug glyph beside the "Preset" title saying whether the node follows a Prompt Vault
// preset link. One look for LoRA Loadout, LL mini and every Loadout Kit node.
//
// No `app` import, so it runs in tests: callers pass the root graph (app.graph).
import { nodeClassName, upstreamNode } from "./graph_walk.js";
import { storedTargetId } from "./preset_link.js";
import { canonicalGroup, NONE_PRESET_GROUP, presetDisplayName } from "./preset_naming.js";

const PROMPT_VAULT_TYPE = "KRC Prompt Vault";
// LiteGraph node modes: 2 = muted ("never"), 4 = bypassed. Either way nothing reaches
// the loadout on the link.
const INACTIVE_MODES = new Set([2, 4]);

export const PRESET_LINK_STATE = Object.freeze({
  NONE: "none",           // no Prompt Vault on the preset input: the glyph is hidden
  INACTIVE: "inactive",   // the Prompt Vault is muted or bypassed
  NO_ENTRY: "no-entry",   // linked, but the prompt sets no preset for this loadout
  PAUSED: "paused",       // linked, Auto is off
  FOLLOWING: "following", // linked, Auto on, the preset exists here
  MISSING: "missing",     // linked, Auto on, the preset isn't found
});

// A plug: mirror-symmetric about x = 8 and centred in its box, so it sits centred as a
// block (an SVG, never a text glyph).
const LINK_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M5.5 2.5v3M10.5 2.5v3"/><path d="M3.5 5.5h9v2a4.5 4.5 0 0 1-9 0z"/><path d="M8 12v1.5"/></svg>';

function widgetValueOf(node, name) {
  return (node?.widgets || []).find((widget) => widget?.name === name)?.value;
}

// What a Prompt Vault node's link says for `kind` ("lora" or a kit id): null (no entry),
// "" (--empty--) or a preset id. Read from PV's widgets, which follow its selected prompt.
export function promptVaultTargetId(pvNode, kind) {
  if (kind === "lora") return storedTargetId(widgetValueOf(pvNode, "ll_preset"));
  try {
    const rows = JSON.parse(widgetValueOf(pvNode, "kit_presets") || "{}");
    return rows && typeof rows === "object" && !Array.isArray(rows) ? storedTargetId(rows[kind]) : null;
  } catch {
    return null;
  }
}

function presetLabel(preset) {
  const name = presetDisplayName(preset);
  const group = canonicalGroup(preset?.group);
  return group === NONE_PRESET_GROUP ? name : `${group} / ${name}`;
}

// The indicator's state for a loadout `node` of `kind`. `presets` is the loadout's preset
// list; `missingId` the id its last run reported missing (krc_preset_link_missing).
export function presetLinkState({ node, kind, root = null, presets = [], auto = true, missingId = "" }) {
  const source = node ? upstreamNode(node, "preset", (n) => nodeClassName(n) === PROMPT_VAULT_TYPE, { root }) : null;
  if (!source) return { state: PRESET_LINK_STATE.NONE };
  const sourceTitle = String(source.title || "").trim() || "Prompt Vault";
  if (INACTIVE_MODES.has(source.mode)) return { state: PRESET_LINK_STATE.INACTIVE, sourceTitle };
  const targetId = promptVaultTargetId(source, kind);
  if (targetId === null) return { state: PRESET_LINK_STATE.NO_ENTRY, sourceTitle };
  const clearWhenMissing = Boolean(widgetValueOf(source, "clear_lora_when_missing"));
  const preset = targetId ? (presets || []).find((item) => item?.id === targetId) : null;
  const presetName = targetId === "" ? "--empty--" : preset ? presetLabel(preset) : "";
  const out = { sourceTitle, targetId, presetName, clearWhenMissing };
  if (!auto) return { ...out, state: PRESET_LINK_STATE.PAUSED };
  const missing = targetId !== "" && (missingId === targetId || (!preset && (presets || []).length > 0));
  return { ...out, state: missing ? PRESET_LINK_STATE.MISSING : PRESET_LINK_STATE.FOLLOWING };
}

// Whether the link drives this node right now (Auto on, an entry for it).
export function presetLinkDrives(info) {
  return info?.state === PRESET_LINK_STATE.FOLLOWING || info?.state === PRESET_LINK_STATE.MISSING;
}

// The live preview's half of the run's rule (step 6): the preset id the panel should load
// now, "" for --empty--, or null to leave it as it is. The same answer the next run gives,
// so a run after the preview changes nothing. A preset that isn't in `presets` yet (list
// still loading) is left for the run.
export function presetLinkWant(info, activeId, presets = []) {
  if (!presetLinkDrives(info)) return null;
  let want = info.targetId;
  if (info.state === PRESET_LINK_STATE.MISSING) {
    if (!info.clearWhenMissing) return null;
    want = "";
  } else if (want && !(presets || []).some((preset) => preset?.id === want)) {
    return null;
  }
  return want === String(activeId || "") ? null : want;
}

function indicatorTitle(info) {
  const from = info.sourceTitle;
  switch (info.state) {
    case PRESET_LINK_STATE.INACTIVE: return `Linked to ${from}, which is muted or bypassed.`;
    case PRESET_LINK_STATE.NO_ENTRY: return `Linked to ${from}. This prompt sets no preset here, so the stack stays as it is.`;
    case PRESET_LINK_STATE.PAUSED: return `Linked to ${from}${info.presetName ? ` (${info.presetName})` : ""}. Auto is off: the link is ignored.`;
    case PRESET_LINK_STATE.MISSING: return `Linked preset not found (${info.targetId}). The run keeps or clears the stack as ${from} says.`;
    default: return `Following ${from}: ${info.presetName || info.targetId}.`;
  }
}

// The glyph for `info` (presetLinkState), or null when nothing is linked.
export function renderPresetLinkIndicator(info) {
  if (!info || info.state === PRESET_LINK_STATE.NONE) return null;
  const indicator = document.createElement("span");
  indicator.className = `krc-preset-link is-${info.state}`;
  indicator.title = indicatorTitle(info);
  indicator.setAttribute("aria-label", indicator.title);
  const glyph = document.createElement("span");
  glyph.className = "krc-preset-link-glyph";
  glyph.innerHTML = LINK_GLYPH;
  indicator.append(glyph);
  return indicator;
}

// Swap the rendered indicator in `root` for a fresh one (cheap: no panel re-render). The
// slot is a placeholder span when nothing is linked, so the glyph has a fixed home.
export function replacePresetLinkIndicator(root, info) {
  const slot = root?.querySelector?.(".krc-preset-panel .krc-preset-link-slot");
  if (!slot) return;
  slot.replaceChildren(...[renderPresetLinkIndicator(info)].filter(Boolean));
}

export function presetLinkSlot(info) {
  const slot = document.createElement("span");
  slot.className = "krc-preset-link-slot";
  const indicator = renderPresetLinkIndicator(info);
  if (indicator) slot.append(indicator);
  return slot;
}
