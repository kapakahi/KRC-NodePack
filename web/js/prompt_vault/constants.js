/*
 * KRC Prompt Vault — constants.
 * Node id, API base, sizing, view modes, and the search field-alias table.
 */

import { KRC_MAX_NODE_HEIGHT, KRC_MAX_NODE_WIDTH, krcNodeMinHeight } from "../shared/node_limits.js";
import { STORED_EMPTY } from "../shared/preset_link.js";

export const API = "/krc/prompt-vault";
export const NODE_TYPE = "KRC Prompt Vault";
export const UNASSIGNED_CATEGORY = "Unassigned";
// The default bucket reads "Unsorted" (like Media's); the stored name stays "Unassigned".
export const UNASSIGNED_LABEL = "Unsorted";
export const categoryLabel = (category) => (category === UNASSIGNED_CATEGORY ? UNASSIGNED_LABEL : category);
// Sentinel key for the one node-local draft prompt (a synthetic browser item, not
// a real saved record); rendered as the top card in the list.
export const DRAFT_KEY = "__draft__";
// A prompt's stored --empty-- link (ll_preset / kitPresets). Storage only: the preset link
// sends it as id "" (shared/preset_link.js).
export const EMPTY_PRESET_LINK = STORED_EMPTY;
export const EMPTY_PRESET_DISPLAY = "--empty--";

// The DOM panel is 668px tall. Prompt Vault has 1 input (forceInput preset) + 2 outputs
// (prompt, preset), so its node height is derived with 1/2 — DOM min + header + 2 slot
// rows. (krcNodeMinHeight: 668 + 26 + 2*20 = 734.)
export const DOM_MIN_HEIGHT = 668;
export const MIN_NODE_SIZE = [882, krcNodeMinHeight(DOM_MIN_HEIGHT, 1, 2)];
export const MAX_NODE_SIZE = [KRC_MAX_NODE_WIDTH, KRC_MAX_NODE_HEIGHT];
// View toggle order/tokens are shared with the LoRA Loadout (single source).
export { BROWSER_VIEWS as VIEWS } from "../shared/browser_views.js";

// Search field aliases: shared with the server's search port (search_fields.js).
export { PROMPT_SEARCH_ALIASES as ALIASES } from "./search_fields.js";
