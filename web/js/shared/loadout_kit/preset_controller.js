// Loadout Kit presets: the active preset (id-primary), cycling, the trigger echo,
// Modified / Stale / live adopt, save / duplicate / rename / delete. RefMod Loadout's
// controller made generic (kit routes + event, fields from the descriptor).
import { localStatusBadge } from "../badges.js";
import { classifyLocalStatus, localStatusCopy, LOCAL_STATUS, statusOverwrites, stableSignature } from "../local_status.js";
import { KRC_SYNC_LANES, publishKrcSync } from "../sync_bus.js";
import { openPresetNameDialog } from "../preset_name_dialog.js";
import { groupChangeDetail, presetGroupMenu as buildPresetGroupMenu } from "../preset_group_actions.js";
import {
  NONE_PRESET_GROUP,
  canonicalGroup,
  normalizePresetPrefixFilter,
  presetDisplayName as sharedPresetDisplayName,
  presetGroup as sharedPresetGroup,
  presetGroupLabel as sharedPresetGroupLabel,
  presetPrefixOptions as sharedPresetPrefixOptions,
  presetsForPrefix as sharedPresetsForPrefix,
} from "../preset_naming.js";
import { PRESETS_CHANGED_EVENT, PROP_PRESET_BASELINE, STACK_ID } from "./constants.js";
import { entryFieldValues } from "./fields.js";
import { parseJsonArray } from "./util.js";
import { krcAlert, openKrcConfirm } from "../modal.js";
import { adoptCardSnapshots, presetEntryCard } from "../card_snapshots.js";
import { app } from "../../../../scripts/app.js";
import { PRESET_LINK_STATE, presetLinkDrives, presetLinkState, presetLinkWant, replacePresetLinkIndicator } from "../preset_link_ui.js";
import { showToast } from "../toast.js";

const PRESET_CYCLE_SESSION_MS = 2500;

// Labels that would shadow the virtual --empty-- / --unsaved-- pseudo-presets.
// Mirrors is_reserved_preset_name in utils/loadout_kit/presets.py.
const RESERVED_PRESET_LABELS = new Set(["--empty--", "--unsaved--"]);
function isReservedPresetName(group, label) {
  const normalized = String(label || "").trim().toLowerCase();
  if (canonicalGroup(group) === NONE_PRESET_GROUP && normalized === "empty") return true;
  return RESERVED_PRESET_LABELS.has(normalized);
}
const RESERVED_NAME_MESSAGE = "That name is reserved for the blank slate (--empty--).";

export function uiValue(message, name) {
  const value = message?.[name] ?? message?.ui?.[name];
  if (Array.isArray(value)) return value[0] ?? "";
  return value ?? "";
}

export const presetMethods = {
  // active_preset holds the preset's stable *id* (id-primary).
  activePresetId() {
    return this.getWidget("active_preset") || "";
  },

  activePreset() {
    const id = this.activePresetId();
    return id ? (this.presets || []).find((item) => item?.id === id) || null : null;
  },

  // True when the stack holds no card. Syncs live widget state first so a just-dragged
  // entry counts before the panel re-renders.
  stacksAreEmpty() {
    this.syncStackFromState(STACK_ID);
    return (this.stacks[STACK_ID]?.length || 0) === 0;
  },

  // A real preset, or a pure display split of "no preset" into empty vs unsaved.
  presetSelectionState() {
    const preset = this.activePreset();
    if (preset) return { kind: "preset", preset };
    return this.stacksAreEmpty() ? { kind: "empty", preset: null } : { kind: "unsaved", preset: null };
  },

  async handlePresetAction(id, { resetCycleSession = true } = {}) {
    this.pauseAutoForManualPick();
    if (resetCycleSession) this.resetPresetCycleSession();
    this.setWidget("active_preset", id);
    if (id) {
      const preset = (this.presets || []).find((item) => item?.id === id);
      this.setWidget("preset_prefix_filter", this.presetGroup(preset));
    }
    await this.loadActivePreset();
  },

  cyclePreset(delta) {
    const presets = this.presetCycleSessionPresets();
    if (!presets.length) return;
    const current = this.activePresetId();
    const index = presets.findIndex((item) => item.id === current);
    const nextIndex = index < 0
      ? (delta > 0 ? 0 : presets.length - 1)
      : (index + delta + presets.length) % presets.length;
    const next = presets[nextIndex];
    if (next) this.handlePresetAction(next.id, { resetCycleSession: false });
  },

  resetPresetCycleSession() {
    if (this._presetCycleSession?.timer) clearTimeout(this._presetCycleSession.timer);
    this._presetCycleSession = null;
  },

  presetCycleSessionPresets() {
    const now = Date.now();
    if (!this._presetCycleSession || now - this._presetCycleSession.lastAt > PRESET_CYCLE_SESSION_MS) {
      this._presetCycleSession = {
        presets: this.presetsForPrefix(this.currentPresetPrefixFilter()),
        lastAt: now,
        timer: null,
      };
    }
    this._presetCycleSession.lastAt = now;
    if (this._presetCycleSession.timer) clearTimeout(this._presetCycleSession.timer);
    this._presetCycleSession.timer = setTimeout(() => {
      this._presetCycleSession = null;
    }, PRESET_CYCLE_SESSION_MS);
    return this._presetCycleSession.presets;
  },

  async loadActivePreset() {
    await this.loadPresetById(this.activePresetId());
  },

  async loadPresetById(id) {
    // Switching presets invalidates the last run's missing-card warning.
    this.missingLoras = [];
    const preset = id ? this.presets.find((item) => item.id === id) : null;
    if (preset) {
      this.setWidget("active_preset", preset.id);
      this.setWidget("preset_prefix_filter", this.presetGroup(preset));
      const entries = this.presetStack(preset);
      adoptCardSnapshots(this.node, entries);
      // The card snapshot stays in node properties, not the stack widget (a run input).
      this.stacks[STACK_ID] = entries.map(({ card, ...entry }) => entry);
      this.sortStack(STACK_ID);
      this.persistStack(STACK_ID);
      // Fresh load: the stack now equals the global preset — snapshot it as the baseline
      // so later divergence is correctly Modified vs Stale.
      this.captureActivePresetBaseline();
    }
    this.refreshStacks();
  },

  presetGroup(preset) {
    return sharedPresetGroup(preset);
  },

  presetGroupLabel(preset) {
    return sharedPresetGroupLabel(preset);
  },

  presetDisplayName(preset) {
    return sharedPresetDisplayName(preset);
  },

  currentPresetPrefixFilter() {
    return normalizePresetPrefixFilter(this.presets, this.getWidget("preset_prefix_filter"));
  },

  presetPrefixOptions() {
    return sharedPresetPrefixOptions(this.presets);
  },

  presetsForPrefix(prefix = "__all__") {
    return sharedPresetsForPrefix(this.presets, prefix);
  },

  // Default GROUP for the save/rename dialog: the active group filter, else the active
  // preset's group, else none.
  presetNamePromptDefault() {
    const prefix = this.currentPresetPrefixFilter();
    if (prefix && prefix !== "__all__") return prefix;
    const active = this.activePreset();
    return active ? this.presetGroup(active) : NONE_PRESET_GROUP;
  },

  // ── Preset link indicator (PRESET_LINK_GAMEPLAN.md step 5) ─────────────────
  // The chain glyph after "Preset": which Prompt Vault drives this node and how.
  presetLinkInfo() {
    return presetLinkState({
      node: this.node,
      kind: this.kit.id,
      root: app.graph,
      presets: this.presets,
      auto: Boolean(this.getWidget("auto_preset_link")),
      missingId: this.presetLinkMissingId || "",
    });
  },

  // The glyph alone when the row's shape stays; the whole row when the Auto switch has to
  // appear or go (a Prompt Vault wired or unwired).
  refreshPresetLink() {
    const info = this.presetLinkInfo();
    if ((info.state !== PRESET_LINK_STATE.NONE) !== Boolean(this._presetLinkShown)) {
      this.refreshPresetPanel();
      return;
    }
    replacePresetLinkIndicator(this.root, info);
  },

  // Each run says whether the linked id was missing; a run without the key clears it.
  applyPresetLinkUi(message) {
    let missingId = "";
    try {
      missingId = String(JSON.parse(uiValue(message, "krc_preset_link_missing") || "{}")?.id || "");
    } catch {
      missingId = "";
    }
    if (missingId === (this.presetLinkMissingId || "")) return;
    this.presetLinkMissingId = missingId;
    this.refreshPresetLink();
  },

  // ── Live preview (PRESET_LINK_GAMEPLAN.md step 6) ──────────────────────────
  // Load what the link asks for now, by the run's rule, so the canvas shows what will
  // run. Prompt Vault calls this when its link changes; also on Auto on and on wiring.
  syncFromPresetLink() {
    const want = presetLinkWant(this.presetLinkInfo(), this.activePresetId(), this.presets);
    if (want === null) {
      this.refreshPresetLink();
      return false;
    }
    if (want === "") this.newPreset();
    else this.loadPresetById(want);
    return true;
  },

  // A pick by hand on a node the link drives pauses Auto (open decision O1), so the
  // next run or preview doesn't silently undo it. The toast's Resume turns it back on.
  pauseAutoForManualPick() {
    if (!presetLinkDrives(this.presetLinkInfo())) return;
    this.setWidget("auto_preset_link", false);
    showToast("Auto paused: you picked a preset by hand.", {
      duration: 5000,
      action: { label: "Resume", onClick: () => this.resumeAutoPresetLink() },
    });
  },

  resumeAutoPresetLink() {
    this.setWidget("auto_preset_link", true);
    if (!this.syncFromPresetLink()) this.refreshPresetPanel();
  },

  // The --empty-- pick and the menu's New: a manual pick too.
  pickEmptyPreset() {
    this.pauseAutoForManualPick();
    this.newPreset();
  },

  applyTriggeredPresetUi(message) {
    // The node echoes the preset link's id here when the run loaded it. Display only:
    // the run already used the preset, and the next run decides from its own inputs.
    const presetId = uiValue(message, "krc_triggered_preset");
    // Virtual --empty--: the node cleared the stack; newPreset() is exactly that reset.
    if (uiValue(message, "krc_triggered_empty")) {
      this.newPreset();
      return;
    }
    if (!presetId) return;
    if (presetId === this.activePresetId() && this.isActivePresetModified()) return;

    const preset = (this.presets || []).find((item) => item?.id === presetId);
    this.setWidget("active_preset", presetId);
    this.setWidget("preset_prefix_filter", this.presetGroup(preset));
    const stack = uiValue(message, "krc_loadout_stack");
    if (stack) {
      // Card snapshots go to node properties; the stack widget (a run input) keeps ids.
      const entries = this.presetStack({ stack: parseJsonArray(stack, []) });
      adoptCardSnapshots(this.node, entries);
      this.stacks[STACK_ID] = entries.map(({ card, ...entry }) => entry);
      this.sortStack(STACK_ID);
      this.persistStack(STACK_ID);
    }
    // A trigger loads the preset's saved stack, so the node now matches the global.
    this.captureActivePresetBaseline();
    this.refreshStacks();
  },

  applyMissingUi(message) {
    const raw = uiValue(message, "krc_loadout_missing");
    const missing = raw ? parseJsonArray(raw, []) : [];
    const next = Array.isArray(missing) ? missing : [];
    // Only re-render when the missing set changes, so a clean run quietly clears it.
    const changed = JSON.stringify(next) !== JSON.stringify(this.missingLoras || []);
    this.missingLoras = next;
    if (changed) this.refreshPresetPanel();
  },

  // A preset record's stack as panel entries (stored entries key the card by `id`).
  presetStack(preset) {
    return (Array.isArray(preset?.stack) ? preset.stack : []).map((entry) => {
      const id = entry?.id || entry?.sha256 || "";
      return id ? { ...entry, sha256: id } : entry;
    });
  },

  presetPayloadStack(entries = this.stacks[STACK_ID]) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.sha256)
      .map((entry) => ({
        id: String(entry.sha256 || ""),
        order: Number(entry.order),
        enabled: entry.enabled !== false,
        ...entryFieldValues(this.kit.fields, entry),
        // Display only (shared/card_snapshots.js): never part of the preset signature.
        ...presetEntryCard(this.node, String(entry.sha256 || "")),
      }));
  },

  normalizedPresetStack(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => (entry?.sha256 || entry?.id) && Number.isInteger(Number(entry.order)))
      .map((entry) => ({
        sha256: String(entry.sha256 || entry.id || ""),
        order: Math.max(0, Math.min(this.kit.slots - 1, Number(entry.order))),
        enabled: entry.enabled !== false,
        ...entryFieldValues(this.kit.fields, entry),
      }))
      .sort((a, b) => a.order - b.order);
  },

  // Signature of the stack currently in the node (syncs live widget state first).
  currentPresetSignature() {
    this.syncStackFromState(STACK_ID);
    return stableSignature(this.normalizedPresetStack(this.stacks[STACK_ID]));
  },

  // Signature of a preset's SAVED stack (the global version).
  savedPresetSignature(preset) {
    return stableSignature(this.normalizedPresetStack(this.presetStack(preset)));
  },

  // Snapshot the active preset's global state when the node loads it, so "the global
  // moved" can be told from "the user edited here". Persisted in node properties so
  // Stale survives a workflow reload.
  captureActivePresetBaseline() {
    this.node.properties = this.node.properties || {};
    const preset = this.activePreset();
    if (!preset) {
      this._presetBaseline = null;
      delete this.node.properties[PROP_PRESET_BASELINE];
      return;
    }
    const baseline = {
      id: preset.id,
      modifiedAt: Number(preset.modified) || 0,
      signature: this.savedPresetSignature(preset),
    };
    this._presetBaseline = baseline;
    this.node.properties[PROP_PRESET_BASELINE] = baseline;
  },

  // Re-adopt the persisted baseline for the active preset after a (re)load; drop it if
  // it belongs to a different preset. Absent baseline => no Stale, only Modified.
  restoreActivePresetBaseline() {
    const stored = this.node?.properties?.[PROP_PRESET_BASELINE];
    const activeId = this.activePresetId();
    this._presetBaseline = stored && stored.id && stored.id === activeId ? stored : null;
  },

  classifyActivePreset() {
    const preset = this.activePreset();
    if (!preset) return LOCAL_STATUS.CLEAN;
    const currentSignature = this.currentPresetSignature();
    const globalSignature = this.savedPresetSignature(preset);
    const baseline = this._presetBaseline && this._presetBaseline.id === preset.id ? this._presetBaseline : null;
    const baselineSignature = baseline ? this.canonicalBaselineSignature(baseline.signature) : "";
    return classifyLocalStatus({
      currentSignature,
      globalSignature,
      loadedGlobalSignature: baselineSignature,
      currentGlobalModifiedAt: Number(preset.modified) || 0,
      loadedGlobalModifiedAt: baseline ? baseline.modifiedAt : 0,
      // The stack only diverges from the loaded baseline by a user edit; a moved
      // global would leave the node's copy equal to the old baseline.
      userTouched: baseline ? currentSignature !== baselineSignature : currentSignature !== globalSignature,
    });
  },

  // The baseline signature with its ids remapped to the current ones: a card stabilized
  // since this node loaded the preset keeps its old id there, while the node and the
  // server already use the new one, so a stabilization never reads as a change
  // (Modified, Stale or Conflict).
  canonicalBaselineSignature(signature) {
    if (!signature) return "";
    try {
      const remap = (entry) => (entry && typeof entry === "object" && entry.sha256
        ? { ...entry, sha256: this.canonicalId?.(entry.sha256) || entry.sha256 }
        : entry);
      const parsed = JSON.parse(signature);
      return stableSignature(Array.isArray(parsed) ? parsed.map(remap) : parsed);
    } catch {
      return signature;
    }
  },

  isActivePresetModified() {
    return this.classifyActivePreset() !== LOCAL_STATUS.CLEAN;
  },

  renderPresetStatusBadge() {
    const state = this.presetSelectionState();
    // --unsaved--: cards present that belong to no preset (Draft visual).
    if (state.kind === "unsaved") {
      return localStatusBadge({
        copy: { badge: { label: "Unsaved", badgeClass: "is-draft", title: `These ${this.kit.nounPlural} aren’t saved to any preset.` } },
        className: "krc-preset-modified-badge",
      });
    }
    if (state.kind === "empty") return null; // a clean blank needs no badge
    const status = this.classifyActivePreset();
    if (status === LOCAL_STATUS.CLEAN) return null;
    return localStatusBadge({
      copy: localStatusCopy(status, "preset"),
      className: "krc-preset-modified-badge",
      onDiscard: () => this.discardActivePresetChanges(),
      // Conflict: Keep my changes = save this node's stacks over the newer saved preset.
      onKeep: () => this.savePreset(),
    });
  },

  // Only Stale changes the SAVE button (to OVERWRITE); the same save path runs either way.
  applyPresetSaveButton(button) {
    if (!button) return;
    const status = this.classifyActivePreset();
    if (statusOverwrites(status)) {
      const copy = localStatusCopy(status, "preset");
      button.textContent = copy.action.label.toLowerCase();
      button.title = copy.action.title;
      button.classList.add("is-sync");
    } else {
      button.textContent = "save";
      button.title = "Save the stack as a preset";
      button.classList.remove("is-sync");
    }
  },

  // A newer version of the active preset was saved elsewhere and this node has no
  // unsaved edit (Stale is only ever that state; an edit reads Modified): load it, as
  // clicking the Stale badge does. Live sync only — a reopened workflow shows Stale.
  async adoptNewerActivePreset() {
    if (this.classifyActivePreset() !== LOCAL_STATUS.STALE) return false;
    await this.discardActivePresetChanges();
    this.refreshPresetPanel?.();
    return true;
  },

  async discardActivePresetChanges() {
    const id = this.activePresetId();
    if (!id) return;
    await this.loadPresetById(id);
  },

  async loadPresets({ broadcast = false } = {}) {
    try {
      const { ok, data: presets } = await this.kit.api.getSharedJson("/presets");
      if (!ok) return;
      if (!presets || typeof presets !== "object") throw new Error("Invalid presets payload");
      this.presets = Array.isArray(presets.presets) ? presets.presets : [];
      this.kit.presetCache = this.presets;
      this.restoreActivePresetBaseline();
      this.refreshPresetPanel();
      if (broadcast) this.broadcastPresetsChanged?.();
    } catch {
      // A transient failure must not wipe the known presets (dirty-badge detection).
      this.presets = this.kit.presetCache || [];
    }
  },

  async savePreset() {
    this.syncStackFromState(STACK_ID);
    const active = this.activePreset();
    // Saving over the active preset is silent; creating a new preset prompts.
    const silent = Boolean(active);
    let group;
    let name;
    if (silent) {
      group = this.presetGroup(active);
      name = active.name;
    } else {
      const result = await openPresetNameDialog({
        node: this.node,
        title: "Save preset",
        presets: this.presets,
        group: this.presetNamePromptDefault(),
        confirmTitle: "Save preset",
        validateName: ({ group: g, name: n }) => (isReservedPresetName(g, n) ? RESERVED_NAME_MESSAGE : ""),
      });
      if (!result) {
        this.refreshPresetPanel();
        return "";
      }
      ({ group, name } = result);
    }
    let presetId = active?.id || "";
    // A typed group+name that collides with a *different* preset: offer to overwrite it.
    if (!silent) {
      const dup = this.presets.find((item) => item.id !== presetId
        && this.presetGroup(item) === canonicalGroup(group) && item.name === name);
      if (dup) {
        if (!(await openKrcConfirm({
          node: this.node,
          title: "Overwrite preset",
          message: `A preset named "${name}" already exists in this group. Overwrite it?`,
          confirmLabel: "Overwrite",
          danger: true,
        }))) {
          this.refreshPresetPanel();
          return "";
        }
        presetId = dup.id;
      }
    }
    const saved = await this.postPreset({ id: presetId, group, name, stack: this.presetPayloadStack() });
    if (!saved || !saved.id) {
      this.refreshPresetPanel();
      return "";
    }
    this.setWidget("active_preset", saved.id);
    this.setWidget("preset_prefix_filter", this.presetGroup(saved));
    await this.loadPresets();
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
    return saved.id;
  },

  broadcastPresetsChanged(extra = {}) {
    // Sibling panels of this kit adopt the kit's preset cache on this event.
    publishKrcSync(PRESETS_CHANGED_EVENT, {
      source: this.node?.id,
      kit: this.kit.id,
      lane: KRC_SYNC_LANES.CONTENT,
      ...extra,
    });
  },

  // The group picker's "⋯" menu: Rename / Ungroup / Delete group.
  presetGroupMenu() {
    return buildPresetGroupMenu({
      node: this.node,
      presets: () => this.presets,
      base: this.kit.api.loraPath("/presets"),
      onDone: (change) => this.applyPresetGroupChange(change),
    });
  },

  // After a group action: a filter on that group follows it (new name, --none--, or All),
  // and the event's groupChange moves the siblings' filters too.
  async applyPresetGroupChange(change) {
    this.resetPresetCycleSession();
    if (this.getWidget("preset_prefix_filter") === change.from) this.setWidget("preset_prefix_filter", change.to);
    await this.loadPresets();
    this.broadcastPresetsChanged(groupChangeDetail(change));
  },

  async postPreset(body) {
    // Returns the saved record (with its canonical id), or null on failure.
    let response;
    try {
      response = await this.kit.api.postLoraJson("/presets", body);
    } catch {
      krcAlert("Could not save preset (network error).", this.node);
      return null;
    }
    if (!response.ok) {
      krcAlert(`Could not save preset (HTTP ${response.status}).`, this.node);
      return null;
    }
    try {
      return await response.json();
    } catch {
      return null;
    }
  },

  newPreset() {
    this.missingLoras = [];
    this.stacks[STACK_ID] = [];
    this.persistStack(STACK_ID);
    this.setWidget("active_preset", "");
    this.setWidget("preset_prefix_filter", "__all__");
    this.captureActivePresetBaseline();
    this.refreshStacks();
  },

  async duplicatePreset() {
    const preset = this.activePreset();
    if (!preset) {
      this.refreshPresetPanel();
      return;
    }
    const group = this.presetGroup(preset);
    const base = preset.name.replace(/\(copy\d*\)$/i, "");
    let name = `${base}(copy)`;
    let counter = 2;
    while (this.presets.some((item) => this.presetGroup(item) === group && item.name === name)) {
      name = `${base}(copy${counter})`;
      counter += 1;
    }
    // id "" mints a fresh preset — a duplicate is a distinct identity.
    const saved = await this.postPreset({ id: "", group, name, stack: this.presetPayloadStack(this.presetStack(preset)) });
    if (!saved || !saved.id) {
      this.refreshPresetPanel();
      return;
    }
    this.setWidget("active_preset", saved.id);
    this.setWidget("preset_prefix_filter", this.presetGroup(saved));
    await this.loadPresets();
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
  },

  async renamePreset() {
    const preset = this.activePreset();
    if (!preset) {
      this.refreshPresetPanel();
      return;
    }
    const currentGroup = this.presetGroup(preset);
    const currentName = preset.name;
    const result = await openPresetNameDialog({
      node: this.node,
      title: "Rename preset",
      presets: this.presets,
      group: currentGroup,
      name: currentName,
      confirmTitle: "Rename preset",
      validateName: ({ group, name }) => {
        if (isReservedPresetName(group, name)) return RESERVED_NAME_MESSAGE;
        return this.presets.some((item) => item.id !== preset.id && this.presetGroup(item) === group && item.name === name)
          ? "A preset with that group + name already exists." : "";
      },
    });
    if (!result) {
      this.refreshPresetPanel();
      return;
    }
    const { group, name } = result;
    if (canonicalGroup(group) === currentGroup && name === currentName) {
      this.refreshPresetPanel();
      return;
    }
    this.syncStackFromState(STACK_ID);
    // Atomic server-side rename addressed by id: the id is untouched.
    let response;
    try {
      response = await this.kit.api.postLoraJson("/presets/rename", {
        id: preset.id,
        group,
        name,
        stack: this.presetPayloadStack(),
      });
    } catch {
      krcAlert("Could not rename preset (network error).", this.node);
      this.refreshPresetPanel();
      return;
    }
    if (!response.ok) {
      krcAlert(`Could not rename preset (HTTP ${response.status}).`, this.node);
      this.refreshPresetPanel();
      return;
    }
    this.setWidget("active_preset", preset.id);
    this.setWidget("preset_prefix_filter", canonicalGroup(group));
    await this.loadPresets();
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
  },

  async deletePreset(id = "", rerender = true) {
    const presetId = id || this.activePresetId();
    if (!presetId) {
      if (rerender) this.refreshPresetPanel();
      return;
    }
    await this.kit.api.deleteLoraJson("/presets", { id: presetId });
    if (!id) this.setWidget("active_preset", "");
    await this.loadPresets();
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
  },
};
