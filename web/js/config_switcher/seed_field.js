// Config Switcher SEED field: the row control and the run hook (CS_SEED_FIELD_GAMEPLAN.md;
// the rules are in seed_values.js).
//
// The row is the seed box and three glyph buttons: Lock (🔓 / 🔒, a locked seed is saved
// with the preset and never moves), Randomize (🎲, a new seed now) and Mode (cycles
// Randomize value / Increment value / Decrement value). Randomize and Mode grey out while
// locked.
//
// On each queued run (the config_data widget's beforeQueued, once per batch item, before
// the prompt is built) every unlocked seed of the ACTIVE config moves by its mode, and the
// box shows the seed that was sent. A typed or rolled seed is "start from here": the next
// run sends it as is, then the mode applies.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { h, getWidget } from "./helpers.js";
import { activeConfigValues, activeName, writeData } from "./config.js";
import {
  formatSeedState,
  nextSeed,
  nextSeedMode,
  parseSeedState,
  randomSeed,
  sanitizeSeedInput,
  SEED_MODE_INFO,
  seedStateKey,
} from "./seed_values.js";
import { configValueStores } from "./shared_values.js";

const DATA_WIDGET = "config_data";

// Seeds set by hand (typed or 🎲) that the next run sends unchanged: "<config>\0<field id>".
function heldSeeds(node) {
  node._seedHold ||= new Set();
  return node._seedHold;
}

function holdKey(node, fieldId) {
  return `${node._fields?.find(field => field.id === fieldId)?.shared ? "shared" : activeName(node)}\u0000${fieldId}`;
}

function seedState(values, field) {
  return parseSeedState(values?.[seedStateKey(field.id)]);
}

export function buildSeedValueControl(node, field, disabled) {
  const values = activeConfigValues(node, false);
  const state = seedState(values, field);
  const config = () => activeConfigValues(node, true);

  const input = h("input", {
    class: "ddp-input ddp-number-input ddp-seed-input",
    type: "text",
    inputmode: "numeric",
    placeholder: disabled ? "add a parameter first" : "seed",
    value: sanitizeSeedInput(values?.[field.id] ?? ""),
    disabled,
    "data-seed-field": field.id,
    oninput: (event) => {
      const next = sanitizeSeedInput(event.target.value);
      if (next !== event.target.value) event.target.value = next;
      const target = config();
      if (!target) return;
      target[field.id] = next;
      heldSeeds(node).add(holdKey(node, field.id));
      writeData(node);
    },
  });

  const lock = h("button", {
    class: "ddp-number-step ddp-seed-lock" + (state.locked ? " is-on" : ""),
    type: "button",
    disabled,
    title: state.locked
      ? "Locked: this seed is saved with the preset and doesn't change. Click to unlock."
      : "Unlocked: the seed changes every run and isn't saved. Click to lock this seed.",
    "aria-pressed": state.locked ? "true" : "false",
  }, h("span", { class: "ddp-seed-glyph", text: state.locked ? "🔒" : "🔓" }));

  const dice = h("button", {
    class: "ddp-number-step ddp-seed-roll",
    type: "button",
    disabled: disabled || state.locked,
    title: "Roll a new seed now",
  }, h("span", { class: "ddp-seed-glyph", text: "🎲" }));

  const info = SEED_MODE_INFO[state.mode];
  const mode = h("button", {
    class: "ddp-number-step ddp-seed-mode",
    type: "button",
    disabled: disabled || state.locked,
    title: `${info.label} each run. Click for ${SEED_MODE_INFO[nextSeedMode(state.mode)].label}.`,
  }, h("span", { class: "ddp-seed-glyph ddp-seed-mode-glyph", text: info.glyph }));

  // Lock and mode re-render the row (its buttons' states all change together).
  const writeState = (next) => {
    const target = config();
    if (!target) return;
    target[seedStateKey(field.id)] = formatSeedState(next);
    writeData(node);
    const row = buildSeedValueControl(node, field, disabled);
    wrap.replaceWith(row);
  };
  lock.addEventListener("click", () => {
    const target = config();
    if (!target) return;
    // Locking keeps the number in the box; an empty box gets one first.
    if (!state.locked && !sanitizeSeedInput(target[field.id])) target[field.id] = randomSeed();
    writeState({ ...state, locked: !state.locked });
  });
  mode.addEventListener("click", () => writeState({ ...state, mode: nextSeedMode(state.mode) }));
  dice.addEventListener("click", () => {
    const target = config();
    if (!target || state.locked) return;
    target[field.id] = randomSeed();
    input.value = target[field.id];
    heldSeeds(node).add(holdKey(node, field.id));
    writeData(node);
  });

  const wrap = h("div", { class: "ddp-seed-value" + (state.locked ? " is-locked" : "") }, [input, lock, dice, mode]);
  return wrap;
}

// A new seed field: every config starts unlocked, randomizing, with its own random seed.
export function initSeedField(node, field) {
  for (const values of Object.values(node._configs || {})) {
    if (!values || typeof values !== "object") continue;
    values[field.id] = randomSeed();
    values[seedStateKey(field.id)] = formatSeedState({ mode: "randomize", locked: false });
  }
}

// After a preset loads: an unlocked seed isn't saved, so each config gets a fresh one.
export function fillUnsavedSeeds(node) {
  const seeds = (node._fields || []).filter((field) => field.type === "seed");
  if (!seeds.length) return;
  for (const values of configValueStores(node)) {
    if (!values || typeof values !== "object") continue;
    for (const field of seeds) {
      if (values === node._sharedValues && !field.shared) continue;
      if (!sanitizeSeedInput(values[field.id])) values[field.id] = randomSeed();
    }
  }
}

// Share toggled: a seed held under the active config stays held as the shared one; turned
// off, the shared hold goes (each config's own seed comes back as it was).
export function moveSeedHoldForShare(node, field) {
  const held = heldSeeds(node);
  const own = `${activeName(node)}\u0000${field.id}`;
  const common = `shared\u0000${field.id}`;
  if (!field.shared) held.delete(common);
  else if (held.delete(own)) held.add(common);
}

// Move the active config's unlocked seeds for one run. -> whether anything changed.
export function advanceSeedsForRun(node) {
  const values = activeConfigValues(node, false);
  if (!values) return false;
  let changed = false;
  for (const field of node._fields || []) {
    if (field.type !== "seed") continue;
    const state = seedState(values, field);
    if (state.locked) continue;
    const key = holdKey(node, field.id);
    if (heldSeeds(node).delete(key) && sanitizeSeedInput(values[field.id])) continue;
    values[field.id] = nextSeed(values[field.id], state.mode);
    changed = true;
    const box = node._ddp?.fields?.querySelector(`.ddp-seed-input[data-seed-field="${field.id}"]`);
    if (box) box.value = values[field.id];
  }
  if (changed) writeData(node);
  return changed;
}

// The config_data widget's beforeQueued: ComfyUI calls it once per queued run (each batch
// item), before it builds the prompt, so the run sends the moved seeds.
export function installSeedRunHook(node) {
  const widget = getWidget(node, DATA_WIDGET);
  if (!widget || widget._krcSeedHook) return;
  widget._krcSeedHook = true;
  const previous = widget.beforeQueued;
  widget.beforeQueued = function (...args) {
    advanceSeedsForRun(node);
    return previous?.apply(this, args);
  };
}
