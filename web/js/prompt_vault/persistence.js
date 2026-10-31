/*
 * KRC Prompt Vault — persistence.
 * Save / quick-persist / flag toggles / duplicate / delete / rename payloads
 * and archive export-import. Mixed onto the Prompt Vault controller prototype via
 * Object.assign.
 */
import { optimisticBooleanFlag } from "../shared/flags.js";
import { normalizeCardColorId } from "../shared/card_colors.js";
import { MAX_PINNED } from "../shared/pinning.js";
import { KRC_SYNC_LANES } from "../shared/sync_bus.js";
import { PAGE_SYNC_ID } from "../shared/sync_origin.js";
import { apiPost } from "./api.js";
import { openBundleExport } from "../shared/transfer/bundle_dialogs.js";
import { UNASSIGNED_CATEGORY } from "./constants.js";
import { normalizeKitPresets } from "./kit_presets.js";

export const persistMethods = {
  promptBulkOperation(kind) {
    const request = async (path, payload) => {
      const result = await apiPost.call(this, path, payload);
      if (!result?.success) throw new Error(result?.error || "The prompt operation failed.");
      return result;
    };
    return {
      node: this.node, kind, noun: "prompts", title: kind === "delete" ? "Delete selected prompts" : "Move selected prompts",
      destinationLabel: "Category",
      preview: (ids) => request("/bulk-operation/preview", { ids, operation: kind }),
      execute: async (ids, options) => {
        const result = await request("/bulk-operation", { ids, operation: kind, ...options, originPage: PAGE_SYNC_ID });
        this.publishPromptLibrary(result.prompts, { structurePatch: result });
        return result;
      },
    };
  },

  async bulkPromptAttributes(ids, field, value) {
    const result = await apiPost.call(this, "/bulk-attributes", { ids, field, value, originPage: PAGE_SYNC_ID });
    if (!result?.success) throw new Error(result?.error || "Could not save prompt attributes.");
    this.publishPromptLibrary(result.prompts, { lane: KRC_SYNC_LANES.METADATA, attributePatch: { ids, field, value } });
    this.refreshPromptMutation({ list: true, replaceCard: true });
    return result;
  },

  async save() {
    this._browserSelectionUI?.endForEdit();
    if (this.profileMissing?.()) { this.toast("Choose a valid profile before saving."); return; }
    if (this.profileMismatch?.()) return this.saveOtherPrompt();
    const d = this.draft; if (!d) return;
    await this.ensurePromptDetail?.(d);
    const cat = (d.category || UNASSIGNED_CATEGORY).trim() || UNASSIGNED_CATEGORY;
    const name = (d.name || "").trim();
    if (!name) { await this.toast("Name is required"); return; }

    // Saving the node-local draft promotes it into a real Prompt Vault record;
    // the draft (and its browser card) is cleared once the record exists.
    const wasDraft = this.isDraftActive();
    const hadOrig = !!this.orig;
    const renamed = hadOrig && (this.orig.category !== cat || this.orig.name !== name);
    const movedCategory = hadOrig && this.orig.category !== cat;

    if (!this.data[cat]) await apiPost.call(this, "/save-category", { category_name: cat });
    if (renamed) {
      const origKey = this.keyOf(this.orig.category, this.orig.name);
      // Name collision in the target → confirm before overwriting. Cancel prevents the
      // rename: revert the edited name/category so nothing is clobbered (previously this
      // path fired rename unchecked, then save-prompt silently overwrote the collision).
      let overwrite = false;
      if (this.promptExists(cat, name, origKey)) {
        overwrite = await this.confirmOverwritePopover(origKey, cat, name);
        if (!overwrite) {
          this.draft.name = this.orig.name;
          this.draft.category = this.orig.category;
          this.syncWidgetsFromDraft();
          return;
        }
      }
      const rres = await apiPost.call(this, "/rename-prompt", {
        category: this.orig.category, old_name: this.orig.name, new_name: name, new_category: cat, overwrite,
      });
      if (!rres?.success) { await this.toast(rres?.error || "Rename failed"); return; }
    }
    const res = await apiPost.call(this, "/save-prompt", this.payload(cat, name));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.CONTENT,
        detail: this.detailFromPromptLibrary(promptData, cat, name, d),
      });
      this.selKey = this.keyOf(cat, name);
      this.orig = { category: cat, name, profileId: this.effectiveProfileId() };
      if (wasDraft) {
        this.writePvDraft(null);
        this.setSerializableProperty("pmDraftSelected", false);
      }
      const it = this.findByKey(this.selKey);
      if (!hadOrig || renamed) {
        // New prompt or a rename/category move changes list membership, so the
        // info panel is rebuilt anyway — safe to swap the draft object.
        if (it) {
          this.setSavedPromptDetail(it, d);
          this.draft = { ...this._savedPromptDetail };
          this.syncWidgetsFromDraft();
        }
        // Follow a category move (via the InfoPanel category field) into the new
        // category so the selected card stays visible + in focus. Set before the
        // rebuild so refreshAll reflects the new active category.
        if (movedCategory) this.followSelectionCategory(cat);
        this.refreshAll({ preserveScroll: true });
        this.scrollSelectionIntoView?.();   // rename/category-move can re-sort the card
      } else {
        // Plain in-place save: the info panel is NOT re-rendered (to avoid the
        // thumbnail flicker), so its inputs still reference the current draft
        // object. Update that object in place instead of replacing it — a new
        // object would leave the inputs bound to an orphaned draft, so further
        // edits wouldn't register as modified, wouldn't save, and would be lost
        // on switching prompts.
        if (it) {
          this.setSavedPromptDetail(it, d);
          Object.assign(this.draft, this._savedPromptDetail);
          this.syncWidgetsFromDraft();
        }
        this.updateModifiedBadge();
        this.refreshDateMeta();   // reflect the new Date Modified without a rebuild
      }
      // The saved content is now the global version — re-baseline so a later save
      // from another node reads as Stale (not Modified) here.
      this.captureRecordBaseline();
    } else {
      await this.toast((res && res.error) || "Save failed");
    }
  },

  payload(cat, name) {
    const d = this.draft;
    return this.payloadFromRecord(cat, name, d);
  },

  payloadFromRecord(cat, name, record) {
    return {
      category: cat, name, text: record.prompt || "", ll_preset: record.llPreset || "", ll_preset_label: record.llPresetLabel || "",
      kitPresets: normalizeKitPresets(record.kitPresets),
      model: record.model || "", notes: record.notes || "",
      promptB: record.promptB || "", appendPromptB: !!record.appendPromptB,
      replaceFind: record.replaceFind || "", replaceWith: record.replaceWith || "",
      cardColor: record.cardColor || "",
      favorite: !!record.favorite, rating: Number(record.rating) || 0, nsfw: !!record.nsfw, pinned: !!record.pinned,
      customBadge: record.customBadge || "",
      hasThumb: !!record.hasThumb,
      thumbType: record.thumbType || "",
      thumbHasPoster: !!record.thumbHasPoster,
      id: record.id || undefined,
    };
  },

  async savePromptRecord(record = this.savedForDraft() || this.draft) {
    this._browserSelectionUI?.endForEdit();
    if (!this.orig || !record) return null;
    const detail = await this.ensurePromptDetail?.(record);
    const payloadRecord = this.draftFromSummaryAndText(
      record,
      detail || this.savedDetailForDraft?.() || this.draft || record,
    );
    this._lastPromptSaveTextSource = payloadRecord;
    const res = await apiPost.call(this, "/save-prompt", {
      ...this.payloadFromRecord(this.orig.category, this.orig.name, payloadRecord),
    });
    if (!(res && res.success)) this._lastPromptSaveTextSource = null;
    return res;
  },

  reconcilePromptSave(res, publishOptions = {}) {
    if (!(res && res.success)) return null;
    this.publishPromptLibrary(res.prompts || this.data, publishOptions);
    if (this.orig && this.draft) {
      const current = this.savedForDraft();
      if (current) {
        this.setSavedPromptDetail(current, this._lastPromptSaveTextSource || this.draft);
      }
    }
    this._lastPromptSaveTextSource = null;
    return this.savedForDraft();
  },

  async quickPersist() {
    if (!this.orig || !this.draft) return;
    await this.ensurePromptDetail?.(this.draft);
    const res = await apiPost.call(this, "/save-prompt", this.payload(this.orig.category, this.orig.name));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.CONTENT,
        detail: this.detailFromPromptLibrary(promptData, this.orig.category, this.orig.name, this.draft),
      });
      const it = this.findByKey(this.selKey);
      if (it) {
        this.setSavedPromptDetail(it, this.draft);
        this.draft = { ...this._savedPromptDetail };
      }
      this.captureRecordBaseline();
      this.refreshAll({ preserveScroll: true });
      this.scrollSelectionIntoView?.();   // modified-date sort bumps the card on save
    } else {
      this.toast((res && res.error) || "Save failed");
    }
  },

  async togglePromptFlag(flag) {
    if (this.profileMismatch?.() || this.profileMissing?.()) return;
    this._browserSelectionUI?.endForEdit();
    if (!this.draft) return;
    if (flag === "pinned" && !this.orig) { this.toast("Save before pinning"); return; }
    if (flag === "pinned" && !this.draft.pinned && this.pinnedItems().length >= MAX_PINNED) {
      this.toast(`Only ${MAX_PINNED} prompts can be pinned — unpin one first`);
      return;
    }
    const needsListRefresh = () => flag === "pinned" || this.sortUsesModifiedDate() ||
      (flag === "favorite" && this.favOnly) ||
      (flag === "nsfw" && this.shouldHideNSFW());
    const saved = this.savedForDraft();
    let response = null;
    await optimisticBooleanFlag({
      current: this.draft[flag],
      apply: (value) => {
        this.draft[flag] = value;
        if (saved) saved[flag] = value;
        // saved is an item copy in this.items mutated in place (no flatten), so
        // invalidate the filtered() memo — the flag can change pin order / badges.
        this._itemsVersion = (this._itemsVersion || 0) + 1;
        // NSFW changes the card thumbnail's blur, which the in-place meta patch
        // (updateCardMeta) doesn't touch — force a full card rebuild so the blur
        // updates on the spot in blur mode (hide mode already does a list refresh).
        const listRefreshed = needsListRefresh();
        this.refreshPromptMutation({ list: listRefreshed, replaceCard: flag === "nsfw" });
        // Pinning (and any list-reordering toggle) can move the selected card out of
        // view — follow it. No-ops when the card was filtered out (favOnly / NSFW-hide).
        if (listRefreshed) this.scrollSelectionIntoView?.();
      },
      persist: this.orig ? async () => {
        response = await this.savePromptRecord(saved || this.draft);
        return response;
      } : null,
      onPersisted: (res) => {
        if (!(res && res.success)) return false;
        const promptData = res.prompts || this.data;
        const refreshed = this.reconcilePromptSave(res, {
          lane: KRC_SYNC_LANES.METADATA,
          detail: this.detailFromPromptLibrary(promptData, this.orig.category, this.orig.name, saved || this.draft),
        });
        if (refreshed && this.draft) {
          this.draft.favorite = !!refreshed.favorite;
          this.draft.nsfw = !!refreshed.nsfw;
          this.draft.pinned = !!refreshed.pinned;
          this.draft.dateAdded = refreshed.dateAdded || this.draft.dateAdded;
          this.draft.dateModified = refreshed.dateModified || this.draft.dateModified;
        }
        if (this.sortUsesModifiedDate()) {
          this.refreshPromptList();
          this.scrollSelectionIntoView?.();   // server dateModified re-sorted the card
        }
        return true;
      },
      onError: () => this.toast((response && response.error) || "Save failed"),
    });
  },

  async setPromptCardColor(value) {
    if (this.profileMismatch?.() || this.profileMissing?.()) return;
    if (!this.draft) return;
    const next = normalizeCardColorId(value);
    const saved = this.savedForDraft();
    const savedDetail = saved ? await this.ensurePromptDetail?.(saved) : null;
    const target = this.orig ? { ...this.orig } : null;
    const targetKey = target ? this.keyOf(target.category, target.name) : "";
    const snapshot = this.applyPromptCardColorState(next);
    this._itemsVersion = (this._itemsVersion || 0) + 1;
    this.refreshSelectedPromptCard();
    this.updateModifiedBadge();

    if (!target || !saved) return;
    const payloadRecord = this.draftFromSummaryAndText(saved, savedDetail || this.savedDetailForDraft?.() || this.draft || saved);
    const res = await apiPost.call(this, "/save-prompt", this.payloadFromRecord(target.category, target.name, payloadRecord));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.METADATA,
        detail: this.detailFromPromptLibrary(promptData, target.category, target.name, payloadRecord),
      });
      const refreshed = this.findByKey(targetKey);
      if (refreshed && this.selKey === targetKey && this.draft) {
        this.setSavedPromptDetail(refreshed, payloadRecord);
        this.draft.cardColor = refreshed.cardColor || "";
        this.draft.dateAdded = refreshed.dateAdded || this.draft.dateAdded;
        this.draft.dateModified = refreshed.dateModified || this.draft.dateModified;
      }
      if (this.selKey === targetKey) this.refreshSelectedPromptCard();
      else this.refreshPromptCard(targetKey, refreshed);
      this.updateModifiedBadge();
    } else {
      if (this.selKey === targetKey) this.restorePromptCardColorState(snapshot);
      else {
        const stale = this.findByKey(targetKey);
        if (stale) stale.cardColor = snapshot.saved || "";
        const bucket = this.data?.[target.category]?.[target.name];
        if (bucket) bucket.cardColor = snapshot.data || "";
      }
      this._itemsVersion = (this._itemsVersion || 0) + 1;
      if (this.selKey === targetKey) this.refreshSelectedPromptCard();
      else this.refreshPromptCard(targetKey);
      this.updateModifiedBadge();
      if (this.selKey === targetKey) this.refreshInfoPanel();
      this.toast((res && res.error) || "Color save failed");
    }
  },

  async quickTogglePromptCardFlag(item, flag) {
    this._browserSelectionUI?.endForEdit();
    if (!item || item.__draft || !item.category || !item.name) return;
    if (!["favorite", "pinned", "nsfw"].includes(flag)) return;
    if (flag === "pinned" && !item.pinned && this.pinnedItems().length >= MAX_PINNED) {
      this.toast(`Only ${MAX_PINNED} prompts can be pinned — unpin one first`);
      return;
    }

    const key = this.keyOf(item.category, item.name);
    const selected = key === this.selKey;
    const previous = !!item[flag];
    const next = !previous;
    const apply = (value) => {
      item[flag] = value;
      const dataRecord = this.data?.[item.category]?.[item.name];
      if (dataRecord) dataRecord[flag] = value;
      if (selected && this.draft) this.draft[flag] = value;
      if (selected && this._savedPromptDetail) this._savedPromptDetail[flag] = value;
      this._itemsVersion = (this._itemsVersion || 0) + 1;
      const list = flag === "pinned" || (flag === "favorite" && this.favOnly) || (flag === "nsfw" && this.shouldHideNSFW());
      if (list) this.refreshPromptList();
      else this.refreshPromptCard(key, item, selected && this.isModified(), { replace: flag === "nsfw" });
      if (selected) this.refreshInfoPanel();
    };

    apply(next);
    const detail = await this.ensurePromptDetail?.(item);
    const payloadRecord = this.draftFromSummaryAndText(item, detail || item);
    const res = await apiPost.call(this, "/save-prompt", this.payloadFromRecord(item.category, item.name, payloadRecord));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.METADATA,
        detail: this.detailFromPromptLibrary(promptData, item.category, item.name, payloadRecord),
      });
      const refreshed = this.findByKey(key);
      if (refreshed && selected && this.draft) {
        this.setSavedPromptDetail(refreshed, payloadRecord);
        this.draft[flag] = !!refreshed[flag];
        this.draft.dateAdded = refreshed.dateAdded || this.draft.dateAdded;
        this.draft.dateModified = refreshed.dateModified || this.draft.dateModified;
        this.captureRecordBaseline();
      }
      if (this.sortUsesModifiedDate() || flag === "pinned") this.refreshPromptList();
      else this.refreshPromptCard(key, refreshed || item, selected && this.isModified(), { replace: flag === "nsfw" });
      if (selected) this.refreshInfoPanel();
      return;
    }

    apply(previous);
    this.toast((res && res.error) || "Save failed");
  },

  async quickSetPromptCardColor(item, value) {
    this._browserSelectionUI?.endForEdit();
    if (!item || item.__draft || !item.category || !item.name) return;
    const key = this.keyOf(item.category, item.name);
    const selected = key === this.selKey;
    const next = normalizeCardColorId(value);
    const previous = item.cardColor || "";
    const dataRecord = this.data?.[item.category]?.[item.name];
    const previousData = dataRecord?.cardColor || "";
    const previousDraft = this.draft?.cardColor || "";
    const previousSavedDetail = this._savedPromptDetail?.cardColor || "";

    item.cardColor = next;
    if (dataRecord) dataRecord.cardColor = next;
    if (selected && this.draft) this.draft.cardColor = next;
    if (selected && this._savedPromptDetail) this._savedPromptDetail.cardColor = next;
    this._itemsVersion = (this._itemsVersion || 0) + 1;
    this.refreshPromptCard(key, item, selected && this.isModified());
    if (selected) this.refreshInfoPanel();

    const detail = await this.ensurePromptDetail?.(item);
    const payloadRecord = this.draftFromSummaryAndText(item, detail || item);
    const res = await apiPost.call(this, "/save-prompt", this.payloadFromRecord(item.category, item.name, payloadRecord));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.METADATA,
        detail: this.detailFromPromptLibrary(promptData, item.category, item.name, payloadRecord),
      });
      const refreshed = this.findByKey(key);
      if (refreshed && selected && this.draft) {
        this.setSavedPromptDetail(refreshed, payloadRecord);
        this.draft.cardColor = refreshed.cardColor || "";
        this.draft.dateAdded = refreshed.dateAdded || this.draft.dateAdded;
        this.draft.dateModified = refreshed.dateModified || this.draft.dateModified;
        this.captureRecordBaseline();
      }
      this.refreshPromptCard(key, refreshed || item, selected && this.isModified());
      if (selected) this.refreshInfoPanel();
      return;
    }

    item.cardColor = previous;
    if (dataRecord) dataRecord.cardColor = previousData;
    if (selected && this.draft) this.draft.cardColor = previousDraft;
    if (selected && this._savedPromptDetail) this._savedPromptDetail.cardColor = previousSavedDetail;
    this._itemsVersion = (this._itemsVersion || 0) + 1;
    this.refreshPromptCard(key, item, selected && this.isModified());
    if (selected) this.refreshInfoPanel();
    this.toast((res && res.error) || "Color save failed");
  },

  async quickSetPromptCustomBadge(item, value) {
    this._browserSelectionUI?.endForEdit();
    if (!item || item.__draft || !item.category || !item.name) return;
    const key = this.keyOf(item.category, item.name);
    const selected = key === this.selKey;
    const next = value || "";
    const previous = item.customBadge || "";
    const dataRecord = this.data?.[item.category]?.[item.name];
    const previousData = dataRecord?.customBadge || "";
    const previousDraft = this.draft?.customBadge || "";
    const previousSavedDetail = this._savedPromptDetail?.customBadge || "";

    item.customBadge = next;
    if (dataRecord) dataRecord.customBadge = next;
    if (selected && this.draft) this.draft.customBadge = next;
    if (selected && this._savedPromptDetail) this._savedPromptDetail.customBadge = next;
    this._itemsVersion = (this._itemsVersion || 0) + 1;
    this.refreshPromptCard(key, item, selected && this.isModified());
    if (selected) this.refreshInfoPanel();

    const detail = await this.ensurePromptDetail?.(item);
    const payloadRecord = this.draftFromSummaryAndText(item, detail || item);
    const res = await apiPost.call(this, "/save-prompt", this.payloadFromRecord(item.category, item.name, payloadRecord));
    if (res && res.success) {
      const promptData = res.prompts || this.data;
      this.publishPromptLibrary(promptData, {
        lane: KRC_SYNC_LANES.METADATA,
        detail: this.detailFromPromptLibrary(promptData, item.category, item.name, payloadRecord),
      });
      const refreshed = this.findByKey(key);
      if (refreshed && selected && this.draft) {
        this.setSavedPromptDetail(refreshed, payloadRecord);
        this.draft.customBadge = refreshed.customBadge || "";
        this.draft.dateAdded = refreshed.dateAdded || this.draft.dateAdded;
        this.draft.dateModified = refreshed.dateModified || this.draft.dateModified;
        this.captureRecordBaseline();
      }
      this.refreshPromptCard(key, refreshed || item, selected && this.isModified());
      if (selected) this.refreshInfoPanel();
      return;
    }

    item.customBadge = previous;
    if (dataRecord) dataRecord.customBadge = previousData;
    if (selected && this.draft) this.draft.customBadge = previousDraft;
    if (selected && this._savedPromptDetail) this._savedPromptDetail.customBadge = previousSavedDetail;
    this._itemsVersion = (this._itemsVersion || 0) + 1;
    this.refreshPromptCard(key, item, selected && this.isModified());
    if (selected) this.refreshInfoPanel();
    this.toast((res && res.error) || "Badge save failed");
  },

  async duplicate() {
    if (this.profileMismatch?.() || this.profileMissing?.()) return;
    if (!this.orig || !this.draft) return;
    await this.ensurePromptDetail?.(this.draft);
    const base = this.draft.name || "prompt";
    const bucket = this.data[this.orig.category] || {};
    let nn = `${base} copy`, i = 2;
    while (Object.keys(bucket).some(k => k.toLowerCase() === nn.toLowerCase())) nn = `${base} copy ${i++}`;
    const sourceThumbId = this.draft.hasThumb && this.draft.id ? this.draft.id : null;
    const res = await apiPost.call(this, "/save-prompt", {
      category: this.orig.category, name: nn,
      text: this.draft.prompt || "", ll_preset: this.draft.llPreset || "", ll_preset_label: this.draft.llPresetLabel || "", model: this.draft.model || "",
      kitPresets: normalizeKitPresets(this.draft.kitPresets),
      notes: this.draft.notes || "",
      promptB: this.draft.promptB || "", appendPromptB: !!this.draft.appendPromptB,
      replaceFind: this.draft.replaceFind || "", replaceWith: this.draft.replaceWith || "",
      cardColor: this.draft.cardColor || "",
      favorite: !!this.draft.favorite, rating: Number(this.draft.rating) || 0, nsfw: !!this.draft.nsfw,
      customBadge: this.draft.customBadge || "",
    });  // new record → fresh id; thumbnail is copied below when present
    if (res && res.success) {
      this.publishPromptLibrary(res.prompts || this.data);
      this.selKey = this.keyOf(this.orig.category, nn);
      this.orig = { category: this.orig.category, name: nn, profileId: this.effectiveProfileId() };
      const it = this.findByKey(this.selKey);
      if (it) {
        this.setSavedPromptDetail(it, this.draft);
        this.draft = { ...this._savedPromptDetail };
        this.syncWidgetsFromDraft();
      }
      if (sourceThumbId && this.draft?.id) {
        const thumbRes = await apiPost.call(this, "/copy-thumbnail", {
          source_id: sourceThumbId,
          category: this.orig.category,
          name: nn,
        });
        if (thumbRes && thumbRes.success) {
          this.publishPromptLibrary(thumbRes.prompts || this.data);
          const copied = this.findByKey(this.selKey);
          if (copied) {
            this.setSavedPromptDetail(copied, this.draft);
            this.draft = { ...this._savedPromptDetail };
          }
        } else {
          this.toast((thumbRes && thumbRes.error) || "Thumbnail copy failed");
        }
      }
      this.captureRecordBaseline();
      this.refreshPromptList();
      this.refreshInfoPanel();
      this.scrollSelectionIntoView?.();
    } else this.toast((res && res.error) || "Duplicate failed");
  },

  async copyPromptCardText(item, field = "prompt") {
    if (!item || item.__draft) return;
    const detail = await this.ensurePromptDetail?.(item);
    const source = detail || item;
    const text = field === "promptB" ? (source.promptB || "") : (source.prompt || "");
    this.copyText(text);
    this.toast(field === "promptB" ? "Copied Prompt B" : "Copied Prompt A");
  },

  async duplicatePromptCard(item) {
    if (!item || item.__draft || !item.category || !item.name) return;
    const detail = await this.ensurePromptDetail?.(item);
    const source = {
      ...this.draftFromSummaryAndText(item, detail || item),
      id: "",
      hasThumb: false,
      thumbType: "",
      thumbHasPoster: false,
      pinned: false,
    };
    const category = item.category;
    const bucket = this.data?.[category] || {};
    const base = item.name || "prompt";
    let name = `${base} copy`, i = 2;
    while (Object.keys(bucket).some(k => k.toLowerCase() === name.toLowerCase())) name = `${base} copy ${i++}`;
    const sourceThumbId = item.hasThumb && item.id ? item.id : null;

    const res = await apiPost.call(this, "/save-prompt", this.payloadFromRecord(category, name, source));
    if (!res?.success) {
      this.toast((res && res.error) || "Duplicate failed");
      return;
    }

    this.publishPromptLibrary(res.prompts || this.data);
    const newKey = this.keyOf(category, name);
    this.selKey = newKey;
    this.orig = { category, name, profileId: this.effectiveProfileId() };
    const created = this.findByKey(newKey);
    if (created) {
      this.setSavedPromptDetail(created, source);
      this.draft = { ...this._savedPromptDetail };
      this.syncWidgetsFromDraft();
    }

    if (sourceThumbId && this.draft?.id) {
      const thumbRes = await apiPost.call(this, "/copy-thumbnail", {
        source_id: sourceThumbId,
        category,
        name,
      });
      if (thumbRes?.success) {
        this.publishPromptLibrary(thumbRes.prompts || this.data);
        const copied = this.findByKey(newKey);
        if (copied) {
          this.setSavedPromptDetail(copied, this.draft);
          this.draft = { ...this._savedPromptDetail };
        }
      } else {
        this.toast((thumbRes && thumbRes.error) || "Thumbnail copy failed");
      }
    }

    this.captureRecordBaseline();
    this.refreshPromptList();
    this.refreshInfoPanel();
    this.scrollSelectionIntoView?.();
  },

  async renamePromptCard(item, nextName) {
    if (!item || item.__draft || !item.category || !item.name) return false;
    const name = String(nextName || "").trim();
    if (!name) {
      this.toast("Name is required");
      return false;
    }
    if (name === item.name) return true;

    const oldKey = this.keyOf(item.category, item.name);
    const wasSelected = oldKey === this.selKey;
    // Name collision → ask before overwriting (anchored popover). Cancel aborts the
    // rename entirely, leaving the original untouched.
    let overwrite = false;
    if (this.promptExists(item.category, name, oldKey)) {
      overwrite = await this.confirmOverwritePopover(oldKey, item.category, name);
      if (!overwrite) return false;
    }
    const res = await apiPost.call(this, "/rename-prompt", {
      category: item.category,
      old_name: item.name,
      new_name: name,
      new_category: item.category,
      overwrite,
    });
    if (!res?.success) {
      this.toast((res && res.error) || "Rename failed");
      return false;
    }

    this.publishPromptLibrary(res.prompts || this.data);
    const newCategory = res.new_category || item.category;
    const newName = res.new_name || name;
    const newKey = this.keyOf(newCategory, newName);
    if (wasSelected) {
      this.selKey = newKey;
      this.orig = { category: newCategory, name: newName, profileId: this.effectiveProfileId() };
      const renamed = this.findByKey(newKey);
      if (renamed && this.draft) {
        this.draft.category = newCategory;
        this.draft.name = newName;
        this.setSavedPromptDetail(renamed, this.draft);
        this.draft = { ...this._savedPromptDetail };
        this.syncWidgetsFromDraft();
        this.captureRecordBaseline();
      }
    }
    this.refreshPromptList();
    if (wasSelected) {
      this.refreshInfoPanel();
      this.scrollSelectionIntoView?.();   // the new name may sort elsewhere (az/za)
    }
    return true;
  },

  // Move a saved prompt to another category. Backend /rename-prompt does the move
  // (new_category, unchanged name); it blocks on a case-insensitive name collision in
  // the target and never overwrites. Reuses the rename reconcile: publish to siblings,
  // follow the selection/draft to the new key, refresh the (re-filtered) list, and
  // repaint chips if the category set changed (e.g. the source emptied out).
  async movePromptCard(item, targetCategory) {
    if (!item || item.__draft || !item.category || !item.name) return false;
    const target = String(targetCategory || "").trim();
    if (!target || target === item.category) return true;

    const oldKey = this.keyOf(item.category, item.name);
    const wasSelected = oldKey === this.selKey;
    const previousCategories = this.categories().join("");
    // Same-name prompt already in the target category → confirm overwrite; cancel aborts.
    let overwrite = false;
    if (this.promptExists(target, item.name, oldKey)) {
      overwrite = await this.confirmOverwritePopover(oldKey, target, item.name);
      if (!overwrite) return false;
    }
    const res = await apiPost.call(this, "/rename-prompt", {
      category: item.category,
      old_name: item.name,
      new_name: item.name,
      new_category: target,
      overwrite,
    });
    if (!res?.success) {
      this.toast((res && res.error) || "Move failed");
      return false;
    }

    this.publishPromptLibrary(res.prompts || this.data);
    const newCategory = res.new_category || target;
    const newName = res.new_name || item.name;
    const newKey = this.keyOf(newCategory, newName);
    let switchedCategory = false;
    if (wasSelected) {
      this.selKey = newKey;
      this.orig = { category: newCategory, name: newName, profileId: this.effectiveProfileId() };
      const moved = this.findByKey(newKey);
      if (moved && this.draft) {
        this.draft.category = newCategory;
        this.draft.name = newName;
        this.setSavedPromptDetail(moved, this.draft);
        this.draft = { ...this._savedPromptDetail };
        this.syncWidgetsFromDraft();
        this.captureRecordBaseline();
      }
      // Follow the moved (selected) prompt into its new category so its card stays
      // visible + in focus instead of vanishing from the filtered list.
      switchedCategory = this.followSelectionCategory(newCategory);
    }
    this.refreshPromptList();               // re-filters to the (possibly new) active category
    if (switchedCategory || this.categories().join("") !== previousCategories) this.renderChipsOnly();
    this.updateBrowserFooter();
    if (wasSelected) {
      this.refreshInfoPanel();
      this.scrollSelectionIntoView?.();
    }
    this.toast(`Moved to ${newCategory}`);
    return true;
  },

  // "+ New category" from the move picker: create the category (so the move's
  // new_category exists), then move into it. A brand-new category can't collide.
  async createCategoryAndMovePrompt(item, categoryName) {
    if (!item || item.__draft) return false;
    const name = String(categoryName || "").trim();
    if (!name) {
      this.toast("Category name is required");
      return false;
    }
    if (name === item.category) return true;
    // If it already exists (case-insensitive), skip creation and move straight in —
    // the move itself will surface any name collision in that category.
    const exists = this.categories().some((cat) => cat.toLowerCase() === name.toLowerCase());
    if (!exists) {
      const res = await apiPost.call(this, "/save-category", { category_name: name });
      if (!res?.success) {
        this.toast((res && res.error) || "Could not create category");
        return false;
      }
      this.publishPromptLibrary(res.prompts || this.data);
      this.renderChipsOnly();
    }
    return this.movePromptCard(item, name);
  },

  async deletePromptCard(item) {
    if (!item || item.__draft || !item.category || !item.name) return;
    const deletedKey = this.keyOf(item.category, item.name);
    const wasSelected = deletedKey === this.selKey;
    const previousCategories = this.categories().join("\u001f");
    const res = await apiPost.call(this, "/delete-prompt", { category: item.category, name: item.name });
    if (!res?.success) {
      this.toast((res && res.error) || "Delete failed");
      return false;
    }

    this.publishPromptLibrary(res.prompts || this.data);
    if (wasSelected) {
      this.selKey = null;
      this.orig = null;
      this.draft = null;
      this.clearPersistedDraft();
    }
    if (this.activeCategory !== "__all__" && !this.categories().includes(this.activeCategory)) {
      this.activeCategory = "__all__";
      if (this.node.properties) this.node.properties.pmActiveCategory = "__all__";
      this.refreshBrowserPanel();
    } else {
      this.removePromptCard(deletedKey);
      if (this.categories().join("\u001f") !== previousCategories) this.renderChipsOnly();
      this.updateBrowserFooter();
    }
    if (wasSelected) this.refreshInfoPanel();
    return true;
  },

  async doDelete() {
    if (this.profileMismatch?.() || this.profileMissing?.()) return;
    if (!this.orig) return;
    const deletedKey = this.keyOf(this.orig.category, this.orig.name);
    const previousCategories = this.categories().join("\u001f");
    const res = await apiPost.call(this, "/delete-prompt", { category: this.orig.category, name: this.orig.name });
    if (res && res.success) {
      this.publishPromptLibrary(res.prompts || this.data);
      this.selKey = null; this.orig = null; this.draft = null;
      this.clearPersistedDraft();   // don't restore the deleted prompt as a draft on reload
      if (this.activeCategory !== "__all__" && !this.categories().includes(this.activeCategory)) {
        this.activeCategory = "__all__";
        if (this.node.properties) this.node.properties.pmActiveCategory = "__all__";
        this.refreshBrowserPanel();
      } else {
        this.removePromptCard(deletedKey);
        if (this.categories().join("\u001f") !== previousCategories) this.renderChipsOnly();
        this.updateBrowserFooter();
      }
      this.refreshInfoPanel();
    } else this.toast((res && res.error) || "Delete failed");
  },

  disarmDelete() { this._deleteConfirm?.reset(); },

  // A category's export is the KRC bundle (UNIFIED_BUNDLE_GAMEPLAN.md): its Export dialog
  // starts with just this category ticked under Prompt Vault. (Import: Options' row,
  // shared/transfer/node_transfer_row.js.)
  exportCategory(category) {
    if (!category) return null;
    return openBundleExport({ node: this.node, promptProfile: this.effectiveProfileId(), only: ["prompt_vault"], picks: { prompt_vault: [category] } });
  }
};
