// KRC Word Bank — preset picker, preset actions, and cross-node preset refresh.

import { el } from "../shared/dom.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { localStatusBadge } from "../shared/badges.js";
import { classifyLocalStatus, localStatusCopy, LOCAL_STATUS, statusOverwrites } from "../shared/local_status.js";
import { KRC_SYNC_LANES, isOwnSyncEvent, publishKrcSync, subscribeKrcSync } from "../shared/sync_bus.js";
import { openPresetNameDialog } from "../shared/preset_name_dialog.js";
import { followGroupChange, groupChangeDetail, presetGroupMenu } from "../shared/preset_group_actions.js";
import {
  NONE_PRESET_GROUP,
  NONE_PRESET_GROUP_LABEL,
  canonicalGroup,
  normalizePresetPrefixFilter,
  presetGroup,
  presetOptionsForPrefix,
  presetPrefixOptions,
  presetsForPrefix,
} from "../shared/preset_naming.js";
import { fetchPresets, savePreset, renamePreset, deletePreset } from "./api.js";
import { loadState, saveState } from "./state.js";
import { resizeNode } from "./layout.js";
import { krcAlert, openKrcConfirm } from "../shared/modal.js";
import { wordBankChangeRows } from "./change_rows.js";

const PRESET_CYCLE_SESSION_MS = 2500;

function sig(rows) {
  return JSON.stringify((rows || []).map(r => [String(r.categoryId || r.category || ""), String(r.value || ""), !!r.locked]));
}

function presetId(preset) {
  return String(preset?.id || "");
}

export function createPresetControls({
  node,
  rowsEl,
  makeRow,
  reassignOcc,
  rowsFromDOM,
}) {
  // ── preset selection row: dropdown + modified badge + cycle arrows (top) ──
  const presetRow  = el("div", "wb-preset-row");
  const prefixWrap = el("div", "wb-preset-prefix-wrap");
  const presetWrap = el("div", "wb-preset-select-wrap");
  // Shared searchable picker (same control as the LoRA Loadout preset menu).
  // Options are filled in by refreshPresetOptions once presets load; selecting
  // one auto-loads it via onPresetSelected (the placeholder, value "", is a
  // no-op — matching the old native <select> behaviour).
  const prefixSel = createSearchableSelect({
    options: [{ name: "All", value: "__all__" }, { name: NONE_PRESET_GROUP_LABEL, value: NONE_PRESET_GROUP }],
    value: loadState(node).presetPrefixFilter || "__all__",
    placeholder: "All",
    searchPlaceholder: "Search groups...",
    emptyText: "No groups found.",
    buttonTitle: "Preset group",
    ariaLabel: "Preset group",
    fixedMenu: true,
    menuWidth: 160,
    // "⋯" per group: Rename / Ungroup / Delete group.
    optionMenu: presetGroupMenu({ node, presets: () => presetCache, base: "/wordbank/presets", onDone: applyGroupChange }),
    optionMenuTitle: "Group actions",
    onSelect: (value) => {
      resetCycleSession();
      setPresetPrefixFilter(value || "__all__");
      refreshPresetOptions(presetSel.value || "");
      persistActivePreset();
    },
  });
  const presetSel  = createSearchableSelect({
    options: [{ name: "-- none --", value: "" }],
    placeholder: "-- none --",
    searchPlaceholder: "Search presets...",
    emptyText: "No presets found.",
    fixedMenu: true,
    menuWidth: 300,
    onSelect: () => onPresetSelected(),
  });
  // Status badge (Modified / Stale) is rebuilt from the shared local-status engine
  // into this slot; empty when clean. Replaces the old hand-built modified badge.
  const badgeSlot  = el("span", "wb-status-slot");
  prefixWrap.append(prefixSel.el);
  presetWrap.append(presetSel.el, badgeSlot);
  const prevBtn = el("button", "krc-icon-button wb-cycle"); prevBtn.type = "button";
  prevBtn.textContent = "▲"; prevBtn.title = "Previous preset";
  const nextBtn = el("button", "krc-icon-button wb-cycle"); nextBtn.type = "button";
  nextBtn.textContent = "▼"; nextBtn.title = "Next preset";
  presetRow.append(prefixWrap, presetWrap, prevBtn, nextBtn);

  // ── preset action buttons: New / Duplicate / Delete / Rename / Save (top) ──
  const presetActions = el("div", "wb-preset-actions");
  const newBtn    = el("button", "krc-action-button wb-preset-btn"); newBtn.textContent = "New";
  newBtn.title = "Clear rows for a new preset";
  const saveBtn   = el("button", "krc-action-button wb-preset-btn is-save"); saveBtn.textContent = "Save";
  saveBtn.title = "Save current rows as a preset";
  const renameBtn = el("button", "krc-action-button wb-preset-btn"); renameBtn.textContent = "Rename";
  renameBtn.title = "Rename selected preset";
  const dupBtn    = el("button", "krc-action-button wb-preset-btn"); dupBtn.textContent = "Duplicate";
  dupBtn.title = "Duplicate selected preset";
  const delBtn    = el("button", "krc-action-button wb-preset-btn is-delete"); delBtn.textContent = "Delete";
  delBtn.title = "Delete selected preset";
  presetActions.append(newBtn, dupBtn, delBtn, renameBtn, saveBtn);

  let presetCache = [];
  let cycleSession = null;
  // Identity of a selected preset that has vanished from the cache (deleted here
  // or by a sibling) while this node still holds its rows. Lets Missing surface
  // instead of the dropdown silently snapping to "-- none --". Cleared whenever a
  // real preset is (re)selected. See refreshPresetOptions.
  let missingPresetId = "";

  // The preset this node is bound to, whether or not it still has a dropdown
  // option: the live selection, or a since-deleted id we're holding as Missing.
  function effectiveActiveId() {
    return presetSel.value || missingPresetId || "";
  }

  function selectedPreset() {
    const id = effectiveActiveId();
    return id ? presetCache.find(x => presetId(x) === id) || null : null;
  }

  // Snapshot the selected preset's global state at load/save time (persisted into
  // node state, so it survives a workflow reload) — this is what lets a later
  // "the global preset moved elsewhere" (Stale) be told apart from a local row
  // edit (Modified). Cleared when nothing is selected.
  function captureBaseline() {
    const s = loadState(node);
    const p = selectedPreset();
    s.presetBaseline = p
      ? { id: presetId(p), modifiedAt: Number(p.modified) || 0, signature: sig(p.rows) }
      : null;
    saveState(node, s);
  }

  function activeBaseline() {
    const stored = loadState(node).presetBaseline;
    const id = effectiveActiveId();
    return stored && stored.id && stored.id === id ? stored : null;
  }

  function classifyPreset() {
    const id = effectiveActiveId();
    if (!id) return LOCAL_STATUS.CLEAN;
    const p = selectedPreset();
    const base = activeBaseline();
    const currentSignature = sig(rowsFromDOM());
    // No global preset for our active id => it was deleted out from under us; an
    // empty global signature reads as Missing while this node still holds rows.
    const globalSignature = p ? sig(p.rows) : "";
    return classifyLocalStatus({
      currentSignature,
      globalSignature,
      loadedGlobalSignature: base ? base.signature : "",
      currentGlobalModifiedAt: p ? Number(p.modified) || 0 : 0,
      loadedGlobalModifiedAt: base ? base.modifiedAt : 0,
      // Rows only diverge from the loaded baseline by a user edit; a preset moved
      // elsewhere leaves this node's rows equal to the old baseline.
      userTouched: base ? currentSignature !== base.signature : currentSignature !== globalSignature,
    });
  }

  // The Modified badge's hover-card rows: the rows against what this node loaded (the
  // baseline), else the saved preset. Bank names from the rows that carry them.
  function changeRows() {
    const p = selectedPreset();
    if (!p) return [];
    let saved = null;
    try {
      saved = JSON.parse(activeBaseline()?.signature || sig(p.rows));
    } catch { /* fall back to the saved preset */ }
    if (!Array.isArray(saved)) saved = JSON.parse(sig(p.rows));
    const rows = rowsFromDOM();
    const names = new Map();
    for (const row of [...(p.rows || []), ...rows]) {
      const id = String(row.categoryId || row.category || "");
      if (id && row.category) names.set(id, String(row.category));
    }
    return wordBankChangeRows(saved, JSON.parse(sig(rows)), (id) => names.get(id) || id);
  }

  function applySaveButton(status) {
    const copy = localStatusCopy(status, "preset");
    const label = copy.action.label;
    // Shared-copy labels are UPPERCASE; this button renders Title case.
    saveBtn.textContent = label.charAt(0) + label.slice(1).toLowerCase();
    const isStale = statusOverwrites(status);
    saveBtn.title = isStale ? copy.action.title : "Save current rows as a preset";
    saveBtn.classList.toggle("is-sync", isStale);
    saveBtn.classList.toggle("is-save", !isStale);
  }

  // Badge click discards local edits back to the global preset. Re-snapshots the
  // baseline too, so discarding a stale preset (which reloads the *new* global)
  // doesn't leave the old baseline behind and mis-read the next change as Modified.
  function discardToPreset() {
    // Missing: the global preset is gone, so there is nothing to reload back to —
    // discarding clears this node's orphaned copy to a blank slate instead.
    if (classifyPreset() === LOCAL_STATUS.MISSING) {
      clearActivePreset();
      return;
    }
    const p = selectedPreset();
    if (!p) return;
    applyPresetRows(p.rows);
    captureBaseline();
    updateModified();
  }

  // Drop this node's binding to a preset that no longer exists globally: clear the
  // orphaned rows, selection, and baseline so the panel returns to a clean slate.
  function clearActivePreset() {
    missingPresetId = "";
    rowsEl.innerHTML = "";
    const s = loadState(node); s.rows = []; saveState(node, s);
    resizeNode(node, 0);
    presetSel.value = "";
    refreshPresetOptions("");
    captureBaseline();
    refreshButtons();
    updateModified();
    persistActivePreset();
  }

  // Kept under the name row_controls + the action handlers already call; now drives
  // the shared Modified/Stale badge and the SAVE/SYNC button off the classifier.
  function updateModified() {
    const status = classifyPreset();
    badgeSlot.replaceChildren();
    if (status !== LOCAL_STATUS.CLEAN) {
      const badge = localStatusBadge({
        copy: localStatusCopy(status, "preset"),
        onDiscard: discardToPreset,
        // Conflict: Keep my changes = the Save button's save over the active preset.
        onKeep: () => saveBtn.click(),
        changes: changeRows,   // the hover card's list
      });
      if (badge) badgeSlot.append(badge);
    }
    applySaveButton(status);
  }

  function resetCycleSession() {
    if (cycleSession?.timer) clearTimeout(cycleSession.timer);
    cycleSession = null;
  }

  function cycleSessionPresets() {
    const now = Date.now();
    if (!cycleSession || now - cycleSession.lastAt > PRESET_CYCLE_SESSION_MS) {
      cycleSession = {
        presets: presetsForPrefix(presetCache, loadState(node).presetPrefixFilter),
        lastAt: now,
        timer: null,
      };
    }
    cycleSession.lastAt = now;
    if (cycleSession.timer) clearTimeout(cycleSession.timer);
    cycleSession.timer = setTimeout(() => { cycleSession = null; }, PRESET_CYCLE_SESSION_MS);
    return cycleSession.presets;
  }

  function refreshButtons() {
    const has = !!presetSel.value;
    renameBtn.disabled = dupBtn.disabled = delBtn.disabled = !has;
    prevBtn.disabled = nextBtn.disabled = presetsForPrefix(presetCache, loadState(node).presetPrefixFilter).length === 0;
  }

  function refreshPresetOptions(selectId) {
    const prefix = normalizePresetPrefixFilter(presetCache, loadState(node).presetPrefixFilter);
    setPresetPrefixFilter(prefix);
    prefixSel.setOptions(presetPrefixOptions(presetCache).map(([value, name]) => ({ value, name })), prefix);
    const options = presetOptionsForPrefix(presetCache, prefix);
    // Fall back to the placeholder when the requested name no longer exists,
    // matching the old native <select>.
    const value = options.some((option) => option.value === selectId) ? selectId : "";
    // A selection that vanished from the cache *entirely* (not merely filtered out
    // of the visible options by the active prefix) was deleted — here or by a
    // sibling. If this node had actually loaded it (a baseline for that id is on
    // record), hold the identity so Missing surfaces with the orphaned rows rather
    // than silently resetting to "-- none --".
    const existsInCache = !!selectId && presetCache.some((preset) => presetId(preset) === selectId);
    const storedBaseline = loadState(node).presetBaseline;
    const hadLoaded = !!storedBaseline && storedBaseline.id === selectId;
    missingPresetId = (!value && !existsInCache && hadLoaded) ? selectId : "";
    presetSel.setOptions(options, value);
    refreshButtons();
    updateModified();
  }

  async function reloadPresets(selectId) {
    const data = await fetchPresets();
    presetCache = Array.isArray(data?.presets) ? data.presets : [];
    resetCycleSession();
    if (node.__wbStats) node.__wbStats.presetCache = presetCache;
    refreshPresetOptions(selectId);
    persistActivePreset();
  }

  // After a local save/rename/duplicate/delete the active preset now equals what
  // was just written (or was cleared) — reload, then re-snapshot the baseline so
  // the panel reads clean, not falsely stale. (Plain reloadPresets, used on init
  // and sibling-change, deliberately keeps the old baseline so Stale can surface.)
  async function reloadAndRebaseline(selectId) {
    await reloadPresets(selectId);
    captureBaseline();
    updateModified();
  }

  // Presets are global; when another WordBank node writes, re-fetch so this
  // node's dropdown and modified badge don't go stale. (presetCache is
  // per-node here, so we re-fetch rather than adopt a shared cache.)
  function broadcastPresetsChanged(lane = KRC_SYNC_LANES.CONTENT, extra = {}) {
    publishKrcSync("krc-wordbank-presets-changed", {
      source: node?.id,
      lane,
      ...extra,
    });
  }

  // After a group action: a filter on that group follows it (new name, --none--, or All),
  // and the event's groupChange moves the siblings' filters too.
  async function applyGroupChange(change) {
    if (loadState(node).presetPrefixFilter === change.from) setPresetPrefixFilter(change.to);
    await reloadPresets(effectiveActiveId());
    broadcastPresetsChanged(KRC_SYNC_LANES.CONTENT, groupChangeDetail(change));
  }

  const unsubscribePresetsChanged = subscribeKrcSync("krc-wordbank-presets-changed", (event) => {
    if (isOwnSyncEvent(event, node?.id)) return;
    // A group renamed / ungrouped / deleted elsewhere: a filter on it follows.
    const filter = loadState(node).presetPrefixFilter;
    const followed = followGroupChange(filter, event);
    if (followed !== filter) setPresetPrefixFilter(followed);
    // Reload against the effective id (not the raw dropdown value) so a held-Missing
    // binding survives unrelated sibling churn instead of collapsing to "-- none --".
    // Then, clean but behind a newer save (Stale is only ever that state; an edit reads
    // Modified): load it, as clicking the Stale badge does. Live sync only — a workflow
    // reopened later keeps what it saved and shows Stale.
    reloadPresets(effectiveActiveId()).then(() => {
      if (classifyPreset() === LOCAL_STATUS.STALE) discardToPreset();
    });
  });
  const prevOnRemoved = node.onRemoved;
  node.onRemoved = function () {
    unsubscribePresetsChanged();
    return prevOnRemoved ? prevOnRemoved.apply(this, arguments) : undefined;
  };

  // Persist the selected preset id into node state so it survives reload.
  function persistActivePreset() {
    const s = loadState(node);
    const p = selectedPreset();
    // Persist the effective id (including a held-Missing id) so a deleted-preset
    // Missing state survives a workflow reload instead of silently clearing.
    s.activePresetId = effectiveActiveId();
    s.activePreset = p?.name || "";
    saveState(node, s);
  }

  function setPresetPrefixFilter(value) {
    const s = loadState(node);
    s.presetPrefixFilter = value || "__all__";
    saveState(node, s);
  }

  function applyPresetRows(rows) {
    rowsEl.innerHTML = "";
    for (const rd of (rows || [])) rowsEl.appendChild(makeRow(rd));
    reassignOcc();   // number preset rows (legacy presets lack occ) + refresh chips
    const s = loadState(node); s.rows = rowsFromDOM(); saveState(node, s);
    resizeNode(node, rowsEl.children.length);
    updateModified();
  }

  // ── selecting a preset auto-loads it (LS behaviour); the placeholder is a no-op ──
  function onPresetSelected() {
    resetCycleSession();
    const p = selectedPreset();
    if (p) {
      setPresetPrefixFilter(presetGroup(p));
      prefixSel.setValue(loadState(node).presetPrefixFilter);
      refreshPresetOptions(presetId(p));
      applyPresetRows(p.rows);
    }
    // Fresh load: this node's rows now equal the global preset — snapshot it.
    captureBaseline();
    refreshButtons();
    updateModified();
    persistActivePreset();
  }

  function cyclePreset(delta) {
    const scopedPresets = cycleSessionPresets();
    if (!scopedPresets.length) return;
    const idx = scopedPresets.findIndex(x => presetId(x) === presetSel.value);
    const nextIdx = idx < 0 ? (delta > 0 ? 0 : scopedPresets.length - 1)
                            : (idx + delta + scopedPresets.length) % scopedPresets.length;
    const next = scopedPresets[nextIdx];
    if (!next) return;
    presetSel.value = presetId(next);
    setPresetPrefixFilter(presetGroup(next));
    refreshPresetOptions(presetId(next));
    applyPresetRows(next.rows);
    captureBaseline();
    refreshButtons();
    updateModified();
    persistActivePreset();
  }
  prevBtn.addEventListener("click", () => cyclePreset(-1));
  nextBtn.addEventListener("click", () => cyclePreset(1));

  // (The status badge's discard is wired through localStatusBadge's onDiscard.)

  // ── preset action buttons ──
  newBtn.addEventListener("click", () => {
    rowsEl.innerHTML = "";
    const s = loadState(node); s.rows = []; saveState(node, s);
    resizeNode(node, 0);
    presetSel.value = "";
    refreshPresetOptions("");
    captureBaseline();
    refreshButtons();
    updateModified();
    persistActivePreset();
  });
  saveBtn.addEventListener("click", async () => {
    // Prompt for a name only when creating a brand-new preset (none active);
    // saving over the active preset is silent. Rename has its own prompt.
    const active = selectedPreset();
    const activeId = presetSel.value || "";
    let group;
    let name;
    if (active) {
      group = presetGroup(active);
      name = active.name;
    } else {
      const result = await openPresetNameDialog({
        node,
        title: "Save preset",
        presets: presetCache,
        group: normalizePresetPrefixFilter(presetCache, loadState(node).presetPrefixFilter),
        confirmTitle: "Save preset",
      });
      if (!result) return;
      ({ group, name } = result);
    }
    // A typed group+name that collides with a *different* existing preset would
    // overwrite it; confirm first. (Silent save over the active preset is
    // the intended overwrite.)
    if (!activeId && presetCache.some(x => presetGroup(x) === canonicalGroup(group) && x.name === name)) {
      const overwrite = await openKrcConfirm({
        node,
        title: "Overwrite preset",
        message: `A preset named "${name}" already exists in this group. Overwrite it?`,
        confirmLabel: "Overwrite",
        danger: true,
      });
      if (!overwrite) return;
    }
    const saved = await savePreset(group, name, rowsFromDOM(), activeId);
    if (!saved) { krcAlert("Could not save preset.", node); return; }
    setPresetPrefixFilter(presetGroup(saved));
    await reloadAndRebaseline(presetId(saved));
    broadcastPresetsChanged();
  });
  renameBtn.addEventListener("click", async () => {
    const p = selectedPreset();
    if (!p) return;
    const currentGroup = presetGroup(p);
    const result = await openPresetNameDialog({
      node,
      title: "Rename preset",
      presets: presetCache,
      group: currentGroup,
      name: p.name,
      confirmTitle: "Rename preset",
      validateName: ({ group, name }) => (
        presetCache.some(x => presetId(x) !== presetId(p) && presetGroup(x) === group && x.name === name)
          ? "A preset with that group + name already exists." : ""
      ),
    });
    if (!result) return;
    const { group, name } = result;
    if (canonicalGroup(group) === currentGroup && name === p.name) return;
    const renamed = await renamePreset(presetId(p), group, name);
    if (!renamed?.ok) { krcAlert("Could not rename preset (the group + name may be taken).", node); return; }
    setPresetPrefixFilter(canonicalGroup(group));
    await reloadAndRebaseline(presetId(p));
    broadcastPresetsChanged(KRC_SYNC_LANES.STRUCTURE);
  });
  dupBtn.addEventListener("click", async () => {
    const p = selectedPreset();
    if (!p) return;
    const group = presetGroup(p);
    const base = p.name.replace(/\(copy\d*\)$/i, "");
    let name = `${base}(copy)`, counter = 2;
    while (presetCache.some(x => presetGroup(x) === group && x.name === name)) { name = `${base}(copy${counter})`; counter += 1; }
    const saved = await savePreset(group, name, p.rows);
    if (!saved) { krcAlert("Could not duplicate preset.", node); return; }
    setPresetPrefixFilter(presetGroup(saved));
    await reloadAndRebaseline(presetId(saved));
    broadcastPresetsChanged(KRC_SYNC_LANES.STRUCTURE);
  });
  armConfirmButton(delBtn, {
    restoreText: "Delete",
    shouldArm: () => !!presetSel.value,
    onConfirm: async () => {
      const id = presetSel.value;
      if (!id) return;
      await deletePreset(id);
      await reloadAndRebaseline("");
      broadcastPresetsChanged(KRC_SYNC_LANES.STRUCTURE);
    },
  });

  return {
    presetRow,
    presetActions,
    reloadPresets,
    broadcastPresetsChanged,
    updateModified,
    value: () => presetSel.value || "",
  };
}
