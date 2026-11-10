// Media presets in the browser (GAMEPLAN.md section 4): one cache of the server's presets
// (exactly 6 slots each), refreshed after every change made here and whenever the server
// says they changed (PRESETS_EVENT, from any page). No Modified states: every edit is sent
// at once and the cache re-reads. `onPresets(listener)` re-renders nodes and pages.
// Also the preset picker menu the nodes and the Media share (a KRC floating menu).
import { closeFloatingMenu, subscribeKrcSync, toggleFloatingMenu } from "./krc.js";
import { PRESETS_EVENT, presetsApi } from "./api.js";

export const SLOT_COUNT = 6;
const TAG = "[KRC Media]";

let cache = null;          // [preset], creation order
let loading = null;
const listeners = new Set();

const notify = () => {
  for (const listener of listeners) listener();
};

// Re-read the presets; listeners hear about it only when something actually changed (a
// change made here is read once by us and again on the server's echo: one redraw).
let drawnJson = null;
export function refreshPresets() {
  // A read already in flight may predate a change just made: queue one more after it.
  if (loading) return loading.then(() => (loading ? loading : refreshPresets()));
  loading = presetsApi.list()
    .then((payload) => { cache = Array.isArray(payload.presets) ? payload.presets : []; })
    .catch((error) => {
      console.warn(`${TAG} couldn't read the media presets: ${error?.message || error}`);
      cache ||= [];
    })
    .finally(() => {
      loading = null;
      const json = JSON.stringify(cache);
      if (json === drawnJson) return;
      drawnJson = json;
      notify();
    });
  return loading;
}

subscribeKrcSync(PRESETS_EVENT, () => refreshPresets());

export function onPresets(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The presets (empty until the first read lands; the first call starts it).
export function allPresets() {
  if (!cache && !loading) refreshPresets();
  return cache || [];
}

export const presetsLoaded = () => cache !== null;

export function presetById(id) {
  return (id && allPresets().find((preset) => preset.id === id)) || null;
}

export const presetSlots = (preset) => preset?.payload?.slots || [];

// A change, then a re-read; the error (if any) is logged and handed back as text.
async function change(call, what) {
  try {
    const answer = await call();
    await refreshPresets();
    return { ok: true, preset: answer.preset || null, version: answer.version || "" };
  } catch (error) {
    const message = String(error?.message || error);
    console.warn(`${TAG} couldn't ${what}: ${message}`);
    await refreshPresets();
    return { ok: false, error: message };
  }
}

export const createPreset = ({ name = "", auto = false, numbered = false } = {}) => change(() => presetsApi.create({ name, auto, numbered }), "create a preset");
export const renamePreset = (id, name) => change(() => presetsApi.rename(id, name), "rename the preset");
export const setPresetSlot = (id, index, fields) => change(() => presetsApi.setSlot(id, index, fields), "change the slot");
export const setPresetSlots = (id, ids, start = null) => change(() => presetsApi.setSlots(id, ids, start), "replace the preset slots");
export const deletePreset = (id) => change(() => presetsApi.remove(id), "delete the preset");

// One slot, only if the preset is still at `version` (the Loader's multi-file Upload carries
// each answer's version to the next save). -> { ok, version } | { ok: false, conflict, error }.
export async function savePresetSlotAt(id, index, itemId, version) {
  try {
    const answer = await presetsApi.setSlot(id, index, { id: itemId, ...(version ? { version } : {}) });
    await refreshPresets();
    return { ok: true, preset: answer.preset || null, version: answer.version || "" };
  } catch (error) {
    const message = String(error?.message || error);
    console.warn(`${TAG} couldn't change the slot: ${message}`);
    await refreshPresets();
    return { ok: false, conflict: error?.status === 409, error: message };
  }
}

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

// The preset picker: every preset (the current one marked), then "+ New preset" (not on the
// Presets page, which has its own + button). `onPick` gets the chosen preset's id; "+ New"
// creates one and picks it.
export function openPresetMenu(anchor, { currentId = "", onPick, allowNew = true }) {
  const menu = el("div", "krc-preset-menu is-portal-menu is-fixed krc-mio-preset-menu");
  menu.hidden = true;
  const list = el("div", "krc-preset-option-list");
  const presets = allPresets();
  if (!presets.length) list.append(el("div", "krc-preset-empty", { textContent: "No presets yet" }));
  for (const preset of presets) {
    const filled = presetSlots(preset).filter((slot) => slot.id).length;
    list.append(el("button", `krc-preset-option${preset.id === currentId ? " is-selected" : ""}`, {
      type: "button",
      textContent: `${preset.name}  ·  ${filled}/${SLOT_COUNT}`,
      title: preset.name,
      onclick: (event) => {
        event.stopPropagation();
        closeFloatingMenu();
        onPick(preset.id);
      },
    }));
  }
  const add = el("button", "krc-preset-option is-muted", {
    type: "button",
    textContent: "+ New preset",
    onclick: async (event) => {
      event.stopPropagation();
      closeFloatingMenu();
      const result = await createPreset();
      if (result.ok && result.preset) onPick(result.preset.id);
    },
  });
  menu.append(list);
  if (allowNew) menu.append(add);
  toggleFloatingMenu(anchor, menu);
}

// The preset button (a node's header, the Media's Presets page): the name ▾, opening the
// preset picker.
export function presetButton({ label, title = "Pick a media preset", disabled = false, currentId = "", onPick, allowNew = true }) {
  const button = el("button", "krc-action-button krc-mio-preset-btn", { type: "button", title, disabled });
  button.append(el("span", "krc-mio-preset-label", { textContent: label }), el("span", "krc-mio-preset-caret", { textContent: "▾" }));
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!button.disabled) openPresetMenu(button, { currentId, onPick, allowNew });
  });
  return button;
}
