// Loadout Kit constants. Cards are never resized (project rule): every slot card is the
// fixed stack-slot card height, every strip 21px, and the NODE's height follows from the
// slot count — DOM = preset panel 118 + gap 7 + stack, stack = padding 8 + header 24 +
// slots x (row + gap 4) + padding 8. Width is LL mini's 356. Mirrors loadout_kit.css.

import { KRC_SLOT_CARD_HEIGHT } from "../node_limits.js";

export const STACK_ID = "A";

// The kit's hidden widgets (Python utils/loadout_kit/kit.py HIDDEN_INPUTS + the
// JS-only group filter). A node adds its own through registerLoadout({ hiddenWidgets }).
export const STACK_WIDGET = "loadout_stack";
export const BASE_HIDDEN_WIDGETS = Object.freeze({
  [STACK_WIDGET]: "[]",
  active_preset: "",
  auto_preset_link: true,
  preset_prefix_filter: "__all__",
});

export const NODE_WIDTH = 356;
export const PRESET_PANEL_HEIGHT = 118;
export const PANEL_GAP = 7;

// Stack grid: header row + one fixed row per slot. A slot row is the slot card plus,
// when the kit has fields, gap 3 + strip 21.
export const STACK_HEADER_HEIGHT = 24;
export const STACK_PADDING = 8; // .krc-panel padding, top and bottom
export const ROW_GAP = 4;
// The stack slot card: one fixed size shared with LL / LL mini (shared/node_limits.js).
export const SLOT_CARD_HEIGHT = KRC_SLOT_CARD_HEIGHT;
// 21.875 (not 21): with 34px cards a RefMod-shaped kit (8 slots + strips) is exactly
// LL mini's 668. The strip takes the slack, never the card.
export const STRIP_HEIGHT = 21.875;
export const STRIP_GAP = 3;

// A kit's geometry from its descriptor. (RefMod: 8 slots with fields -> row 58.875,
// stack 543, DOM 668 — exactly LL mini's height.)
export function kitGeometry(slots, hasFields) {
  const rowHeight = SLOT_CARD_HEIGHT + (hasFields ? STRIP_GAP + STRIP_HEIGHT : 0);
  const stackHeight = 2 * STACK_PADDING + STACK_HEADER_HEIGHT + slots * (rowHeight + ROW_GAP);
  return { rowHeight, stackHeight, domHeight: PRESET_PANEL_HEIGHT + PANEL_GAP + stackHeight };
}

// One event for every kit's presets; the detail carries `kit` (the kit id).
export const PRESETS_CHANGED_EVENT = "krc-loadout-presets-changed";

// Node properties (per node, saved with the workflow).
export const PROP_LIST_THUMBS = "kitListThumbs";
export const PROP_SLOT_BADGE_ROW = "kitSlotBadgeRow";
export const PROP_PRESET_BASELINE = "kitPresetBaseline";
