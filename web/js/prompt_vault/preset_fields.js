/*
 * KRC Prompt Vault — preset fields.
 * Preset fields: the LL Preset row and the Loadout Kit preset rows (group filter + searchable
 * picker), the module-wide LL / kit preset caches kept fresh by the presets-changed events,
 * and the per-node kit row switches.
 * Mixed onto PMRedesign.prototype via Object.assign.
 */
import { switchToggle } from "../shared/browser_controls.js";
import { getJson } from "../shared/api.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { LORA_LOADOUT_KIND } from "../shared/loadout_presets.js";
import { subscribeKrcSync } from "../shared/sync_bus.js";
import {
  normalizePresetPrefixFilter,
  presetDisplayName,
  presetGroup,
  presetGroupLabel,
  presetPrefixOptions,
  presetsForPrefix,
} from "../shared/preset_naming.js";
import {
  PRESETS_CHANGED_EVENT as KIT_PRESETS_CHANGED_EVENT,
} from "../shared/loadout_kit/constants.js";
import { el } from "./dom.js";
import { EMPTY_PRESET_DISPLAY, EMPTY_PRESET_LINK } from "./constants.js";
import { normalizeKitPresets, withKitPreset } from "./kit_presets.js";

// The LoRA Loadout preset list is a shared server-side resource; Prompt Vault's
// picker reads the same endpoint. Cached module-wide so re-rendering the info
// panel (frequent) doesn't refetch. A single window listener keeps the cache and
// the currently-mounted picker in sync when LoRA Loadout saves/renames/deletes.
let _llPresetCache = [];
let _llPresetLoaded = false;
let _llPresetLoadPromise = null;
let _activePresetRefresh = null;

function loadLlPresetsOnce(force = false) {
  if (force || !_llPresetLoadPromise) {
    _llPresetLoadPromise = getJson("/krc/lora-loadout/presets", { fallback: { presets: [] } })
      .then((data) => {
        _llPresetCache = Array.isArray(data?.presets) ? data.presets : [];
        _llPresetLoaded = true;
        return _llPresetCache;
      })
      .catch(() => _llPresetCache);
  }
  return _llPresetLoadPromise;
}

if (typeof window !== "undefined" && !window.__krcPvPresetSyncBound) {
  window.__krcPvPresetSyncBound = true;
  subscribeKrcSync("krc-lora-presets-changed", () => {
    loadLlPresetsOnce(true).then(() => _activePresetRefresh?.());
  });
}

// Loadout Kit preset rows (PV_KIT_PRESETS_GAMEPLAN.md step 3). A kit opts in with
// `prompt_vault` (descriptor `promptVault`); its row is per node, off by default
// (node.properties.pmKitRows), and always shown in the Portal. Kits and each kit's presets
// are cached module-wide like the LL list.
export let _pvKits = [];
export let _pvKitsLoaded = false;
let _pvKitsPromise = null;
const _kitPresets = new Map();          // kit id -> { presets, loaded, promise }
const _kitPresetRefreshers = new Set(); // mounted kit pickers: (kitId) => void

// Never fetched at import: kits register when ComfyUI first calls their node's
// INPUT_TYPES (object_info), which runs AFTER extensions load. The first panel render is
// after that. An empty answer isn't kept, so `retry` (the Options modal) can ask again.
export function loadPvKitsOnce({ retry = false } = {}) {
  if (retry && _pvKitsLoaded && !_pvKits.length) _pvKitsPromise = null;
  _pvKitsPromise ||= getJson("/krc/loadout/kits", { fallback: {} })
    .then((kits) => {
      _pvKits = Object.values(kits && typeof kits === "object" ? kits : {})
        .filter((kit) => kit?.id && kit.promptVault)
        .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id), undefined, { sensitivity: "base" }));
      _pvKitsLoaded = true;
      return _pvKits;
    })
    .catch(() => {
      _pvKitsLoaded = true;
      return _pvKits;
    });
  return _pvKitsPromise;
}

function kitPresetState(kitId) {
  if (!_kitPresets.has(kitId)) _kitPresets.set(kitId, { presets: [], loaded: false, promise: null });
  return _kitPresets.get(kitId);
}

function loadKitPresetsOnce(kitId, force = false) {
  const state = kitPresetState(kitId);
  if (force || !state.promise) {
    state.promise = getJson(`/krc/loadout/${encodeURIComponent(kitId)}/presets`, { fallback: { presets: [] } })
      .then((data) => {
        state.presets = Array.isArray(data?.presets) ? data.presets : [];
        state.loaded = true;
        return state.presets;
      })
      .catch(() => state.presets);
  }
  return state.promise;
}

if (typeof window !== "undefined" && !window.__krcPvKitPresetSyncBound) {
  window.__krcPvKitPresetSyncBound = true;
  subscribeKrcSync(KIT_PRESETS_CHANGED_EVENT, (event) => {
    const kitId = event?.detail?.kit;
    if (!kitId || !_kitPresets.has(kitId)) return;
    loadKitPresetsOnce(kitId, true).then(() => {
      for (const refresh of [..._kitPresetRefreshers]) refresh(kitId);
    });
  });
}

// The preset picker's options for one source (LL or a kit): "--none--" (emits nothing),
// "--empty--" (clears that loadout), the presets under the group filter, and an unresolved
// link injected as "⚠ <label> (missing)" so a broken reference stays visible. A known
// preset this filter hides is not injected (presetPickerValue shows "none" for it).
function presetPickerOptions({ presets, loaded, prefixFilter, currentId, label }) {
  const allPrefixes = prefixFilter === "__all__";
  const options = [
    { name: "--none--", value: "", muted: true },
    { name: EMPTY_PRESET_DISPLAY, value: EMPTY_PRESET_LINK },
  ];
  for (const preset of presetsForPrefix(presets, prefixFilter)) {
    options.push({
      name: presetDisplayName(preset),
      value: preset.id,
      group: allPrefixes ? presetGroupLabel(preset) : "",
    });
  }
  if (currentId && currentId !== EMPTY_PRESET_LINK && !presets.some((preset) => preset.id === currentId)) {
    options.push({
      name: loaded ? `⚠ ${label || "unknown preset"} (missing)` : (label || "…"),
      value: currentId,
      group: allPrefixes && loaded ? "Missing" : "",
    });
  }
  return options;
}

// The value the picker displays under a group filter: the selection when it's in this
// group (or "all"), or an unresolved link (shown via its injected option); otherwise ""
// so the button reads "none". The stored selection is never changed by the filter.
function presetPickerValue(presets, prefixFilter, id) {
  if (!id) return "";
  if (id === EMPTY_PRESET_LINK) return id;
  if (!presets.some((preset) => preset.id === id)) return id;
  return presetsForPrefix(presets, prefixFilter).some((preset) => preset.id === id) ? id : "";
}

export const presetFieldMethods = {
  // LL Preset: a prefix filter + searchable preset picker (mirroring the LoRA
  // Loadout preset column) plus a ⇄ sync button that reads the preset from the LoRA
  // Loadout the preset output drives. The record stores a stable preset *id*
  // (d.llPreset) with a cached display name (d.llPresetLabel) for the missing state.
  buildLlPresetOptions(prefixFilter, currentId) {
    return presetPickerOptions({
      presets: _llPresetCache, loaded: _llPresetLoaded, prefixFilter, currentId, label: this.draft?.llPresetLabel || "",
    });
  },

  llPresetDisplayValue(prefixFilter, id) {
    return presetPickerValue(_llPresetCache, prefixFilter, id);
  },

  setLlPreset(id, label) {
    const d = this.draft || {};
    d.llPreset = id || "";
    if (label != null) d.llPresetLabel = String(label || "");
    else if (!id) d.llPresetLabel = "";
    this.draftChanged();
  },

  // One preset field: label, then [group ▾][preset ▾][trailing button]. Shared by the LL
  // field and the kit rows; `source` supplies the list and reads / writes the draft.
  //   presets() / loaded()             the cached list and whether it has arrived
  //   currentId() / currentLabel()     the draft's link
  //   rememberLabel(name)              heal the cached label from the live preset
  //   select(id, name)                 write the draft
  presetPickerRow({ label, buttonTitle, source, trailing }) {
    const wrap = el("div", "krc-pv-preset-field");
    wrap.append(this.fieldLabel(label));
    const row = el("div", "krc-pv-preset-row");

    const resolved = () => source.presets().find((preset) => preset.id === source.currentId()) || null;
    let prefixFilter = resolved() ? presetGroup(resolved()) : "__all__";
    const options = () => presetPickerOptions({
      presets: source.presets(), loaded: source.loaded(), prefixFilter,
      currentId: source.currentId(), label: source.currentLabel(),
    });
    const value = () => presetPickerValue(source.presets(), prefixFilter, source.currentId());

    const prefixPicker = createSearchableSelect({
      options: presetPrefixOptions(source.presets()).map(([v, name]) => ({ value: v, name })),
      value: prefixFilter,
      placeholder: "All",
      searchPlaceholder: "Search groups...",
      emptyText: "No groups found.",
      buttonTitle: "Preset group",
      ariaLabel: "Preset group",
      fixedMenu: true,
      menuWidth: 160,
      onSelect: (next) => {
        prefixFilter = next || "__all__";
        presetPicker.setOptions(options(), value());
      },
    });
    prefixPicker.el.classList.add("krc-preset-prefix-picker");

    const presetPicker = createSearchableSelect({
      options: options(),
      value: value(),
      placeholder: "--none--",
      searchPlaceholder: "Search presets...",
      emptyText: "No presets found.",
      buttonTitle,
      fixedMenu: true,
      menuWidth: 300,
      onSelect: (next) => {
        if (next === EMPTY_PRESET_LINK) {
          source.select(next, EMPTY_PRESET_DISPLAY);
          return;
        }
        const preset = source.presets().find((item) => item.id === next);
        source.select(next, preset ? preset.name : (next ? source.currentLabel() : ""));
      },
    });
    const presetWrap = el("div", "krc-preset-select-wrap");
    presetWrap.append(presetPicker.el);

    row.append(prefixPicker.el, presetWrap, trailing);
    wrap.append(row);

    // Repopulate both pickers from the cache + current draft. Used on async load, on the
    // cross-node presets-changed event, after a paste, and by undo/redo.
    const rebuildAll = () => {
      if (!wrap.isConnected) return;
      const preset = resolved();
      if (preset) {
        source.rememberLabel(preset.name);
        prefixFilter = presetGroup(preset);
      } else {
        // A group renamed or emptied elsewhere: back to All rather than an empty list.
        prefixFilter = normalizePresetPrefixFilter(source.presets(), prefixFilter);
      }
      prefixPicker.setOptions(
        presetPrefixOptions(source.presets()).map(([v, name]) => ({ value: v, name })),
        prefixFilter,
      );
      presetPicker.setOptions(options(), value());
    };
    return { wrap, rebuildAll };
  },

  presetPickerField(d) {
    let rebuildAll = () => {};
    const sync = this.presetSyncButton({
      kind: LORA_LOADOUT_KIND,
      noun: "LoRA Loadout",
      apply: (id, label) => {
        this.setLlPreset(id, label);
        rebuildAll();
      },
    });

    let row;
    ({ wrap: row, rebuildAll } = this.presetPickerRow({
      label: "LL Preset",
      buttonTitle: "LoRA Loadout preset (emitted on the preset output)",
      trailing: sync,
      source: {
        presets: () => _llPresetCache,
        loaded: () => _llPresetLoaded,
        currentId: () => this.draft?.llPreset || "",
        currentLabel: () => this.draft?.llPresetLabel || "",
        rememberLabel: (name) => { d.llPresetLabel = name; },
        select: (id, name) => this.setLlPreset(id, name),
      },
    }));

    this._pmPresetPicker = { syncBtn: sync, rebuildAll, syncToDraft: rebuildAll };
    _activePresetRefresh = rebuildAll;

    // Fill in once the shared preset list resolves (first mount fetches; later
    // mounts use the cache synchronously and this just reconciles).
    loadLlPresetsOnce().then(() => rebuildAll());

    return row;
  },

  // ── Loadout Kit preset rows ──────────────────────────────────────────────
  // The kits with a row on this surface: in the Portal every opted-in kit, on a node only
  // the ones switched on in its Options.
  visibleKitRows() {
    if (this.surface === "detached") return _pvKits;
    const enabled = this.node?.properties?.pmKitRows || {};
    return _pvKits.filter((kit) => enabled[kit.id]);
  },

  kitRowEnabled(kitId) {
    return !!this.node?.properties?.pmKitRows?.[kitId];
  },

  setKitRowEnabled(kitId, on) {
    const next = { ...(this.node?.properties?.pmKitRows || {}) };
    if (on) next[kitId] = true;
    else delete next[kitId];
    this.setSerializableProperty?.("pmKitRows", next);
    this.syncKitPresetsWidget?.();   // the row's line joins / leaves the preset output
    this.markCanvasDirty?.();
    this.refreshInfoPanel();
  },

  kitPresetLink(kitId) {
    return normalizeKitPresets(this.draft?.kitPresets)[kitId] || null;
  },

  setKitPreset(kitId, id, label) {
    if (!this.draft) return;
    this.draft.kitPresets = withKitPreset(this.draft.kitPresets, kitId, id, label);
    this.draftChanged();
  },

  kitPresetPickerField(kit) {
    const kitId = kit.id;
    const name = kit.shortLabel || kit.label || kitId;
    let rebuildAll = () => {};
    const sync = this.presetSyncButton({
      kind: kitId,
      noun: kit.label || name,
      apply: (id, label) => {
        this.setKitPreset(kitId, id, label);
        rebuildAll();
      },
    });

    const state = kitPresetState(kitId);
    let wrap;
    ({ wrap, rebuildAll } = this.presetPickerRow({
      label: `${name} Preset`,
      buttonTitle: `${kit.label || name} preset (saved with the prompt)`,
      trailing: sync,
      source: {
        presets: () => state.presets,
        loaded: () => state.loaded,
        currentId: () => this.kitPresetLink(kitId)?.id || "",
        currentLabel: () => this.kitPresetLink(kitId)?.label || "",
        rememberLabel: (label) => {
          const link = this.kitPresetLink(kitId);
          // Silent heal, like LL's: the label is a display cache, not an edit.
          if (link && link.label !== label && this.draft) {
            this.draft.kitPresets = withKitPreset(this.draft.kitPresets, kitId, link.id, label);
          }
        },
        select: (id, label) => this.setKitPreset(kitId, id, label),
      },
    }));
    wrap.classList.add("is-kit");
    wrap.dataset.kit = kitId;

    this._pmKitPickers = [
      ...(this._pmKitPickers || []).filter((picker) => picker.wrap.isConnected && picker.kitId !== kitId),
      { kitId, wrap, syncToDraft: rebuildAll },
    ];
    const refresh = (changedKit) => {
      if (!wrap.isConnected) {
        _kitPresetRefreshers.delete(refresh);
        return;
      }
      if (changedKit === kitId) rebuildAll();
    };
    _kitPresetRefreshers.add(refresh);
    loadKitPresetsOnce(kitId).then(() => rebuildAll());
    return wrap;
  },

  async refreshLlPresetCache({ patchPicker = true } = {}) {
    await loadLlPresetsOnce(true);
    if (patchPicker) {
      this._pmPresetPicker?.rebuildAll?.();
    }
  },

  renderKitRowToggles() {
    const items = [];
    for (const kit of _pvKits) {
      const name = kit.shortLabel || kit.label || kit.id;
      const kitToggle = switchToggle({
        label: `Show ${name} preset row`,
        active: this.kitRowEnabled(kit.id),
        title: `Show a ${name} preset picker under LL Preset`,
        onClick: () => {
          const next = !this.kitRowEnabled(kit.id);
          this.setKitRowEnabled(kit.id, next);
          kitToggle.classList.toggle("is-on", next);
        },
      });
      const kitDesc = el("div", "krc-options-description", {
        textContent: `Adds a ${name} Preset row below LL Preset, saved with each prompt. `
          + "Prompt A gets shorter to make room; the node keeps its size.",
      });
      items.push(kitToggle, kitDesc);
    }
    return items;
  },
};
