/*
 * Prompt Vault's search fields: the key:value aliases and the text each field searches.
 * Pure (no DOM, no ComfyUI imports), so the server's port (utils/prompt_vault_search.py,
 * external API stage 14) is checked against this exact code in the dev repo's parity test.
 * The DSL itself is shared/search.js.
 */
import { kitPresetLabels } from "./kit_presets.js";
import { categoryLabel } from "./constants.js";

// Search field aliases (LoRA Loadout key:value DSL, adapted to Prompt Vault fields).
export const PROMPT_SEARCH_ALIASES = {
  category: "category", cat: "category",
  title: "title", name: "title",
  preset: "ll_preset", presets: "ll_preset",
  type: "type", types: "type",
  has: "has", missing: "missing",
  badge: "badge", badges: "badge",
  prompt: "prompt", prompts: "prompt",
};

// Prompt A and B are searched only through `prompt:`, never by plain words. The node's list
// holds that text back, so the controller asks the server which prompts match and answers
// this field from that; on the server (and in tests) the records carry the text.
export const PROMPT_TEXT_FIELD = "prompt";

// A category matches by its stored name and its label ("Unassigned" reads "Unsorted").
const categoryText = (item) => [...new Set([item.category, categoryLabel(item.category)].filter(Boolean))].join(" ");

// The lower-case text a filter on `field` matches against (substring).
export function promptFieldText(item, field) {
  switch (field) {
    // Search the preset's human-readable label, not its opaque stable id.
    case "active": return [item.name, categoryText(item), item.llPresetLabel, ...kitPresetLabels(item.kitPresets), item.model].filter(Boolean).join(" ").toLowerCase();
    case "title": return (item.name || "").toLowerCase();
    case "category": return categoryText(item).toLowerCase();
    case "ll_preset": return (item.llPresetLabel || "").toLowerCase();
    case "type": return (item.model || "").toLowerCase();
    case "has": return item.hasThumb ? "thumb thumbnail" : "";
    case "missing": return item.hasThumb ? "" : "thumb thumbnail";
    case "badge": return (item.customBadge || "").toLowerCase();
    case "prompt": return [item.prompt, item.promptB].filter(Boolean).join("\n").toLowerCase();
    default: return "";
  }
}
