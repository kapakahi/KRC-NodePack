/*
 * The result message after a single Civitai Fetch / Force Refresh (LL + ML). A plain
 * Fetch fills only empty fields, so it says what it filled and which of the user's own
 * values it kept — otherwise an unchanged custom name reads as a failed fetch.
 * Driven by the fetch route's `mode` / `filled` / `kept` / `thumbnail` fields.
 */
const FIELD_LABELS = {
  name: "name",
  originalName: "original name",
  version: "version",
  baseModel: "base model",
  description: "description",
  trainedWords: "trained words",
  tags: "tags",
};

// Thumbnail outcomes that put a new thumbnail on the card.
// "video_still" = no ffmpeg, so a still from Civitai stood in for the video poster.
const THUMBNAIL_ADDED = new Set(["image", "video", "video_still"]);

function listText(items) {
  if (items.length < 2) return items[0] || "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

const label = (key) => FIELD_LABELS[key] || key;

// payload = the fetch route's JSON body for a merged hit.
export function civitaiFetchMessage(payload = {}) {
  const source = payload.cached ? "Loaded from Civitai cache" : "Fetched from Civitai";
  // Generic models (Model Library's own merge) report no field lists.
  if (!Array.isArray(payload.filled)) return `${source}.`;
  if (payload.mode === "overwrite") return `${source} — every field replaced.`;
  const filled = payload.filled.map(label);
  if (THUMBNAIL_ADDED.has(payload.thumbnail)) filled.push("thumbnail");
  const kept = (payload.kept || []).map(label);
  const parts = [source, filled.length ? `filled ${listText(filled)}` : "nothing empty to fill"];
  if (kept.length) {
    parts.push(`kept your ${listText(kept)} (Force Refresh replaces ${kept.length === 1 ? "it" : "them"})`);
  }
  return `${parts.join(" · ")}.`;
}
