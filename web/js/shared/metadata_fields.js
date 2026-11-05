// KRC info-panel metadata field vocabulary (L3-2). One ordered source of truth for
// the dirty-state snapshot projection and the discard/revert field set, shared by
// LoRA Loadout (lora lineage) and Model Library (lora + model lineage). Mirrors the
// editable projection in KRC_MODEL_METADATA_SCHEMA.md; the backend B3 normalizer is
// the Python twin of the same vocabulary.
//
// IMPORTANT: buildNormalizedMetadata() output feeds metadataSnapshotValue()'s hash,
// so the field ORDER here is significant — it must reproduce the old hand-written
// object literal exactly. The revert field lists are order-insensitive (plain
// forEach assignment).

export function normalizeMetadataList(items) {
  return Array.isArray(items) ? items.map((item) => String(item || "")) : [];
}

// The one KRC NSFW rating for LoRAs and models (twin of NSFW_RATINGS in
// utils/library/nsfw.py): Civitai's single content flags, 0 = unrated.
export const NSFW_RATINGS = [[0, "None"], [1, "PG"], [2, "PG-13"], [4, "R"], [8, "X"], [16, "XXX"]];

// Descriptor entry helpers: F(key) is a plain string field (record[key] || "");
// FN(key, get) carries a custom projection for nested/typed fields.
const F = (key) => ({ key });
const FN = (key, get) => ({ key, get });

// LoRA lineage — the snapshot projection shared by both nodes. Order matches the
// former LoRA Loadout / Model Library normalizedMetadata() literal.
export const LORA_SNAPSHOT_FIELDS = [
  F("display_name"),
  F("version"),
  F("baseModel"),
  F("category"),
  F("description"),
  FN("creator", (r) => ({ username: r.creator?.username || "" })),
  FN("usage", (r) => ({ ...(r.usage || {}), license: r.usage?.license || "" })),
  FN("nsfwLevel", (r) => Number(r.nsfwLevel) || 0),
  FN("trainedWords", (r) => normalizeMetadataList(r.trainedWords)),
  FN("tags", (r) => normalizeMetadataList(r.tags)),
  FN("examplePrompts", (r) => normalizeMetadataList(r.examplePrompts)),
  F("notes"),
];

// Deferred-detail wire contract (INFO_PANEL_RECORD_CONTRACT_GAMEPLAN.md step 2). A browser-
// list row omits heavy text (description, example prompts) and detail-only fields (creator /
// usage / notes / nsfw level) and sets these flags when that content exists. The InfoPanel
// engine (hasDeferredDetail, below) reads them to trigger the /detail read-through;
// ensureLoraDetail clears them on merge. Single-sourced here so no serializer or gate can
// drift onto a renamed/partial set — that drift (a dead `deferDetails` key) is exactly what
// blanked the Model Library / Portal LoRA InfoPanels. The Python twin is DEFERRED_DETAIL_FLAGS
// in utils/library/metadata.py; keep the two lists identical.
export const DEFERRED_DETAIL_FLAGS = ["descriptionDeferred", "examplePromptsDeferred", "detailFieldsDeferred"];

// True when a record still has deferred detail to load (any flag set).
export function hasDeferredDetail(record) {
  return DEFERRED_DETAIL_FLAGS.some((flag) => Boolean(record?.[flag]));
}

// The flags-to-clear (all false) to merge onto a record once its detail has loaded.
export function clearedDeferredDetailFlags() {
  return Object.fromEntries(DEFERRED_DETAIL_FLAGS.map((flag) => [flag, false]));
}

// Instant affordance fields (METADATA_INSTANT_SYNC_GAMEPLAN.md). Card color, custom
// badge, favorite, rating, nsfw — the lightweight toggles that persist immediately and are
// deliberately NOT in the snapshot projection above, so they never contribute to
// isMetadataModified. That exclusion is what lets them sync field-scoped and gate-free
// across every applicable node without touching any record's Modified state. (Pin is a
// record field too since 2026-10-29: one value for every node.)
export const METADATA_INSTANT_FIELDS = new Set(["cardColor", "customBadge", "favorite", "pinned", "rating", "nsfw"]);

// True when a fields tag names only instant affordance fields — the signal that a save /
// broadcast touched no snapshot (text) field, so no re-baseline is warranted.
export function isInstantOnlyFields(fields) {
  return Array.isArray(fields) && fields.length > 0 && fields.every((key) => METADATA_INSTANT_FIELDS.has(key));
}

// Model lineage adds the structured classification/provenance fields (all plain).
export const MODEL_SNAPSHOT_EXTRA_FIELDS = [
  F("modelType"),
  F("family"),
  F("architecture"),
  F("variant"),
  F("role"),
  F("parameterCount"),
  F("quantization"),
  F("precision"),
  F("releaseDate"),
  F("baseModelReleaseDate"),
  F("license"),
  F("creatorName"),
  F("companyName"),
  F("sourceName"),
];

// Full model-record snapshot projection (lora fields first, then model extras) —
// matches Model Library's former normalizedMetadata() field order.
export const MODEL_SNAPSHOT_FIELDS = [...LORA_SNAPSHOT_FIELDS, ...MODEL_SNAPSHOT_EXTRA_FIELDS];

export const MODEL_EXTRA_FIELD_KEYS = MODEL_SNAPSHOT_EXTRA_FIELDS.map((f) => f.key);

// Fields a generic-model record copies back on discard/revert: the editable plain
// lora fields a model actually uses, plus every model extra. (tags is reverted
// separately as an array.) Order-insensitive.
export const MODEL_REVERT_FIELDS = [
  "display_name",
  "baseModel",
  "version",
  "description",
  "notes",
  "nsfwLevel",
  ...MODEL_EXTRA_FIELD_KEYS,
];

// Build the normalized snapshot object for a record from an ordered field
// descriptor. Key insertion order follows `fields`, which the snapshot hash relies
// on. Plain entries default to "" ; FN entries run their projection.
export function buildNormalizedMetadata(record = {}, fields) {
  const out = {};
  for (const field of fields) {
    out[field.key] = field.get ? field.get(record) : (record[field.key] || "");
  }
  return out;
}

// The Modified badge's change list and the per-field dots (metadata_state.js
// metadataChangeDescriptor): each snapshot field's name, and the fields that hold long
// text or lists, which read just "Changed". Example prompts are one row per prompt.
export const METADATA_FIELD_LABELS = {
  display_name: "Name", version: "Version", baseModel: "Base Model", category: "Category",
  description: "Description", creator: "Creator", usage: "Usage", nsfwLevel: "NSFW Rating",
  trainedWords: "Trained Words", tags: "Tags", notes: "Notes",
  modelType: "Type", family: "Family", architecture: "Architecture", variant: "Variant",
  role: "Role", parameterCount: "Parameters", quantization: "Quantization",
  precision: "Precision", releaseDate: "Release Date", baseModelReleaseDate: "Base Model Release Date",
  license: "License", creatorName: "Creator Name", companyName: "Company", sourceName: "Source",
};
export const LONG_METADATA_FIELDS = new Set(["description", "notes", "usage", "trainedWords", "tags", "examplePrompts"]);

