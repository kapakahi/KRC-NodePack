import { DEFAULT_BROWSER_VIEW } from "../shared/browser_views.js";
import {
  KRC_BROWSER_LIST_GAP,
  KRC_BROWSER_LIST_CARD_HEIGHT,
  KRC_BROWSER_GRID_CARD_HEIGHT,
  KRC_BROWSER_GRID_COLUMNS,
  KRC_BROWSER_VIRTUAL_BUFFER_ROWS,
  KRC_GRID_VIEW_CARD_BUFFER,
  KRC_LIST_VIEW_CARD_BUFFER,
  KRC_MAX_NODE_HEIGHT,
  KRC_MAX_NODE_WIDTH,
  krcNodeMinHeight,
  KRC_THUMB_LIST_CARD_HEIGHT,
} from "../shared/node_limits.js";

export const HIDDEN_WIDGETS = {
  stack_a_loras: "[]",
  stack_b_loras: "[]",
  active_preset: "",
  auto_preset_link: true,
  stack_a_enabled: true,
  stack_b_enabled: true,
  selected_lora_sha256: "",
  show_nsfw: false,
  metadata_edit_serial: 0,
  show_favorites: false,
  color_filter: "",
  browser_view: DEFAULT_BROWSER_VIEW,
  daisy_chain_mode: false,
  preset_prefix_filter: "__all__",
};

export function hiddenWidgetDefaults(surface = "full") {
  return surface === "mini"
    ? { ...HIDDEN_WIDGETS, auto_preset_link: true }
    : HIDDEN_WIDGETS;
}

export const LORA_STRENGTH_MIN = -10;
export const LORA_STRENGTH_MAX = 10;

// LoRA Loadout has 1 input (forceInput preset) + 2 outputs (stack A / stack B); the Mini
// shares the same connectors. Height derives from 1/2 — DOM min + header + 2 slot rows.
// (krcNodeMinHeight: 668 + 26 + 2*20 = 734.) Width stays node-specific.
// The stack column is exactly 668 = preset panel 118 + 7 + stack 268 + 7 + stack 268, a
// stack = padding 8 + header 24 + 6 x (slot card KRC_SLOT_CARD_HEIGHT 34 + gap 4) +
// padding 8 — the same DOM area as Model Library / Prompt Vault. The Mini is exactly its
// stack column. Mirrors stacks_presets.css / base.css.
export const DOM_MIN_HEIGHT = 668;
export const MINI_DOM_HEIGHT = DOM_MIN_HEIGHT;
export const MIN_NODE_SIZE = [1162, krcNodeMinHeight(DOM_MIN_HEIGHT, 1, 2)];
export const MINI_NODE_SIZE = [356, krcNodeMinHeight(MINI_DOM_HEIGHT, 1, 2)];
export const FOLDER_TREE_HEIGHT = 160;

export const LIST_VIEW_CARD_BUFFER = KRC_LIST_VIEW_CARD_BUFFER;
export const GRID_VIEW_CARD_BUFFER = KRC_GRID_VIEW_CARD_BUFFER;
export const THUMB_LIST_CARD_HEIGHT = KRC_THUMB_LIST_CARD_HEIGHT;
export const BROWSER_LIST_GAP = KRC_BROWSER_LIST_GAP;
export const BROWSER_LIST_CARD_HEIGHT = KRC_BROWSER_LIST_CARD_HEIGHT;
export const BROWSER_GRID_CARD_HEIGHT = KRC_BROWSER_GRID_CARD_HEIGHT;
export const BROWSER_GRID_COLUMNS = KRC_BROWSER_GRID_COLUMNS;
export const BROWSER_VIRTUAL_BUFFER_ROWS = KRC_BROWSER_VIRTUAL_BUFFER_ROWS;
export const MAX_NODE_WIDTH = KRC_MAX_NODE_WIDTH;
export const MAX_NODE_HEIGHT = KRC_MAX_NODE_HEIGHT;

// Search helper prefixes: "model:wan" scopes a term to one field. Plain terms
// (no recognized prefix) match only the active name mode (title or filename).
export const SEARCH_FIELD_ALIASES = {
  model: "model",
  basemodel: "model",
  category: "category",
  cat: "category",
  creator: "creator",
  author: "creator",
  folder: "folder",
  folders: "folder",
  has: "has",
  missing: "missing",
  title: "title",
  name: "title",
  file: "filename",
  filename: "filename",
  trained: "trained",
  train: "trained",
  word: "trained",
  words: "trained",
  tag: "tag",
  tags: "tag",
  badge: "badge",
  badges: "badge",
  version: "version",
  ver: "version",
  civitai: "civitai",
};
