/*
 * KRC Prompt Vault — record status.
 * The normalized record, Modified / Stale / Draft classification against
 * the loaded baseline, the info-panel status badge and the SAVE / OVERWRITE button.
 * Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { localStatusBadge, modifiedBadge } from "../shared/badges.js";
import {
  classifyLocalStatus,
  LOCAL_STATUS,
  localStatusCopy,
  stableSignature,
  statusOverwrites,
} from "../shared/local_status.js";
import { markModifiedFields } from "../shared/modified_dot.js";
import { changeRows } from "../shared/change_list.js";
import { EMPTY_PRESET_DISPLAY, EMPTY_PRESET_LINK } from "./constants.js";
import { kitPresetSignature } from "./kit_presets.js";

// The change list's names for normalizedRecord's keys (kit presets: "<kit> Preset").
const RECORD_FIELD_LABELS = {
  name: "Name", category: "Category", model: "Type", llPreset: "LL Preset",
  prompt: "Prompt A", promptB: "Prompt B", notes: "Notes",
};
// Long text: the list and the dot say just "Changed" / "Modified".
const LONG_RECORD_FIELDS = new Set(["prompt", "promptB", "notes"]);

// The server trims these on every save (save-prompt strips name, text, Prompt B, model,
// notes and the LL preset), so whitespace at either end is never part of a prompt. The
// status compares them trimmed: an untrimmed draft kept as the "saved" copy after a save
// used to read Stale (or Modified) once the trimmed server copy was fetched again.
const trimmed = (value) => String(value || "").trim();

export const statusMethods = {
  normalizedRecord(record = {}) {
    return {
      category: trimmed(record.category),
      name: trimmed(record.name),
      prompt: trimmed(record.prompt),
      promptB: trimmed(record.promptB),
      llPreset: trimmed(record.llPreset),
      // Kit preset links count by id only (the label is a display cache).
      kitPresets: kitPresetSignature(record.kitPresets),
      model: trimmed(record.model),
      notes: trimmed(record.notes),
      appendPromptB: !!record.appendPromptB,
      // replaceFind / replaceWith are the Find/Replace TOOL's input fields, not prompt
      // content — typing a search term must not flag the prompt Modified (or Stale).
      // The actual edit lands when REPLACE is applied, which rewrites `prompt`/`promptB`
      // above, so a real content change is still caught. (customBadge is likewise out:
      // quick metadata edited + instantly persisted via the card notch, not content.)
    };
  },
  isModified() {
    if (!this.draft || !this.orig) return false;
    const saved = this.savedForDraft();
    const savedDetail = this.savedDetailForDraft() || saved;
    if (!saved) return false;
    return JSON.stringify(this.normalizedRecord(this.draft)) !== JSON.stringify(this.normalizedRecord(savedDetail));
  },
  isPromptInputTargetModified(savedRecord = null) {
    if (!this.draft) return false;
    const saved = savedRecord || this.savedDetailForDraft() || this.savedForDraft();
    if (!saved) return false;
    const field = this.promptInputTarget() === "B" ? "promptB" : "prompt";
    return trimmed(this.draft[field]) !== trimmed(saved[field]);
  },

  modifiedKey() {
    return !this.profileMismatch() && this.isModified() && this.orig ? this.keyOf(this.orig.category, this.orig.name) : null;
  },

  updateModifiedBadge() {
    const slot = this.root.querySelector(".krc-info-modified-slot");
    if (slot) {
      slot.innerHTML = "";
      const badge = this.statusBadgeEl();
      if (badge) slot.append(badge);
    }
    this.applyPromptSaveButton(this.root.querySelector(".krc-save-button"));
    this.refreshSelectedPromptCard();
    this.renderModifiedFields();
  },

  // Per-field Modified state: one descriptor (shared/modified_dot.js) for the dots on the
  // editor's fields and the badge's hover-card list (shared/change_list.js). Each field is
  // one key of normalizedRecord, compared as the badge compares it, against the loaded
  // baseline (what this node started from; else the saved record), so a dot or a row
  // always means the badge reads Modified. Only your own edits (Modified / Conflict):
  // never Stale, Draft or another profile's prompt. -> { descriptor, enabled }.
  recordChangeDescriptor() {
    const status = this.isDraftActive() || this.profileMismatch() ? LOCAL_STATUS.CLEAN : this.classifyRecord();
    const enabled = status === LOCAL_STATUS.MODIFIED || status === LOCAL_STATUS.CONFLICT;
    const savedRecord = enabled ? (this.savedDetailForDraft() || this.savedForDraft()) : null;
    let saved = savedRecord ? this.normalizedRecord(savedRecord) : null;
    try {
      const baseline = this.recordBaseline();
      if (enabled && baseline?.signature) saved = JSON.parse(baseline.signature);
    } catch { /* keep the saved record */ }
    const draft = this.draft || {};
    const current = this.normalizedRecord(draft);
    const kitIds = (text) => Object.fromEntries(String(text || "").split("\n").filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    const kits = [...new Set([...Object.keys(kitIds(current.kitPresets)), ...Object.keys(kitIds(saved?.kitPresets))])];
    const kitName = (kitId) => `${this.kitShortLabel?.(kitId) || kitId} Preset`;
    const valueOf = (record, key) => {
      if (key.startsWith("kit:")) return kitIds(record.kitPresets)[key.slice(4)] || "";
      // Prompt B's Append switch is part of Prompt B.
      if (key === "promptB") return [record.promptB, record.appendPromptB];
      return record[key];
    };
    // A preset link by name: the draft's or the saved record's cached label for that id.
    const presetName = (id, labels) => !id ? "none" : id === EMPTY_PRESET_LINK ? EMPTY_PRESET_DISPLAY
      : (labels.find((link) => link?.id === id)?.label || id);
    const els = this._pmDotEls || {};
    return {
      enabled: Boolean(saved),
      descriptor: {
        fields: ["name", "category", "model", "llPreset", ...kits.map((kitId) => `kit:${kitId}`), "prompt", "promptB", "notes"],
        element: (key) => els[key] || null,
        inline: (key) => key !== "name",
        current: (key) => valueOf(current, key),
        saved: (key) => valueOf(saved, key),
        label: (key) => key.startsWith("kit:") ? kitName(key.slice(4)) : RECORD_FIELD_LABELS[key],
        text: (key, value) => {
          if (LONG_RECORD_FIELDS.has(key)) return null;
          if (key === "llPreset") {
            return presetName(value, [{ id: draft.llPreset, label: draft.llPresetLabel }, { id: savedRecord?.llPreset, label: savedRecord?.llPresetLabel }]);
          }
          if (key.startsWith("kit:")) {
            const kitId = key.slice(4);
            return presetName(value, [draft.kitPresets?.[kitId], savedRecord?.kitPresets?.[kitId]]);
          }
          return String(value || "");
        },
      },
    };
  },

  // The dots on the editor's fields (this._pmDotEls, set by renderInfo; null with no
  // editor). -> how many fields carry a dot.
  renderModifiedFields() {
    if (!this._pmDotEls) return 0;
    const { descriptor, enabled } = this.recordChangeDescriptor();
    return markModifiedFields(descriptor, { enabled });
  },

  // The Modified badge's hover-card rows.
  recordChangeRows() {
    const { descriptor, enabled } = this.recordChangeDescriptor();
    return enabled ? changeRows(descriptor) : [];
  },

  // A saved prompt can be referenced by two nodes / workflows, so the same record
  // can drift. Snapshot the record's global state when this node loads it — persisted
  // so it survives reload — to tell a local edit (Modified) apart from the record
  // having moved elsewhere (Stale). Recaptured after each content save; flags/colour
  // are outside normalizedRecord so they never affect this.
  recordBaseline() {
    const stored = this.node?.properties?.pmRecordBaseline;
    return stored && stored.key && stored.key === this.selKey ? stored : null;
  },
  captureRecordBaseline() {
    const saved = this.savedDetailForDraft() || this.savedForDraft();
    if (!this.orig || !saved || !this.selKey) {
      this.setSerializableProperty("pmRecordBaseline", null);
      return;
    }
    this.setSerializableProperty("pmRecordBaseline", {
      key: this.selKey,
      modifiedAt: this.dateMs(saved.dateModified || saved.dateAdded),
      signature: stableSignature(this.normalizedRecord(saved)),
    });
  },
  classifyRecord() {
    if (!this.draft || !this.orig) return LOCAL_STATUS.CLEAN;
    const saved = this.savedForDraft();
    const savedDetail = this.savedDetailForDraft() || saved;
    if (!savedDetail) return LOCAL_STATUS.CLEAN;
    const currentSignature = stableSignature(this.normalizedRecord(this.draft));
    const globalSignature = stableSignature(this.normalizedRecord(savedDetail));
    const baseline = this.recordBaseline();
    return classifyLocalStatus({
      currentSignature,
      globalSignature,
      loadedGlobalSignature: baseline ? baseline.signature : "",
      currentGlobalModifiedAt: this.dateMs(savedDetail.dateModified || savedDetail.dateAdded),
      loadedGlobalModifiedAt: baseline ? baseline.modifiedAt : 0,
      // The draft only diverges from the loaded baseline by a user edit; the record
      // moving elsewhere leaves this node's copy equal to the old baseline.
      userTouched: baseline ? currentSignature !== baseline.signature : currentSignature !== globalSignature,
    });
  },
  // Flip the save button to a blue OVERWRITE when the record is stale or in conflict
  // (push this node's version up over the newer global one); same save path.
  applyPromptSaveButton(button) {
    if (!button) return;
    button.disabled = this.profileMissing() || !!this._savingOther;
    if (this.profileMismatch()) {
      button.textContent = "save";
      button.title = this.profileMissing() ? "Choose a valid profile before saving a copy." : this.otherProfileTitle();
      button.classList.remove("is-sync");
      return;
    }
    const status = this.isDraftActive() ? LOCAL_STATUS.DRAFT : this.classifyRecord();
    if (statusOverwrites(status)) {
      const copy = localStatusCopy(status, "prompt");
      button.textContent = copy.action.label.toLowerCase();
      button.title = copy.action.title;
      button.classList.add("is-sync");
    } else {
      button.textContent = "save";
      button.removeAttribute("title");
      button.classList.remove("is-sync");
    }
  },
  // The info-panel status badge: Draft for the node-local draft (no global record
  // yet), else Stale when the record moved elsewhere, else Modified for local edits.
  statusBadgeEl() {
    if (this.isDraftActive()) return this.renderDraftBadge();
    if (this.profileMismatch()) {
      const copy = localStatusCopy(LOCAL_STATUS.OTHER, "prompt");
      return localStatusBadge({
        copy: { ...copy, badge: { ...copy.badge, title: this.otherProfileTitle() } },
        onDiscard: () => this.discardOtherPrompt(),
      });
    }
    const status = this.classifyRecord();
    if (status === LOCAL_STATUS.STALE) {
      return localStatusBadge({
        copy: localStatusCopy(LOCAL_STATUS.STALE, "prompt"),
        onDiscard: () => this.discardDraft(),
        changes: () => [],
      });
    }
    // Conflict: edited here and saved elsewhere. Keep my changes = Save (over the newer
    // saved prompt); Discard my changes = load the saved one, as Stale's click does.
    if (status === LOCAL_STATUS.CONFLICT) {
      return localStatusBadge({
        copy: localStatusCopy(LOCAL_STATUS.CONFLICT, "prompt"),
        onDiscard: () => this.discardDraft(),
        onKeep: () => this.save(),
        changes: () => [],
      });
    }
    if (status === LOCAL_STATUS.MODIFIED) return this.renderModifiedBadge();
    return null;
  },
  renderModifiedBadge() {
    return modifiedBadge({
      discardable: true,
      title: localStatusCopy(LOCAL_STATUS.MODIFIED, "prompt").badge.title,
      onDiscard: () => this.discardDraft(),
      changes: () => this.recordChangeRows(),
    });
  },
  renderDraftBadge() {
    return localStatusBadge({
      copy: localStatusCopy(LOCAL_STATUS.DRAFT, "prompt"),
      discardLabel: "Delete",
      onDiscard: () => this.discardPvDraft(),
    });
  },
};
