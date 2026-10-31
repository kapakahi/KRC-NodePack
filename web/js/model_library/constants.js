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
  selected_lora_sha256: "",
  show_nsfw: false,
  metadata_edit_serial: 0,
  show_favorites: false,
  color_filter: "",
  browser_view: DEFAULT_BROWSER_VIEW,
};

export function hiddenWidgetDefaults(surface = "full") {
  return HIDDEN_WIDGETS;
}


// DOM content min stays 668 — identical to Prompt Vault, so the DOM area matches it.
export const DOM_MIN_HEIGHT = 668;
// Model Library has NO input/output connectors, so its height is DOM min + header only.
// The shared krcNodeMinHeight(…,0,0) gives 694 (26px header default), but live tuning
// (ml.nodeH + krcNodeSize) showed this node is flush at 690 → a measured 22px header, 4px
// under the shared default. Trim those 4px HERE rather than lowering the shared header
// constant, which Prompt Vault / LoRA Loadout depend on. (0-connector, measured header.)
const MODEL_LIBRARY_HEADER_TRIM = 4;
export const MIN_NODE_SIZE = [882, krcNodeMinHeight(DOM_MIN_HEIGHT, 0, 0) - MODEL_LIBRARY_HEADER_TRIM];
export const MINI_NODE_SIZE = [356, krcNodeMinHeight(DOM_MIN_HEIGHT, 0, 0) - MODEL_LIBRARY_HEADER_TRIM];
export const MAX_NODE_SIZE = [KRC_MAX_NODE_WIDTH, KRC_MAX_NODE_HEIGHT];
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
