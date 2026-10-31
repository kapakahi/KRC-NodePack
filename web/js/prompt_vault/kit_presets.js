// A prompt's Loadout Kit preset links (PV_KIT_PRESETS_GAMEPLAN.md step 3), next to its
// LoRA Loadout one (llPreset / llPresetLabel):
//
//   record.kitPresets = { [kitId]: { id, label } }
//
// `id` is the kit preset's stable id (or "none:empty" for --empty--), `label` its name
// cached for the missing state. A link to a kit that isn't installed here is kept as-is.
// Mirrors normalize_kit_presets in utils/prompt_vault_store.py.

const KIT_ID_RE = /^[a-z][a-z0-9_]{1,47}$/;
const MAX_TEXT = 200;

export function normalizeKitPresets(value) {
  const out = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [kitId, link] of Object.entries(value)) {
    if (!KIT_ID_RE.test(kitId) || !link || typeof link !== "object") continue;
    const id = String(link.id || "").trim().slice(0, MAX_TEXT);
    if (!id) continue;
    out[kitId] = { id, label: String(link.label || "").trim().slice(0, MAX_TEXT) };
  }
  return out;
}

// What counts for Modified / Stale: the linked ids only (a label is a display cache).
export function kitPresetSignature(value) {
  const links = normalizeKitPresets(value);
  return Object.keys(links).sort().map((kitId) => `${kitId}=${links[kitId].id}`).join("\n");
}

// The links with one kit's set (a blank id clears it). Always a new object, so a draft
// never shares its map with the saved record it was copied from.
export function withKitPreset(value, kitId, id, label = "") {
  const next = normalizeKitPresets(value);
  if (id) next[kitId] = { id: String(id), label: String(label || "") };
  else delete next[kitId];
  return normalizeKitPresets(next);
}

// Labels for search ("active" text).
export function kitPresetLabels(value) {
  return Object.values(normalizeKitPresets(value)).map((link) => link.label).filter(Boolean);
}
