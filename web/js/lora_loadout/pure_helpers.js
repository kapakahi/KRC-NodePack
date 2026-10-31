import { SEARCH_FIELD_ALIASES } from "./constants.js";
import { parseSearchToken as sharedParseSearchToken } from "../shared/search.js";
import { modelPresenceText } from "../shared/model_search_fields.js";

export function parseJsonArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function uiValue(message, name) {
  const value = message?.[name] ?? message?.ui?.[name];
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

export function browserLabel(lora, nameMode = "title") {
  if (nameMode === "filename") {
    return lora.filename || lora.display_name || "";
  }
  return lora.hasName ? lora.display_name : lora.filename || lora.display_name || "";
}

export function parseSearchToken(token, aliases = SEARCH_FIELD_ALIASES) {
  return sharedParseSearchToken(token, aliases);
}

export function searchFieldText(lora, field, nameMode = "title") {
  switch (field) {
    case "active":
      return browserLabel(lora, nameMode).toLowerCase();
    case "title":
      return (lora.display_name || lora.filename || "").toLowerCase();
    case "filename":
      return (lora.filename || "").toLowerCase();
    case "model":
      return (lora.baseModel || "").toLowerCase();
    case "category":
      return (lora.category || "").toLowerCase();
    case "creator":
      return (lora.creator?.username || "").toLowerCase();
    case "folder":
      return (lora.folder || "root").toLowerCase();
    case "has":
      return modelPresenceText(lora, true);
    case "missing":
      return modelPresenceText(lora, false);
    case "version":
      return (lora.version || "").toLowerCase();
    case "trained":
      return (Array.isArray(lora.trainedWords) ? lora.trainedWords.join(" ") : "").toLowerCase();
    case "tag":
      return (Array.isArray(lora.tags) ? lora.tags.join(" ") : "").toLowerCase();
    case "badge":
      return (lora.customBadge || "").toLowerCase();
    case "civitai":
      // civitai:none — checked, no Civitai match (derived from the Civitai cache).
      return lora.civitaiNotFoundAt ? "none nomatch notfound" : "";
    default:
      return "";
  }
}
