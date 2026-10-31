// What a loadout node has active, for Prompt Vault's preset sync (PRESET_SYNC_GAMEPLAN.md
// step 2). One answer for LoRA Loadout, LL mini and every Loadout Kit node (RefMod, …),
// read from the node's mounted panel, without PV reaching into panel internals.
//
// No `app` import, so it runs in tests. Kit node types are recorded by registerLoadout
// (shared/loadout_kit/index.js) through registerKitNodeType.
import { LOCAL_STATUS } from "./local_status.js";

export const LORA_LOADOUT_KIND = "lora";
const LORA_LOADOUT_TYPES = new Set(["KRC LoRA Loadout", "KRC LoRA Loadout EX"]);
const KIT_NODE_TYPES = new Map(); // node type -> kit id

export function registerKitNodeType(nodeType, kitId) {
  if (nodeType && kitId) KIT_NODE_TYPES.set(String(nodeType), String(kitId));
}

function nodeType(node) {
  return String(node?.comfyClass ?? node?.type ?? "");
}

// "lora" for LoRA Loadout / LL mini, the kit id for a kit node, else "".
export function loadoutKindOf(node) {
  const type = nodeType(node);
  if (LORA_LOADOUT_TYPES.has(type)) return LORA_LOADOUT_KIND;
  return KIT_NODE_TYPES.get(type) || "";
}

// A predicate for graph walks: nodes of that loadout kind.
export function isLoadoutOf(kind) {
  return (node) => !!kind && loadoutKindOf(node) === kind;
}

function panelOf(node) {
  return loadoutKindOf(node) === LORA_LOADOUT_KIND ? node?.__krcLoraPanel : node?.__krcKitPanel;
}

function widgetValue(node, name) {
  return String((node?.widgets || []).find((widget) => widget?.name === name)?.value ?? "");
}

// → { kind, state, presetId, presetName, presetGroup, title }
//   state "preset"   a saved preset is active (Stale counts: PV links by id, and the
//                    saved version is the newer one)
//         "modified" a preset is active but its stack has unsaved edits
//         "empty"    --empty-- (no preset, empty stack)
//         "unsaved"  cards in the stack that belong to no preset
//         "unknown"  no panel mounted and no active preset id to go on
//   "" kind = not a loadout node.
export function loadoutPresetState(node) {
  const kind = loadoutKindOf(node);
  const title = String(node?.title || nodeType(node) || "");
  const base = { kind, title, presetId: "", presetName: "", presetGroup: "" };
  if (!kind) return { ...base, state: "unknown" };

  const panel = panelOf(node);
  if (!panel?.presetSelectionState) {
    const presetId = widgetValue(node, "active_preset");
    return { ...base, presetId, state: presetId ? "preset" : "unknown" };
  }
  const selection = panel.presetSelectionState();
  if (selection?.kind === "preset" && selection.preset) {
    const preset = selection.preset;
    const out = {
      ...base,
      presetId: String(preset.id || ""),
      presetName: String(preset.name || ""),
      presetGroup: String(panel.presetGroup?.(preset) ?? preset.group ?? ""),
    };
    const status = panel.classifyActivePreset?.();
    const edited = status === LOCAL_STATUS.MODIFIED || status === LOCAL_STATUS.DRAFT;
    return { ...out, state: edited ? "modified" : "preset" };
  }
  return { ...base, state: selection?.kind === "empty" ? "empty" : "unsaved" };
}

// Ask a loadout node's mounted panel to re-read its preset link (PRESET_LINK_GAMEPLAN.md
// step 6). Prompt Vault calls this on the loadouts its preset output reaches when its link
// changes. A node without a mounted panel does nothing: its next run applies the link.
export function syncLoadoutFromPresetLink(node) {
  if (!loadoutKindOf(node)) return false;
  return panelOf(node)?.syncFromPresetLink?.() || false;
}
