/*
 * KRC Prompt Vault — node state.
 * The draft snapshot, the backing widgets the node runs from, node.properties,
 * per-node options (replace Prompt B, clear LoRA when missing, new-prompt preset) and the
 * prompt input (enable, target, disable on swap, rejection).
 * Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { app } from "../../../scripts/app.js";
import { downstreamNodes } from "../shared/graph_walk.js";
import { loadoutKindOf, syncLoadoutFromPresetLink } from "../shared/loadout_presets.js";
import { setWidgetValue } from "../shared/widgets.js";
import { UNASSIGNED_CATEGORY } from "./constants.js";
import { normalizeKitPresets } from "./kit_presets.js";

export const nodeStateMethods = {
  draftSnapshot() {
    const d = this.draft || {};
    return {
      id: d.id || "",
      profileId: this.orig?.profileId || d.profileId || this.effectiveProfileId?.() || "default",
      category: d.category || UNASSIGNED_CATEGORY,
      name: d.name || "",
      prompt: d.prompt || "",
      llPreset: d.llPreset || "",
      llPresetLabel: d.llPresetLabel || "",
      kitPresets: normalizeKitPresets(d.kitPresets),
      promptB: d.promptB || "",
      appendPromptB: !!d.appendPromptB,
      replaceFind: d.replaceFind || "",
      replaceWith: d.replaceWith || "",
      model: d.model || "",
      notes: d.notes || "",
      customBadge: d.customBadge || "",
    };
  },

  setSerializableProperty(name, value) {
    this.node.properties ||= {};
    if (typeof this.node.setProperty === "function") {
      this.node.setProperty(name, value);
    } else {
      this.node.properties[name] = value;
    }
  },

  // The kit_presets run input: {kit id: preset id} for each kit row switched on in this
  // node's Options ("" = --none--), so the preset output carries that kit's line. No row
  // on = "" = the link carries LoRA Loadout's entry only. Driven by the switches, not by
  // which kits have loaded, so it's right from the first restore.
  kitPresetsWidgetValue() {
    const enabled = Object.keys(this.node?.properties?.pmKitRows || {}).filter((kitId) => this.node.properties.pmKitRows[kitId]).sort();
    if (!enabled.length) return "";
    const links = normalizeKitPresets(this.draft?.kitPresets);
    return JSON.stringify(Object.fromEntries(enabled.map((kitId) => [kitId, links[kitId]?.id || ""])));
  },

  syncKitPresetsWidget() {
    if (!this.widgets.kitPresets) return;
    setWidgetValue(this.node, this.widgets.kitPresets, "kit_presets", this.kitPresetsWidgetValue(), {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    // Every change of the link's widgets ends here (syncWidgetsFromDraft calls this last).
    this.notifyPresetLinkChanged();
  },

  // Live preview (PRESET_LINK_GAMEPLAN.md step 6): when the link this node sends changes,
  // the loadouts its preset output reaches re-read it and load what the run would. The
  // first sync after the node (re)loads only records the link, and nothing is pushed while
  // a workflow loads: applying then would rewrite loadouts saved as they are.
  notifyPresetLinkChanged() {
    if (this.surface === "detached" || !this.node?.graph) return;
    const signature = JSON.stringify([
      this.widgets.llPreset?.value ?? "",
      this.widgets.kitPresets?.value ?? "",
      !!this.widgets.clearLoraWhenMissing?.value,
    ]);
    const previous = this._presetLinkSignature;
    this._presetLinkSignature = signature;
    if (previous === undefined || previous === signature || app.configuringGraph) return;
    const loadouts = downstreamNodes(this.node, "preset", (node) => !!loadoutKindOf(node), { root: app.graph });
    for (const node of loadouts) syncLoadoutFromPresetLink(node);
  },

  // Drive the backing widgets so the node outputs the selected prompt.
  syncWidgetsFromDraft() {
    const d = this.draft; if (!d) return;
    const set = (w, name, v) => {
      if (!w) return;
      setWidgetValue(this.node, w, name, v, {
        nodeEvents: false,
        syncWidgetsValues: true,
        dirty: false,
      });
    };
    set(this.widgets.category, "category", d.category || UNASSIGNED_CATEGORY);
    set(this.widgets.name, "name", d.name || "");
    set(this.widgets.text, "text", d.prompt || "");
    set(this.widgets.llPreset, "ll_preset", d.llPreset || "");
    this.syncKitPresetsWidget();
    set(this.widgets.promptB, "prompt_b", d.promptB || "");
    set(this.widgets.appendPromptB, "append_prompt_b", !!d.appendPromptB);
    set(this.widgets.replaceFind, "replace_find", d.replaceFind || "");
    set(this.widgets.replaceWith, "replace_with", d.replaceWith || "");
    const snapshot = this.draftSnapshot();
    // prompt_id follows pmOrigCategory / pmOrigName: the saved prompt this node came from,
    // by record id ("" for a node-local draft). Only exports read it; the run ignores it.
    set(this.widgets.promptId, "prompt_id", this.isDraftActive() ? "" : this.savedPromptId());
    if (this.isDraftActive()) {
      // Editing the node-local draft: persist to pvDraftPrompt, and keep pmDraft
      // clear so it only ever holds unsaved edits to a SAVED record.
      set(this.widgets.draftState, "pm_draft", "");
      this.setSerializableProperty("pmOrigCategory", "");
      this.setSerializableProperty("pmOrigName", "");
      this.setSerializableProperty("pmDraft", null);
      this.setSerializableProperty("pvDraftPrompt", snapshot);
      this.setSerializableProperty("pmDraftSelected", true);
    } else {
      const origCategory = this.orig?.category || "";
      const origName = this.orig?.name || "";
      set(this.widgets.draftState, "pm_draft", JSON.stringify({ origCategory, origName, draft: snapshot }));
      this.setSerializableProperty("pmOrigCategory", origCategory);
      this.setSerializableProperty("pmOrigName", origName);
      this.setSerializableProperty("pmDraft", snapshot);
      this.setSerializableProperty("pmDraftSelected", false);
    }
    this.node.serialize_widgets = true;
    this.markCanvasDirty();
  },
  // The record id of the saved prompt the node was loaded from: the library's record at
  // the loaded category / name, else the loaded detail's own id.
  savedPromptId() {
    if (this.profileMismatch?.()) return String(this._savedPromptDetail?.id || this.draft?.id || "");
    const category = this.orig?.category || "";
    const name = this.orig?.name || "";
    if (!category || !name) return "";
    const record = this.data?.[category]?.[name];
    return String(record?.id || this._savedPromptDetail?.id || this.draft?.id || "");
  },
  // Wipe the persisted draft so a reload shows the empty state instead of
  // restoring a draft that no longer applies — e.g. after deleting the selected
  // prompt or its category. Mirrors the storage keys syncWidgetsFromDraft writes.
  clearPersistedDraft() {
    if (this.widgets.draftState) {
      setWidgetValue(this.node, this.widgets.draftState, "pm_draft", "", {
        nodeEvents: false,
        syncWidgetsValues: true,
        dirty: false,
      });
    }
    if (this.widgets.promptId) {
      setWidgetValue(this.node, this.widgets.promptId, "prompt_id", "", {
        nodeEvents: false,
        syncWidgetsValues: true,
        dirty: false,
      });
    }
    this.setSerializableProperty("pmOrigCategory", "");
    this.setSerializableProperty("pmOrigName", "");
    this.setSerializableProperty("pmDraft", null);
    this.node.serialize_widgets = true;
    this.markCanvasDirty();
  },
  replacePromptBEnabled() {
    return !!this.node.properties?.pmReplacePromptB;
  },
  setReplacePromptBEnabled(value, { dirty = true } = {}) {
    const enabled = !!value;
    this.setSerializableProperty("pmReplacePromptB", enabled);
    setWidgetValue(this.node, this.widgets.replacePromptB, "replace_prompt_b", enabled, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  clearLoraWhenMissingEnabled() {
    return !!this.node.properties?.pmClearLoraWhenMissing;
  },
  setClearLoraWhenMissing(value, { dirty = true } = {}) {
    const enabled = !!value;
    this.setSerializableProperty("pmClearLoraWhenMissing", enabled);
    setWidgetValue(this.node, this.widgets.clearLoraWhenMissing, "clear_lora_when_missing", enabled, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    this.node.serialize_widgets = true;
    if (dirty) {
      this.markCanvasDirty();
      // A user toggle changes the missing policy the loadouts preview with.
      this.notifyPresetLinkChanged();
    }
  },
  newPromptEmptyPresetEnabled() {
    return !!this.node.properties?.pmNewPromptEmptyPreset;
  },
  setNewPromptEmptyPreset(value, { dirty = true } = {}) {
    const enabled = !!value;
    this.setSerializableProperty("pmNewPromptEmptyPreset", enabled);
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  promptInputEnabled() {
    return !!this.node.properties?.pmPromptInputEnabled;
  },
  setPromptInputEnabled(value, { dirty = true } = {}) {
    const enabled = !!value;
    this.setSerializableProperty("pmPromptInputEnabled", enabled);
    setWidgetValue(this.node, this.widgets.promptInputEnabled, "prompt_input_enabled", enabled, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    if (!enabled) this.clearPromptInputRejection({ dirty: false });
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  promptInputTarget() {
    return this.node.properties?.pmPromptInputTarget === "B" ? "B" : "A";
  },
  setPromptInputTarget(value, { dirty = true } = {}) {
    const target = value === "B" ? "B" : "A";
    this.setSerializableProperty("pmPromptInputTarget", target);
    setWidgetValue(this.node, this.widgets.promptInputTarget, "prompt_input_target", target, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    this.clearPromptInputRejection({ dirty: false });
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  promptInputDisableOnSwap() {
    return !!this.node.properties?.pmPromptInputDisableOnSwap;
  },
  setPromptInputDisableOnSwap(value, { dirty = true } = {}) {
    const enabled = !!value;
    this.setSerializableProperty("pmPromptInputDisableOnSwap", enabled);
    setWidgetValue(this.node, this.widgets.promptInputDisableOnSwap, "prompt_input_disable_on_swap", enabled, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  applyPromptInputFromRun(value, target = this.promptInputTarget()) {
    const text = String(value || "");
    this._lastPromptInputText = text;
    this.clearPromptInputRejection({ dirty: false });
    if (!this.promptInputEnabled() || !this.draft) return false;
    const field = target === "B" ? "promptB" : "prompt";
    if (!text.trim() || text === (this.draft[field] || "")) return false;
    clearTimeout(this._editSnapTimer);
    this._editSnapTimer = null;
    this.commitEditSnapshot();
    this.draft[field] = text;
    this.syncEditFieldsToDom();
    this.draftChanged();
    this.commitEditSnapshot();
    return true;
  },
  setPromptInputRejection(text, target = this.promptInputTarget(), { dirty = true } = {}) {
    const rejected = String(text || "");
    const rejectedTarget = target === "B" ? "B" : "A";
    this.setSerializableProperty("pmPromptInputRejected", rejected);
    this.setSerializableProperty("pmPromptInputRejectedTarget", rejectedTarget);
    setWidgetValue(this.node, this.widgets.promptInputRejected, "prompt_input_rejected", rejected, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    setWidgetValue(this.node, this.widgets.promptInputRejectedTarget, "prompt_input_rejected_target", rejectedTarget, {
      nodeEvents: false,
      syncWidgetsValues: true,
      dirty: false,
    });
    this.node.serialize_widgets = true;
    if (dirty) this.markCanvasDirty();
  },
  clearPromptInputRejection({ dirty = true } = {}) {
    this.setPromptInputRejection("", this.promptInputTarget(), { dirty });
  },
  rejectCurrentPromptInput() {
    const target = this.promptInputTarget();
    const field = target === "B" ? "promptB" : "prompt";
    const rejected = this._lastPromptInputText?.trim() ? this._lastPromptInputText : this.draft?.[field];
    if (!String(rejected || "").trim()) return false;
    this.setPromptInputRejection(rejected, target);
    return true;
  },
};
