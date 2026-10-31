// KRC sibling packs (KRC_PACKS_GAMEPLAN.md): which KRC packs (KRC NodePack Extras, future
// KRC packs) are installed and whether each loaded — from GET /krc/packs, which only lists
// packs on NodePack's allowlist (utils/krc_packs.py).
//
// Public API (1.10, PUBLIC_API_PACKS_GAMEPLAN.md stage 1; krc_public_api.js re-exports them):
//   registerPackOptions("krc_extras", [{ title: "Resizer", rows: [ ...setting rows... ] }]);
//   packSetting(id) -> the row's value (its defaultValue until set)
//   onPackSettingChanged(id, (value, old) => ...) -> unsubscribe
// Rows use shared/global_settings.js's format (switch / combo / text / action; id, label,
// desc, defaultValue, options, onChange; an action row: actionLabel + onClick). Each non-action row becomes a hidden ComfyUI
// setting (stored by ComfyUI, read with app.extensionManager.setting.get); the Portal's
// Extra Options page renders them under the pack's section.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TAG = "[KRC Packs]";

export const PACK_STATUS_LABELS = Object.freeze({
  ok: "OK",
  incompatible: "Needs update",
  partial: "Partly loaded",
  failed: "Failed",
  invalid: "Bad manifest",
});

let packsPromise = null;
let packsSnapshot = null;
const packOptions = new Map(); // pack id -> [{ title, rows }]
const optionsListeners = new Set();
const settingDefaults = new Map(); // setting id -> defaultValue
const settingListeners = new Map(); // setting id -> Set(listener)

// → Promise<[status record]> (one request per page; [] when the route is unavailable).
export function loadKrcPacks() {
  packsPromise ||= api.fetchApi("/krc/packs", { cache: "no-store" })
    .then((response) => (response.ok ? response.json() : { packs: [] }))
    .then((data) => (Array.isArray(data?.packs) ? data.packs : []))
    .catch((error) => {
      console.warn(`${TAG} could not read /krc/packs`, error);
      return [];
    })
    .then((packs) => {
      packsSnapshot = packs;
      return packs;
    });
  return packsPromise;
}

// The pack list once loaded, else null (for synchronous renders; pair with loadKrcPacks).
export function krcPacksSnapshot() {
  return packsSnapshot;
}

// True when the KRC pack is installed and fully loaded (status "ok"). Sync: false until
// loadKrcPacks() has resolved — await that first when the answer matters at startup.
export function isKrcPackLoaded(packId) {
  return Boolean(packsSnapshot?.some((pack) => pack.id === packId && pack.status === "ok"));
}

// A KRC pack's settings sections for its Extra Options section. Settings register at once
// (so the pack can read them right away); the page shows only packs NodePack lists.
export function registerPackOptions(packId, sections = []) {
  const id = String(packId || "");
  if (!id || !Array.isArray(sections)) {
    console.warn(`${TAG} registerPackOptions needs (packId, sections[])`);
    return;
  }
  const clean = sections
    .filter((section) => section && Array.isArray(section.rows))
    .map((section) => ({ title: String(section.title || ""), rows: section.rows.filter((row) => row?.id && row?.kind) }));
  packOptions.set(id, clean);
  const settings = clean.flatMap((section) => section.rows
    .filter((row) => row.kind !== "action")
    .map((row) => ({
      id: row.id,
      category: ["KRC NodePack", id, section.title, row.label],
      name: row.label,
      tooltip: row.desc || "",
      type: "hidden",
      defaultValue: row.defaultValue,
      // The row's own onChange, then every onPackSettingChanged listener.
      onChange: (value, old) => {
        if (typeof row.onChange === "function") row.onChange(value, old);
        settingListeners.get(row.id)?.forEach((listener) => {
          try {
            listener(value, old);
          } catch (error) {
            console.warn(`${TAG} a listener for ${row.id} failed`, error);
          }
        });
      },
    })));
  clean.forEach((section) => section.rows.forEach((row) => settingDefaults.set(row.id, row.defaultValue)));
  if (settings.length) app.registerExtension({ name: `KRC.PackOptions.${id}`, settings });
  // Only allowlisted packs show up on the page; say so once for anything else.
  loadKrcPacks().then((packs) => {
    if (!packs.some((pack) => pack.id === id)) {
      console.warn(`${TAG} registerPackOptions("${id}"): not a KRC pack NodePack knows; its options are not shown.`);
    }
  });
  optionsListeners.forEach((listener) => listener());
}

// A pack setting's value: ComfyUI's stored value, else the row's defaultValue.
export function packSetting(id) {
  let value;
  try {
    value = app.extensionManager?.setting?.get?.(id);
  } catch {
    value = undefined;
  }
  return value === undefined || value === null ? settingDefaults.get(id) : value;
}

// Call `listener(value, old)` whenever the setting changes (on the Extra Options page or by
// code). -> unsubscribe.
export function onPackSettingChanged(id, listener) {
  if (!settingListeners.has(id)) settingListeners.set(id, new Set());
  settingListeners.get(id).add(listener);
  return () => settingListeners.get(id)?.delete(listener);
}

// [{ title, rows }] a pack registered (empty when none).
export function packOptionSections(packId) {
  return packOptions.get(packId) || [];
}

// Re-render hook for the Extra Options page (a pack may register after it opened).
export function onPackOptionsChanged(listener) {
  optionsListeners.add(listener);
  return () => optionsListeners.delete(listener);
}

function toast(severity, summary, detail) {
  try {
    app.extensionManager?.toast?.add({ severity, summary, detail, life: 12000 });
  } catch {
    // Older frontends have no toast; the console line is enough.
  }
}

// One console line + one toast per pack that isn't OK, once per page load.
app.registerExtension({
  name: "KRC.Packs",
  async setup() {
    const packs = await loadKrcPacks();
    packs.filter((pack) => pack.status !== "ok").forEach((pack) => {
      const label = `${pack.name}${pack.version ? ` ${pack.version}` : ""}`;
      console.warn(`${TAG} ${label} (${pack.folder}): ${pack.status} - ${pack.problem}`);
      toast(pack.status === "partial" ? "warn" : "error", label, pack.problem);
    });
  },
});
