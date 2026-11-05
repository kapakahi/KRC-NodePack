import { deleteLoraJson, loraPath, postLoraJson } from "./api.js";
import { groupChangeDetail, presetGroupMenu as buildPresetGroupMenu } from "../shared/preset_group_actions.js";
import { localStatusBadge } from "../shared/badges.js";
import { classifyLocalStatus, localStatusCopy, stableSignature, LOCAL_STATUS, statusOverwrites } from "../shared/local_status.js";
import { KRC_SYNC_LANES, publishKrcSync } from "../shared/sync_bus.js";
import { openPresetNameDialog } from "../shared/preset_name_dialog.js";
import {
  NONE_PRESET_GROUP,
  canonicalGroup,
  normalizePresetPrefixFilter,
  presetDisplayName as sharedPresetDisplayName,
  presetGroup as sharedPresetGroup,
  presetGroupLabel as sharedPresetGroupLabel,
  presetPrefixOptions as sharedPresetPrefixOptions,
  presetsForPrefix as sharedPresetsForPrefix,
} from "../shared/preset_naming.js";
import { app } from "../../../scripts/app.js";
import { setWidgetValue, widgetValue } from "./helpers.js";
import { LORA_LOADOUT_KIND } from "../shared/loadout_presets.js";
import { PRESET_LINK_STATE, presetLinkDrives, presetLinkState, presetLinkWant, replacePresetLinkIndicator } from "../shared/preset_link_ui.js";
import { showToast } from "../shared/toast.js";
import { parseJsonArray, uiValue } from "./pure_helpers.js";
import { krcAlert, openKrcConfirm } from "../shared/modal.js";
import { adoptCardSnapshots, presetEntryCard } from "../shared/card_snapshots.js";
import { stackChangeRows, stackEntryName } from "../shared/stack_changes.js";

const PRESET_CYCLE_SESSION_MS = 2500;

// Labels that would shadow the virtual --empty-- / --unsaved-- pseudo-presets (LL only).
// Mirrors is_reserved_preset_name in utils/lora_loadout/presets.py.
const RESERVED_PRESET_LABELS = new Set(["--empty--", "--unsaved--"]);
function isReservedLoraPresetName(group, label) {
  const normalized = String(label || "").trim().toLowerCase();
  if (canonicalGroup(group) === NONE_PRESET_GROUP && normalized === "empty") {
    return true;
  }
  return RESERVED_PRESET_LABELS.has(normalized);
}
const RESERVED_NAME_MESSAGE = "That name is reserved for the blank slate (--empty--).";

export const presetMethods = {
  // active_preset holds the preset's stable *id* (id-primary). The preset name
  // stores the user-facing group as "group:label"; the no-group token is "none".
  activePresetId() {
    return widgetValue(this.node, "active_preset") || "";
  },

  activePreset() {
    const id = this.activePresetId();
    return id ? (this.presets || []).find((item) => item?.id === id) || null : null;
  },

  activePresetName() {
    return this.activePreset()?.name || "";
  },

  // True when neither stack holds a LoRA. Syncs live widget state first (like
  // currentPresetSignature) so a just-dragged entry counts before the panel re-renders.
  stacksAreEmpty() {
    this.syncStackFromState("A");
    this.syncStackFromState("B");
    return (this.stacks.A?.length || 0) + (this.stacks.B?.length || 0) === 0;
  },

  // The one selector every "-- none --" display decision routes through. `active_preset`
  // stays the sole "no real preset" value ("" or an unresolvable id); the two virtual
  // pseudo-presets are a pure display split over that state by stack-emptiness — nothing
  // is stored. "preset" is exactly today's real-preset case.
  presetSelectionState() {
    const preset = this.activePreset();
    if (preset) {
      return { kind: "preset", preset };
    }
    return this.stacksAreEmpty()
      ? { kind: "empty", preset: null }
      : { kind: "unsaved", preset: null };
  },

  async handlePresetAction(id, { resetCycleSession = true } = {}) {
    this.pauseAutoForManualPick();
    if (resetCycleSession) {
      this.resetPresetCycleSession();
    }
    setWidgetValue(this.node, "active_preset", id);
    if (id) {
      const preset = (this.presets || []).find((item) => item?.id === id);
      setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(preset));
    }
    await this.loadActivePreset();
  },

  cyclePreset(delta) {
    const presets = this.presetCycleSessionPresets();
    if (!presets.length) {
      return;
    }
    const current = this.activePresetId();
    const index = presets.findIndex((item) => item.id === current);
    const nextIndex = index < 0
      ? (delta > 0 ? 0 : presets.length - 1)
      : (index + delta + presets.length) % presets.length;
    const next = presets[nextIndex];
    if (next) {
      this.handlePresetAction(next.id, { resetCycleSession: false });
    }
  },

  resetPresetCycleSession() {
    if (this._presetCycleSession?.timer) {
      clearTimeout(this._presetCycleSession.timer);
    }
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
    if (this._presetCycleSession.timer) {
      clearTimeout(this._presetCycleSession.timer);
    }
    this._presetCycleSession.timer = setTimeout(() => {
      this._presetCycleSession = null;
    }, PRESET_CYCLE_SESSION_MS);
    return this._presetCycleSession.presets;
  },

  reconcileActivePresetId() {
    // Node migration: a workflow saved before id-primary stored the preset *name*
    // in active_preset. If the current value is not a known id but matches a
    // preset name, rewrite it to that preset's id so the pointer survives renames
    // from here on. Kept permanently — old workflow JSON can be opened at any time.
    const current = this.activePresetId();
    if (!current) {
      return;
    }
    const presets = this.presets || [];
    if (presets.some((item) => item.id === current)) {
      return;
    }
    const byName = presets.find((item) => item.name === current);
    if (byName) {
      setWidgetValue(this.node, "active_preset", byName.id);
      setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(byName));
    }
  },

  async loadActivePreset() {
    await this.loadPresetById(this.activePresetId());
  },

  async loadPresetById(id) {
    // Switching presets invalidates the last run's missing-LoRA warning.
    this.missingLoras = [];
    const preset = id ? this.presets.find((item) => item.id === id) : null;
    if (preset) {
      setWidgetValue(this.node, "active_preset", preset.id);
      setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(preset));
      const stacks = this.presetStacks(preset);
      adoptCardSnapshots(this.node, [...stacks.A, ...stacks.B]);
      // The card snapshot stays in node properties, not the stack widget (a run input).
      this.stacks.A = stacks.A.map(({ card, ...entry }) => entry);
      this.stacks.B = stacks.B.map(({ card, ...entry }) => entry);
      this.sortStack("A");
      this.sortStack("B");
      this.persistStack("A");
      this.persistStack("B");
      this.applyPresetStackEnabled(preset);
      // Fresh load: the node's stacks now equal the global preset — snapshot it as
      // the baseline so subsequent divergence is correctly Modified vs Stale.
      this.captureActivePresetBaseline();
    }
    this.refreshStacks();
  },

  // Naming helpers now read a preset RECORD's stored `.group` / label `.name`
  // (shared single source in ../shared/preset_naming.js) — no more parsing a
  // combined "group:label" string.
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
    return normalizePresetPrefixFilter(this.presets, widgetValue(this.node, "preset_prefix_filter"));
  },

  presetPrefixOptions() {
    return sharedPresetPrefixOptions(this.presets);
  },

  presetsForPrefix(prefix = "__all__") {
    return sharedPresetsForPrefix(this.presets, prefix);
  },

  // Default GROUP for the save/rename dialog: the active group filter, else the
  // active preset's group, else none.
  presetNamePromptDefault() {
    const prefix = this.currentPresetPrefixFilter();
    if (prefix && prefix !== "__all__") {
      return prefix;
    }
    const active = this.activePreset();
    return active ? this.presetGroup(active) : NONE_PRESET_GROUP;
  },

  // ── Preset link indicator (PRESET_LINK_GAMEPLAN.md step 5) ─────────────────
  // The chain glyph after "Preset": which Prompt Vault drives this node and how.
  presetLinkInfo() {
    return presetLinkState({
      node: this.node,
      kind: LORA_LOADOUT_KIND,
      root: app.graph,
      presets: this.presets,
      auto: Boolean(widgetValue(this.node, "auto_preset_link")),
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
    setWidgetValue(this.node, "auto_preset_link", false);
    showToast("Auto paused: you picked a preset by hand.", {
      duration: 5000,
      action: { label: "Resume", onClick: () => this.resumeAutoPresetLink() },
    });
  },

  resumeAutoPresetLink() {
    setWidgetValue(this.node, "auto_preset_link", true);
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
    // Virtual --empty--: the node cleared both stacks (no id echoed). Mirror the blank
    // slate here — newPreset() is exactly that reset (clear + persist both stacks,
    // active_preset="", re-baseline), after which the panel reads --empty--.
    if (uiValue(message, "krc_triggered_empty")) {
      this.newPreset();
      return;
    }
    if (!presetId) {
      return;
    }

    const currentId = this.activePresetId();
    if (presetId === currentId && this.isActivePresetModified()) {
      return;
    }

    const stackA = uiValue(message, "krc_stack_a_loras");
    const stackB = uiValue(message, "krc_stack_b_loras");

    const preset = (this.presets || []).find((item) => item?.id === presetId);
    setWidgetValue(this.node, "active_preset", presetId);
    setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(preset));

    // The preset's entries may carry card snapshots: those go to node properties, the
    // stack widgets (run inputs) keep ids and slot values only. persistStack writes them.
    const triggered = (raw) => {
      const entries = this.presetStacks({ loras: parseJsonArray(raw, []) }).A;
      adoptCardSnapshots(this.node, entries);
      return entries.map(({ card, ...entry }) => entry);
    };
    if (stackA) this.stacks.A = triggered(stackA);
    if (stackB) this.stacks.B = triggered(stackB);
    for (const [stackId, raw] of [["A", stackA], ["B", stackB]]) {
      if (!raw) continue;
      this.sortStack(stackId);
      this.persistStack(stackId);
    }
    const switches = uiValue(message, "krc_stack_enabled");
    if (switches) {
      try {
        this.applyPresetStackEnabled({ stackEnabled: JSON.parse(switches) });
      } catch {
        // a malformed echo leaves the switches as they are
      }
    }
    // The link loaded the preset's saved stacks, so the node now matches the global.
    this.captureActivePresetBaseline();
    this.refreshStacks();
  },

  applyMissingLoraUi(message) {
    const raw = uiValue(message, "krc_missing_loras");
    const missing = raw ? parseJsonArray(raw, []) : [];
    const next = Array.isArray(missing) ? missing : [];
    // Only re-render when the missing set actually changes, so a clean run that
    // reports nothing quietly clears a stale warning without needless churn.
    const changed = JSON.stringify(next) !== JSON.stringify(this.missingLoras || []);
    this.missingLoras = next;
    if (changed) {
      this.refreshPresetPanel();
    }
  },

  // A preset's Stack A / B switches (part of the preset since 2026-10-16; older presets
  // have none = both on). Mirrors normalize_stack_enabled in utils/lora_loadout/presets.py.
  presetStackEnabled(preset) {
    const value = preset?.stackEnabled && typeof preset.stackEnabled === "object" ? preset.stackEnabled : {};
    return { A: value.A !== false, B: value.B !== false };
  },

  // The node's own Stack A / B switches (the stack_*_enabled widgets).
  currentStackEnabled() {
    return {
      A: this.stackEnabledValue(widgetValue(this.node, "stack_a_enabled")),
      B: this.stackEnabledValue(widgetValue(this.node, "stack_b_enabled")),
    };
  },

  applyPresetStackEnabled(preset) {
    const switches = this.presetStackEnabled(preset);
    setWidgetValue(this.node, "stack_a_enabled", switches.A);
    setWidgetValue(this.node, "stack_b_enabled", switches.B);
  },

  presetStacks(preset) {
    const normalize = (entries) => (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const id = entry?.id || entry?.sha256 || "";
        return id ? { ...entry, sha256: id } : entry;
      });
    if (preset?.stacks && typeof preset.stacks === "object") {
      return {
        A: normalize(preset.stacks.A),
        B: normalize(preset.stacks.B),
      };
    }
    return {
      A: normalize(preset?.loras),
      B: [],
    };
  },

  presetPayloadStacks(stacks = this.stacks) {
    const normalize = (entries) => (Array.isArray(entries) ? entries : [])
      .filter((entry) => entry?.sha256)
      .map((entry) => ({
        id: String(entry.sha256 || ""),
        order: Number(entry.order),
        enabled: entry.enabled !== false,
        strength: Number(Number(entry.strength ?? 1).toFixed(3)),
        // Display only (shared/card_snapshots.js): never part of the preset signature.
        ...presetEntryCard(this.node, String(entry.sha256 || "")),
      }));
    return {
      A: normalize(stacks.A),
      B: normalize(stacks.B),
    };
  },

  normalizedPresetStack(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .filter((entry) => (entry?.sha256 || entry?.id) && Number.isInteger(Number(entry.order)))
      .map((entry) => ({
        sha256: String(entry.sha256 || entry.id || ""),
        order: Math.max(0, Math.min(5, Number(entry.order))),
        enabled: entry.enabled !== false,
        strength: Number(Number(entry.strength ?? 1).toFixed(3)),
      }))
      .sort((a, b) => a.order - b.order);
  },

  // Signature of the stacks currently in the node (syncs live widget state first).
  currentPresetSignature() {
    this.syncStackFromState("A");
    this.syncStackFromState("B");
    return stableSignature({
      A: this.normalizedPresetStack(this.stacks.A),
      B: this.normalizedPresetStack(this.stacks.B),
      stackEnabled: this.currentStackEnabled(),
    });
  },

  // Signature of a preset's SAVED stacks (the global version).
  savedPresetSignature(preset) {
    const saved = this.presetStacks(preset);
    return stableSignature({
      A: this.normalizedPresetStack(saved.A),
      B: this.normalizedPresetStack(saved.B),
      stackEnabled: this.presetStackEnabled(preset),
    });
  },

  // Snapshot the active preset's global state the moment the node loads it, so a
  // later "the global version moved" can be told apart from "the user edited here"
  // (see classifyActivePreset). Persisted into node properties so the distinction
  // survives a workflow reload — that's what makes cross-session Stale detectable.
  captureActivePresetBaseline() {
    this.node.properties = this.node.properties || {};
    const preset = this.activePreset();
    if (!preset) {
      this._presetBaseline = null;
      delete this.node.properties.llPresetBaseline;
      return;
    }
    const baseline = {
      id: preset.id,
      modifiedAt: Number(preset.modified) || 0,
      signature: this.savedPresetSignature(preset),
    };
    this._presetBaseline = baseline;
    this.node.properties.llPresetBaseline = baseline;
  },

  // Re-adopt the persisted baseline for the active preset after a (re)load; drop it
  // if it belongs to a different preset. Absent baseline => no Stale, only Modified.
  restoreActivePresetBaseline() {
    const stored = this.node?.properties?.llPresetBaseline;
    const activeId = this.activePresetId();
    this._presetBaseline = stored && stored.id && stored.id === activeId ? stored : null;
  },

  classifyActivePreset() {
    const preset = this.activePreset();
    if (!preset) {
      return LOCAL_STATUS.CLEAN;
    }
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
      // The stacks only ever diverge from the loaded baseline by a user edit; a
      // moved global would leave the node's copy equal to the old baseline.
      userTouched: baseline ? currentSignature !== baselineSignature : currentSignature !== globalSignature,
    });
  },

  // "Should the panel show a status badge?" — anything but clean. Retained under the
  // old name because the trigger-apply guard and the render gate both call it.
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
      return stableSignature({
        ...parsed,
        A: (parsed?.A || []).map(remap),
        B: (parsed?.B || []).map(remap),
        // A baseline captured before the switches were part of a preset: both on.
        stackEnabled: this.presetStackEnabled({ stackEnabled: parsed?.stackEnabled }),
      });
    } catch {
      return signature;
    }
  },

  isActivePresetModified() {
    return this.classifyActivePreset() !== LOCAL_STATUS.CLEAN;
  },

  // The Modified badge's hover-card rows: Stack A / B against what this node loaded (the
  // baseline, ids remapped like classifyActivePreset's), else the saved preset.
  presetChangeRows() {
    const preset = this.activePreset();
    if (!preset) return [];
    const baseline = this._presetBaseline && this._presetBaseline.id === preset.id ? this._presetBaseline : null;
    let saved = null;
    try {
      saved = baseline ? JSON.parse(this.canonicalBaselineSignature(baseline.signature)) : null;
    } catch { /* fall back to the saved preset */ }
    saved ||= JSON.parse(this.savedPresetSignature(preset));
    const current = JSON.parse(this.currentPresetSignature());
    const onOff = (value) => (value ? "on" : "off");
    const rows = ["A", "B"]
      .filter((id) => Boolean(saved.stackEnabled?.[id]) !== Boolean(current.stackEnabled?.[id]))
      .map((id) => ({ group: `Stack ${id}`, label: "Stack", before: onOff(saved.stackEnabled?.[id]), after: onOff(current.stackEnabled?.[id]) }));
    return rows.concat(stackChangeRows({
      stacks: ["A", "B"].map((id) => ({ group: `Stack ${id}`, current: current[id] || [], saved: saved[id] || [] })),
      name: (id) => stackEntryName(this, id),
      values: [{ key: "strength", label: "Strength" }],
    }));
  },

  renderPresetStatusBadge() {
    const state = this.presetSelectionState();
    // --unsaved--: LoRAs present that belong to no preset. A gentle nudge, reusing the
    // Draft visual (is-draft) — deliberately NOT the green Modified/Stale token, since
    // unsaved work hasn't diverged from anything; there's no global to compare.
    if (state.kind === "unsaved") {
      return localStatusBadge({
        copy: { badge: { label: "Unsaved", badgeClass: "is-draft", title: "These LoRAs aren’t saved to any preset." } },
        className: "krc-preset-modified-badge",
      });
    }
    // --empty--: a clean blank needs no badge.
    if (state.kind === "empty") {
      return null;
    }
    const status = this.classifyActivePreset();
    if (status === LOCAL_STATUS.CLEAN) {
      return null;
    }
    return localStatusBadge({
      copy: localStatusCopy(status, "preset"),
      className: "krc-preset-modified-badge",
      onDiscard: () => this.discardActivePresetChanges(),
      // Conflict: Keep my changes = save this node's stacks over the newer saved preset.
      onKeep: () => this.savePreset(),
      changes: () => this.presetChangeRows(),   // the hover card's list
    });
  },

  // Point the preset SAVE button at the current status: only Stale changes it (to a
  // blue OVERWRITE that pushes this stale copy up over the newer global version); the
  // same save path runs either way. Every other status keeps the ordinary neutral SAVE.
  applyPresetSaveButton(button) {
    if (!button) {
      return;
    }
    const status = this.classifyActivePreset();
    if (statusOverwrites(status)) {
      const copy = localStatusCopy(status, "preset");
      button.textContent = copy.action.label.toLowerCase();
      button.title = copy.action.title;
      button.classList.add("is-sync");
    } else {
      button.textContent = "save";
      button.title = "Save both stacks as a preset";
      button.classList.remove("is-sync");
    }
  },

  // A newer version of the active preset was saved elsewhere (a sibling node, an import)
  // and this node has no unsaved edit (Stale is only ever that state; an edit reads
  // Modified): load it, as clicking the Stale badge does. Live sync only — a workflow
  // reopened later keeps what it saved and shows Stale.
  async adoptNewerActivePreset() {
    if (this.classifyActivePreset() !== LOCAL_STATUS.STALE) {
      return false;
    }
    await this.discardActivePresetChanges();
    this.refreshPresetPanel?.();
    return true;
  },

  async discardActivePresetChanges() {
    const id = this.activePresetId();
    if (!id) {
      return;
    }
    await this.loadPresetById(id);
  },

  async savePreset() {
    this.syncStackFromState("A");
    this.syncStackFromState("B");
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
        validateName: ({ group, name }) => (
          isReservedLoraPresetName(group, name) ? RESERVED_NAME_MESSAGE : ""
        ),
      });
      if (!result) {
        this.refreshPresetPanel();
        return "";
      }
      ({ group, name } = result);
    }
    let presetId = active?.id || "";
    // A typed group+name that collides with a *different* existing preset: offer to
    // overwrite it (adopt its id) or bail. (Overwriting the active preset via the
    // silent path is the intended save and keeps its id automatically.)
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
    const saved = await this.postPreset({ id: presetId, group, name, stacks: this.presetPayloadStacks(), stackEnabled: this.currentStackEnabled() });
    if (!saved || !saved.id) {
      this.refreshPresetPanel();
      return "";
    }
    setWidgetValue(this.node, "active_preset", saved.id);
    setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(saved));
    await this.loadPresets();
    // The active preset now equals what was just saved (or was cleared) — re-snapshot
    // the baseline so the panel reads clean, not falsely modified/stale.
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
    return saved.id;
  },

  broadcastPresetsChanged(extra = {}) {
    // Sibling stacker panels adopt the module preset cache on this event.
    publishKrcSync("krc-lora-presets-changed", {
      source: this.node?.id,
      lane: KRC_SYNC_LANES.CONTENT,
      ...extra,
    });
  },

  // The group picker's "⋯" menu: Rename / Ungroup / Delete group.
  presetGroupMenu() {
    return buildPresetGroupMenu({
      node: this.node,
      presets: () => this.presets,
      base: loraPath("/presets"),
      onDone: (change) => this.applyPresetGroupChange(change),
    });
  },

  // After a group action: a filter on that group follows it (new name, --none--, or All),
  // and the event's groupChange moves the siblings' filters too.
  async applyPresetGroupChange(change) {
    this.resetPresetCycleSession();
    if (widgetValue(this.node, "preset_prefix_filter") === change.from) {
      setWidgetValue(this.node, "preset_prefix_filter", change.to);
    }
    await this.loadPresets();
    this.broadcastPresetsChanged(groupChangeDetail(change));
  },

  async postPreset(body) {
    // Returns the saved preset record (with its canonical id) so callers can adopt
    // the id as the active pointer, or null on failure.
    let response;
    try {
      response = await postLoraJson("/presets", body);
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
    this.stacks.A = [];
    this.stacks.B = [];
    this.persistStack("A");
    this.persistStack("B");
    setWidgetValue(this.node, "active_preset", "");
    setWidgetValue(this.node, "preset_prefix_filter", "__all__");
    this.captureActivePresetBaseline();
    this.refreshStacks();
  },

  async duplicatePreset() {
    const preset = this.activePreset();
    if (!preset) {
      this.refreshPresetPanel();
      return;
    }
    const stacks = this.presetStacks(preset);
    const group = this.presetGroup(preset);
    const base = preset.name.replace(/\(copy\d*\)$/i, "");
    let name = `${base}(copy)`;
    let counter = 2;
    while (this.presets.some((item) => this.presetGroup(item) === group && item.name === name)) {
      name = `${base}(copy${counter})`;
      counter += 1;
    }
    // id "" mints a fresh preset — a duplicate is a distinct identity, not a
    // second reference to the source. It keeps the source's group.
    const saved = await this.postPreset({ id: "", group, name, stacks: this.presetPayloadStacks(stacks), stackEnabled: this.presetStackEnabled(preset) });
    if (!saved || !saved.id) {
      this.refreshPresetPanel();
      return;
    }
    setWidgetValue(this.node, "active_preset", saved.id);
    setWidgetValue(this.node, "preset_prefix_filter", this.presetGroup(saved));
    await this.loadPresets();
    // The active preset now equals what was just saved (or was cleared) — re-snapshot
    // the baseline so the panel reads clean, not falsely modified/stale.
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
      // Duplicate group+name is allowed (identity is the id), but keep the picker
      // unambiguous by advising against it; a reserved pseudo-preset name is blocked.
      validateName: ({ group, name }) => {
        if (isReservedLoraPresetName(group, name)) {
          return RESERVED_NAME_MESSAGE;
        }
        return this.presets.some((item) => item.id !== preset.id
          && this.presetGroup(item) === group && item.name === name)
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
    this.syncStackFromState("A");
    this.syncStackFromState("B");
    // Atomic server-side rename addressed by id: the id (and every PV link) is
    // untouched; only the group/name/stacks change.
    let response;
    try {
      response = await postLoraJson("/presets/rename", {
        id: preset.id,
        group,
        name,
        stacks: this.presetPayloadStacks(),
        stackEnabled: this.currentStackEnabled(),
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
    setWidgetValue(this.node, "active_preset", preset.id);
    setWidgetValue(this.node, "preset_prefix_filter", canonicalGroup(group));
    await this.loadPresets();
    // The active preset now equals what was just saved (or was cleared) — re-snapshot
    // the baseline so the panel reads clean, not falsely modified/stale.
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
  },

  async deletePreset(id = "", rerender = true) {
    const presetId = id || this.activePresetId();
    if (!presetId) {
      if (rerender) {
        this.refreshPresetPanel();
      }
      return;
    }
    await deleteLoraJson("/presets", { id: presetId });
    if (!id) {
      setWidgetValue(this.node, "active_preset", "");
    }
    await this.loadPresets();
    // The active preset now equals what was just saved (or was cleared) — re-snapshot
    // the baseline so the panel reads clean, not falsely modified/stale.
    this.captureActivePresetBaseline();
    this.broadcastPresetsChanged();
  }
};
