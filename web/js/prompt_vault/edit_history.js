/*
 * KRC Prompt Vault — edit history.
 * Local undo / redo of the editable text buffer, and pushing the draft back
 * into the edit fields in place (no panel rebuild).
 * Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { normalizeKitPresets } from "./kit_presets.js";

export const editHistoryMethods = {
  // ── Local editing-buffer undo/redo ──────────────────────────────────────
  // History covers ONLY the editable text buffer (Prompt A/B, LL preset, notes,
  // model) plus the append flag — never persisted/quick-metadata state. It is a
  // per-selection session: wiped on prompt switch, new, discard, and reload.
  editSnapshot() {
    const d = this.draft || {};
    return {
      prompt: d.prompt || "",
      promptB: d.promptB || "",
      llPreset: d.llPreset || "",
      llPresetLabel: d.llPresetLabel || "",
      kitPresets: normalizeKitPresets(d.kitPresets),
      notes: d.notes || "",
      model: d.model || "",
      replaceFind: d.replaceFind || "",
      replaceWith: d.replaceWith || "",
      appendPromptB: !!d.appendPromptB,
    };
  },

  sameEditSnapshot(a, b) {
    return !!a && !!b
      && a.prompt === b.prompt && a.promptB === b.promptB
      && a.llPreset === b.llPreset && a.notes === b.notes
      && JSON.stringify(a.kitPresets) === JSON.stringify(b.kitPresets)
      && a.model === b.model
      && a.replaceFind === b.replaceFind && a.replaceWith === b.replaceWith
      && a.appendPromptB === b.appendPromptB;
  },

  resetEditHistory() {
    clearTimeout(this._editSnapTimer);
    this._editSnapTimer = null;
    this._editHistory = this.draft ? [this.editSnapshot()] : [];
    this._editIndex = this._editHistory.length - 1;
    this.updateUndoRedoButtons();
  },

  scheduleEditSnapshot() {
    if (this._applyingSnapshot || !this.draft || !Array.isArray(this._editHistory)) return;
    clearTimeout(this._editSnapTimer);
    this._editSnapTimer = setTimeout(() => {
      this._editSnapTimer = null;
      this.commitEditSnapshot();
    }, 500);
  },

  commitEditSnapshot() {
    if (!this.draft || !Array.isArray(this._editHistory)) return;
    const snap = this.editSnapshot();
    if (this.sameEditSnapshot(this._editHistory[this._editIndex], snap)) return;
    this._editHistory.splice(this._editIndex + 1);   // drop the redo tail
    this._editHistory.push(snap);
    if (this._editHistory.length > 100) this._editHistory.shift();
    this._editIndex = this._editHistory.length - 1;
    this.updateUndoRedoButtons();
  },

  canUndoEdit() { return Array.isArray(this._editHistory) && this._editIndex > 0; },
  canRedoEdit() { return Array.isArray(this._editHistory) && this._editIndex < this._editHistory.length - 1; },

  undoEdit() {
    clearTimeout(this._editSnapTimer);
    this._editSnapTimer = null;
    this.commitEditSnapshot();   // seal any pending typing as its own step first
    if (!this.canUndoEdit()) return;
    this._editIndex--;
    this.applyEditSnapshot(this._editHistory[this._editIndex]);
  },

  redoEdit() {
    if (!this.canRedoEdit()) return;
    this._editIndex++;
    this.applyEditSnapshot(this._editHistory[this._editIndex]);
  },

  applyEditSnapshot(snap) {
    if (!this.draft || !snap) return;
    this._applyingSnapshot = true;
    Object.assign(this.draft, {
      prompt: snap.prompt,
      promptB: snap.promptB,
      llPreset: snap.llPreset,
      llPresetLabel: snap.llPresetLabel || "",
      kitPresets: normalizeKitPresets(snap.kitPresets),
      notes: snap.notes,
      model: snap.model,
      replaceFind: snap.replaceFind,
      replaceWith: snap.replaceWith,
      appendPromptB: snap.appendPromptB,
    });
    // Update the existing fields in place — no full panel rebuild, so focus and
    // scroll are preserved and the undo/redo buttons keep their identity.
    this.syncEditFieldsToDom();
    this.draftChanged();           // widget sync + modified badge (schedule guarded)
    this._applyingSnapshot = false;
    this.updateUndoRedoButtons();
  },

  syncEditFieldsToDom() {
    const f = this._pmEditFields;
    const d = this.draft || {};
    if (f) {
      if (f.prompt) f.prompt.value = d.prompt || "";
      if (f.promptB) f.promptB.value = d.promptB || "";
      if (f.model) f.model.value = d.model || "";
      if (f.replaceFind) f.replaceFind.value = d.replaceFind || "";
      if (f.replaceWith) f.replaceWith.value = d.replaceWith || "";
    }
    // The LL preset field is a picker, not a plain input — drive it from the draft.
    this._pmPresetPicker?.syncToDraft?.();
    for (const picker of this._pmKitPickers || []) picker.syncToDraft();
    const appendBtn = this.root?.querySelector(".krc-info-panel .krc-inline-action.is-append");
    if (appendBtn) {
      appendBtn.classList.toggle("is-on", !!d.appendPromptB);
      appendBtn.title = d.appendPromptB ? "Prompt B appends after Prompt A" : "Append Prompt B after Prompt A";
    }
    const inputBtn = this.root?.querySelector(".krc-info-panel .krc-prompt-input-toggle");
    if (inputBtn) {
      inputBtn.classList.toggle("is-on", this.promptInputEnabled());
      inputBtn.setAttribute("aria-pressed", this.promptInputEnabled() ? "true" : "false");
    }
    const inputTargetBtn = this.root?.querySelector(".krc-info-panel .krc-prompt-input-target");
    if (inputTargetBtn) {
      const target = this.promptInputTarget();
      inputTargetBtn.textContent = target;
      inputTargetBtn.title = `Prompt input target: Prompt ${target}`;
    }
  },

  updateUndoRedoButtons() {
    const undo = this.root?.querySelector(".krc-undo-button");
    const redo = this.root?.querySelector(".krc-redo-button");
    if (undo) undo.disabled = !this.canUndoEdit();
    if (redo) redo.disabled = !this.canRedoEdit();
  },
};
