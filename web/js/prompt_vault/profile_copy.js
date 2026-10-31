import { apiPost } from "./api.js";
import { profileName } from "./profiles.js";
import { KRC_SYNC_LANES } from "../shared/sync_bus.js";
import { UNASSIGNED_CATEGORY } from "./constants.js";

export const profileCopyMethods = {
  otherProfileTitle() {
    const owner = this.orig?.profileId || this.draft?.profileId;
    const name = profileName(owner);
    const from = name === "Missing profile" ? `missing profile (${owner})` : `profile “${name}”`;
    const target = profileName(this.effectiveProfileId());
    const edits = this.isModified() ? " Includes unsaved changes." : "";
    const save = this.profileMissing() ? "Choose a valid destination profile before using SAVE to create a copy" : `SAVE to create a copy in profile “${target}”`;
    return `This prompt belongs to ${from}.${edits} ${save}, or DISCARD to clear and return to NEW. The original stays unchanged.`;
  },

  discardOtherPrompt() {
    this._browserSelectionUI?.endForEdit();
    this.disarmDelete?.();
    this.disarmThumbRemove?.();
    if (this.promptInputEnabled?.()) this.rejectCurrentPromptInput();
    this._selectRequestKey = null;
    this._profileCopyGeneration = (this._profileCopyGeneration || 0) + 1;
    this._savingOther = false;
    // Clear every emitted prompt/preset value too, not only the editor references.
    // Keep any separate node-local draft rather than discarding unrelated work.
    this.orig = null;
    this.selKey = null;
    this._savedPromptDetail = null;
    this.draft = this.blankDraft(UNASSIGNED_CATEGORY);
    this.syncWidgetsFromDraft();
    this.clearPersistedDraft();
    this.setSerializableProperty("pmRecordBaseline", null);
    this.setSerializableProperty("pmDraftSelected", false);
    this.draft = null;
    this.resetEditHistory();
    this.refreshAll({ preserveScroll: true });
  },

  async saveOtherPrompt() {
    if (this._savingOther || !this.orig || !this.draft) return;
    if (this.profileMissing()) { this.toast("Choose a valid profile before saving."); return; }
    const draft = this.draft;
    const snapshot = JSON.parse(JSON.stringify(draft));
    const origin = this.orig;
    const profile = this.effectiveProfileId();
    const name = String(draft.name || "").trim();
    const category = String(draft.category || UNASSIGNED_CATEGORY).trim() || UNASSIGNED_CATEGORY;
    if (!name) { this.toast("Name is required"); return; }
    const payload = { ...this.payloadFromRecord(category, name, snapshot),
      source_id: draft.id || this._savedPromptDetail?.id, source_category: origin.category, source_name: origin.name };
    delete payload.id;
    this._savingOther = true;
    const generation = this._profileCopyGeneration = (this._profileCopyGeneration || 0) + 1;
    this.updateModifiedBadge();
    try {
      const result = await apiPost.call(this, "/copy-to-profile", payload);
      // A switch/discard/new selection cannot be replaced by a late copy response.
      if (generation !== this._profileCopyGeneration || this._destroyed || this.draft !== draft
          || this.orig !== origin || this.effectiveProfileId() !== profile) return;
      if (!result?.success) { this.toast(result?.error || "Could not copy the prompt."); return; }
      const detail = this.detailFromPromptLibrary(result.prompts, result.category, result.name, snapshot);
      detail.id = result.id;
      detail.profileId = profile;
      this.publishPromptLibrary(result.prompts, { lane: KRC_SYNC_LANES.CONTENT, detail });
      this.selKey = this.keyOf(result.category, result.name);
      this.orig = { category: result.category, name: result.name, profileId: profile };
      const lateEdits = {};
      for (const key of Object.keys(snapshot)) {
        if (["id", "profileId", "category", "name"].includes(key)) continue;
        if (JSON.stringify(draft[key]) !== JSON.stringify(snapshot[key])) lateEdits[key] = draft[key];
      }
      for (const key of ["category", "name"]) {
        if (draft[key] !== snapshot[key]) lateEdits[key] = draft[key];
      }
      this.setSavedPromptDetail(detail, snapshot);
      this.draft = { ...this._savedPromptDetail, id: result.id, profileId: profile };
      this.captureRecordBaseline();
      Object.assign(this.draft, lateEdits);
      this.syncWidgetsFromDraft();
      this.resetEditHistory();
      this.followSelectionCategory?.(result.category);
      this.refreshAll({ preserveScroll: true });
      this.scrollSelectionIntoView?.();
    } catch (error) {
      if (generation === this._profileCopyGeneration && !this._destroyed) this.toast(error?.message || "Could not copy the prompt.");
    } finally {
      if (generation === this._profileCopyGeneration) {
        this._savingOther = false;
        if (!this._destroyed) this.updateModifiedBadge();
      }
    }
  },
};
