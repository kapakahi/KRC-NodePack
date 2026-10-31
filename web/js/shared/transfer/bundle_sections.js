/*
 * The KRC bundle's sections — one per kind of data a bundle can carry
 * (UNIFIED_BUNDLE_GAMEPLAN.md). The Export and Import dialogs (bundle_dialogs.js) and the
 * Portal's Import and Export page list these. The server has the same list
 * (utils/bundle/sections.py); counts come from GET /krc/bundle/sections, and a section's
 * id is also its transfer-history key.
 *
 * Section fields:
 *   id          the section's id in a bundle (a kit's: "kit_presets/<kit id>")
 *   label, hint the dialog's line name + one-line description
 *   unit        what the count counts ("LoRA" -> "120 LoRAs")
 *   picker      "category" | "bank": the section can export a chosen subset
 *   events      sync events an import of it publishes (lanes as in sync_bus.js)
 *   after       optional refresh after an import (Collections)
 *
 * KRC packs add theirs with registerBundleSection (public API 1.13).
 */
import { api } from "../../../../scripts/api.js";
import { reloadCollectionsEverywhere } from "../collections_client.js";
import { PRESETS_CHANGED_EVENT as KIT_PRESETS_CHANGED_EVENT } from "../loadout_kit/constants.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES } from "../sync_bus.js";
import { loadKits } from "./kinds.js";

const { CONTENT, STRUCTURE } = KRC_SYNC_LANES;

export const BUNDLE_SECTIONS = Object.freeze([
  { id: "lora_library", label: "LoRA library", hint: "LoRA metadata, thumbnails and folder colours", unit: "LoRA",
    events: [{ name: KRC_SYNC_EVENTS.LIBRARY_CHANGED, lane: STRUCTURE, detail: { lineages: ["loras"] } }] },
  { id: "lora_presets", label: "LoRA Loadout presets", hint: "Stack presets", unit: "preset",
    events: [{ name: KRC_SYNC_EVENTS.LORA_PRESETS_CHANGED, lane: CONTENT }] },
  { id: "model_library", label: "Model Library", hint: "Model metadata and thumbnails", unit: "model",
    events: [{ name: KRC_SYNC_EVENTS.LIBRARY_CHANGED, lane: STRUCTURE, detail: { lineages: ["models"] } }] },
  { id: "collections", label: "Collections", hint: "Collections of models and LoRAs", unit: "collection",
    events: [], after: () => reloadCollectionsEverywhere() },
  { id: "prompt_vault", label: "Prompt Vault", hint: "Prompts and their thumbnails", unit: "prompt", picker: "category",
    events: [{ name: KRC_SYNC_EVENTS.PROMPTS_CHANGED, lane: STRUCTURE }] },
  { id: "config_switcher_presets", label: "Config Switcher presets", hint: "Presets", unit: "preset",
    events: [{ name: KRC_SYNC_EVENTS.CONFIG_SWITCHER_PRESETS_CHANGED, lane: STRUCTURE }] },
  { id: "word_bank", label: "Word Bank", hint: "Banks and presets", unit: "bank", picker: "bank",
    events: [
      { name: KRC_SYNC_EVENTS.WORDBANK_BANKS_CHANGED, lane: STRUCTURE },
      { name: KRC_SYNC_EVENTS.WORDBANK_PRESETS_CHANGED, lane: STRUCTURE },
    ] },
]);

export const KIT_SECTION_PREFIX = "kit_presets/";
export const PACK_SECTION_PREFIX = "pack/";

// The imported sections' events, each sent once: the LoRA and model libraries both send
// LIBRARY_CHANGED, and two publishes made every surface reload twice. An event goes out
// with the first section that has it (same name and detail, `lineages` aside), carrying
// every section's lineages; an untagged copy makes the merged one untagged. -> one events
// array per section, in order.
export function mergedSectionEvents(sections = []) {
  const first = new Map();
  return sections.map((section) => (section?.events || []).flatMap((event) => {
    const { lineages, ...rest } = event.detail || {};
    const key = `${event.name}\n${JSON.stringify(rest)}`;
    const seen = first.get(key);
    if (seen) {
      const merged = seen.detail.lineages;
      seen.detail.lineages = Array.isArray(merged) && Array.isArray(lineages)
        ? [...new Set([...merged, ...lineages])]
        : undefined;
      return [];
    }
    const copy = { ...event, detail: { ...rest, lineages: Array.isArray(lineages) ? [...lineages] : undefined } };
    first.set(key, copy);
    return [copy];
  }));
}

// KRC packs' sections (public API 1.13: registerBundleSection), by id.
const packSections = new Map();

// A KRC pack's bundle section descriptor: { id: "pack/<pack id>__<name>" (the id its Python
// register_bundle_section returned), label, hint, unit, events, after }. The section shows in
// the dialogs only when the server lists it too (its pack is allowlisted and loaded).
export function registerBundleSection(descriptor = {}) {
  const id = String(descriptor.id || "");
  if (!/^pack\/[a-z][a-z0-9_]*__[a-z][a-z0-9]{0,31}$/.test(id)) {
    console.warn(`[KRC Bundle] registerBundleSection: the id must be "pack/<pack id>__<name>", got ${JSON.stringify(id)}`);
    return false;
  }
  packSections.set(id, Object.freeze({
    id,
    label: String(descriptor.label || id),
    hint: String(descriptor.hint || ""),
    unit: String(descriptor.unit || "item"),
    events: Array.isArray(descriptor.events) ? descriptor.events.filter((event) => /^krc-/.test(String(event?.name || ""))) : [],
    ...(typeof descriptor.after === "function" ? { after: descriptor.after } : {}),
  }));
  return true;
}

function kitSection(descriptor) {
  const kitId = String(descriptor.id);
  const label = String(descriptor.label || kitId);
  return {
    id: `${KIT_SECTION_PREFIX}${kitId}`,
    label: `${label} presets`,
    hint: "Loadout presets",
    unit: "preset",
    events: [{ name: KIT_PRESETS_CHANGED_EVENT, lane: CONTENT, detail: { kit: kitId } }],
  };
}

// -> { section id: count } from the server ({} when it can't answer).
async function fetchCounts() {
  try {
    const response = await api.fetchApi("/krc/bundle/sections", { cache: "no-store" });
    const body = response.ok ? await response.json() : null;
    return Object.fromEntries((body?.sections || []).map((entry) => [entry.id, entry.count]));
  } catch {
    return {};
  }
}

// Every section this machine knows (core + one per registered kit), without counts.
export async function knownSections() {
  const kits = await loadKits().catch(() => []);
  return [...BUNDLE_SECTIONS, ...kits.map(kitSection), ...packSections.values()];
}

// The sections with their counts (null when unknown), only those the server has (a node
// that didn't load has no section). -> [{ ...section, count }]
export async function bundleSections() {
  const [sections, counts] = await Promise.all([knownSections(), fetchCounts()]);
  const known = Object.keys(counts).length ? (section) => section.id in counts : () => true;
  return sections.filter(known).map((section) => ({ ...section, count: counts[section.id] ?? null }));
}

export function countText(section, count = section.count) {
  if (count === null || count === undefined) return "—";
  const n = Number(count) || 0;
  return `${n} ${n === 1 ? section.unit : `${section.unit}s`}`;
}

// What's inside a section of an uploaded bundle, from its manifest counts:
// "214 LoRAs", "3 categories, 120 prompts", "2 banks, 5 presets".
export function bundleCountText(counts) {
  const words = { loras: "LoRA", models: "model", presets: "preset", collections: "collection", prompts: "prompt",
    categories: ["category", "categories"], banks: "bank" };
  const parts = Object.entries(counts || {}).map(([key, value]) => {
    const word = words[key] || key;
    const [one, many] = Array.isArray(word) ? word : [word, `${word}s`];
    return `${value} ${value === 1 ? one : many}`;
  });
  return parts.join(", ") || "empty";
}
