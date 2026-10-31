// Config Switcher SEED fields, the rules (CS_SEED_FIELD_GAMEPLAN.md). Pure: no DOM.
// Mirrors utils/config_switcher_presets.py (parse / format / clean) for what the server
// keeps, so the preset signature compares the same thing.
//
// Each config holds the seed number under the field id (a string, exact up to 2**64-1)
// and its lock and mode under "<field id>:seed" = "<mode>" or "<mode>:locked". Modes are
// ComfyUI's control_after_generate words. The number is saved with a preset only while
// locked; an unlocked seed moves every run and never counts as a change.

import { dynamicConfigValues } from "./dynamic_combo.js";

export const SEED_STATE_SUFFIX = ":seed";
export const SEED_MODES = ["randomize", "increment", "decrement"];
export const SEED_MAX = 18446744073709551615n; // 2**64 - 1
// Randomize rolls in ComfyUI's own randomize range (exact in a JS number).
export const SEED_RANDOM_RANGE = 1125899906842624; // 2**50

export const SEED_MODE_INFO = Object.freeze({
  randomize: { glyph: "⇄", label: "Randomize value" },
  increment: { glyph: "+1", label: "Increment value" },
  decrement: { glyph: "−1", label: "Decrement value" },
});

export function seedStateKey(fieldId) {
  return `${fieldId}${SEED_STATE_SUFFIX}`;
}

// "increment:locked" -> { mode: "increment", locked: true }; anything unknown reads as
// unlocked randomize.
export function parseSeedState(raw) {
  const [mode, flag] = String(raw || "").split(":");
  return { mode: SEED_MODES.includes(mode) ? mode : "randomize", locked: flag === "locked" };
}

export function formatSeedState({ mode, locked } = {}) {
  return `${SEED_MODES.includes(mode) ? mode : "randomize"}${locked ? ":locked" : ""}`;
}

// The next mode on a click of the mode button.
export function nextSeedMode(mode) {
  const index = SEED_MODES.indexOf(mode);
  return SEED_MODES[(index + 1) % SEED_MODES.length];
}

// Typed text as a seed: digits only, no leading zeros, clamped to 2**64-1; "" stays "".
export function sanitizeSeedInput(raw) {
  const text = String(raw ?? "");
  if (!text.trim()) return "";
  const digits = text.replace(/\D+/g, "").replace(/^0+/, "");
  if (!digits) return "0";
  const value = BigInt(digits);
  return (value > SEED_MAX ? SEED_MAX : value).toString();
}

export function randomSeed(random = Math.random) {
  return String(Math.floor(random() * SEED_RANDOM_RANGE));
}

// The seed for the next run from `value` in `mode`: a new roll, or ±1 wrapping at the ends
// (past 2**64-1 to 0, below 0 to 2**64-1).
export function nextSeed(value, mode, random = Math.random) {
  if (mode === "randomize") return randomSeed(random);
  const current = BigInt(sanitizeSeedInput(value) || "0");
  if (mode === "increment") return (current >= SEED_MAX ? 0n : current + 1n).toString();
  if (mode === "decrement") return (current <= 0n ? SEED_MAX : current - 1n).toString();
  return current.toString();
}

// One config's values as a preset keeps them: every field's value, a seed's state always
// (normalized), and a seed's number only while locked. Only the given fields' keys.
export function presetConfigValues(fields, values) {
  const source = values && typeof values === "object" ? values : {};
  const out = {};
  for (const field of fields || []) {
    if (!field?.id) continue;
    // A DYNAMIC COMBO keeps its whole set: the pick and every option's remembered settings.
    if (field.type === "dynamic_combo") {
      Object.assign(out, dynamicConfigValues(field, source));
      continue;
    }
    if (field.type === "seed") {
      const state = parseSeedState(source[seedStateKey(field.id)]);
      out[seedStateKey(field.id)] = formatSeedState(state);
      const seed = sanitizeSeedInput(source[field.id]);
      if (state.locked && seed) out[field.id] = seed;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(source, field.id)) out[field.id] = String(source[field.id] ?? "");
  }
  return out;
}
