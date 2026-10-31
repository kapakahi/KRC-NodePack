import { normalizeCardColorId } from "../shared/card_colors.js";
import { fetchLora, getSharedJson, postLoraJson } from "./api.js";
import { setWidgetValue, widgetValue } from "./helpers.js";
import { makeMetadataApiMethods } from "../shared/metadata_state.js";
import { buildNormalizedMetadata, LORA_SNAPSHOT_FIELDS, isInstantOnlyFields } from "../shared/metadata_fields.js";
import { krcAlert } from "../shared/modal.js";

// Route/widget-bound twins of the shared metadata engine, injected with this node's
// own record route + HIDDEN_WIDGETS-bound widget accessors (see L3-2b).
const metadataApiMethods = makeMetadataApiMethods({ fetchLora, postLoraJson, getSharedJson, setWidgetValue, widgetValue });

export const infoPanelMetadataMethods = {
  ...metadataApiMethods,

  normalizedMetadata(record = {}) {
    // Field set/order is the single-source vocabulary in shared/metadata_fields.js.
    return buildNormalizedMetadata(record, LORA_SNAPSHOT_FIELDS);
  },

  commitSavedMetadata(selected, { fields = null } = {}) {
    if (!selected?.sha256) {
      return [];
    }
    // Re-baseline the LoRA against the just-saved values so it reads unmodified.
    // Instant affordance fields are outside the snapshot, so committing one must NOT
    // re-baseline the record — that would clear a coexisting unsaved text draft. Only
    // re-snapshot / drop the draft when a snapshot (text) field was actually saved.
    const sha = selected.sha256;
    if (!isInstantOnlyFields(fields)) {
      this.metadataSnapshots.set(sha, this.metadataSnapshotValue(selected));
      this.metadataBaselines?.delete(sha);
      this.updateCachedMetadataSnapshots();
      // Saved values are the new baseline, so the LoRA is no longer modified — drop its
      // persisted draft entry.
      this.captureMetadataDraft(sha);
    }
    this.broadcastMetadataChanged?.(selected, { affected: [sha], fields });
    return [sha];
  },

  discardMetadataDraft() {
    this.cancelMetadataDraftCapture();
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha);
    if (!selected?.sha256) {
      return;
    }
    const saved = this.metadataBaselines?.get(selected.sha256);
    if (!saved) {
      // No captured baseline to revert to — this is a stale-snapshot false positive
      // (the baseline is only captured while a LoRA is unmodified, so a stuck one
      // never got one). Clear the badge by re-baselining the dirty snapshot to the
      // current values instead of silently doing nothing.
      this.metadataSnapshots.set(selected.sha256, this.metadataSnapshotValue(selected));
      this.updateCachedMetadataSnapshots?.();
      this.captureMetadataDraft(selected.sha256);   // drop any draft entry
      this.updateModifiedIndicators();
      this.refreshLoraCard(selected.sha256);
      return;
    }
    const metadata = saved;
    selected.display_name = metadata.display_name || "";
    selected.baseModel = metadata.baseModel || "";
    selected.category = metadata.category || "";
    selected.description = metadata.description || "";
    selected.trainedWords = Array.isArray(metadata.trainedWords) ? [...metadata.trainedWords] : [];
    selected.examplePrompts = Array.isArray(metadata.examplePrompts) ? [...metadata.examplePrompts] : [];
    selected.notes = metadata.notes || "";

    this.captureMetadataDraft(selected.sha256);   // reverted → drop the draft entry
    this.updateModifiedIndicators();
    this.refreshLoraCard(selected.sha256);
    this.refreshStacks();
    this.refreshInfo();
  },

  async setLoraCardColor(selected, value) {
    this._browserSelectionUI?.endForEdit();
    if (!selected?.sha256) {
      return;
    }
    const next = normalizeCardColorId(value);
    const previous = selected.cardColor || "";
    selected.cardColor = next;
    this.invalidateVisibleLoras?.();
    this.refreshLoraCard(selected.sha256);
    this.refreshStacks();
    if (this.colorFilter) {
      this.refreshBrowser({ focusSelection: true });
    }
    this.updateModifiedIndicators();
    try {
      const response = await postLoraJson("/metadata", {
        sha256: selected.sha256,
        cardColor: next,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.commitSavedMetadata(selected, { fields: ["cardColor"] });
    } catch {
      selected.cardColor = previous;
      this.invalidateVisibleLoras?.();
      this.refreshLoraCard(selected.sha256);
      this.refreshStacks();
      if (this.colorFilter) {
        this.refreshBrowser({ focusSelection: true });
      }
      this.updateModifiedIndicators();
      this.refreshInfo();
      krcAlert("Could not save color. Check the ComfyUI server log.", this.node);
    }
  },

  async setLoraCustomBadge(selected, value) {
    this._browserSelectionUI?.endForEdit();
    if (!selected?.sha256) {
      return false;
    }
    const next = value || "";
    const previous = selected.customBadge || "";
    selected.customBadge = next;
    this.invalidateVisibleLoras?.();
    this.refreshLoraCard(selected.sha256);
    this.refreshInfoActions();
    try {
      const response = await postLoraJson("/metadata", {
        sha256: selected.sha256,
        customBadge: next,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.commitSavedMetadata(selected, { fields: ["customBadge"] });
      return true;
    } catch {
      selected.customBadge = previous;
      this.invalidateVisibleLoras?.();
      this.refreshLoraCard(selected.sha256);
      this.refreshInfoActions();
      krcAlert("Could not save custom badge. Check the ComfyUI server log.", this.node);
      return false;
    }
  },

  async renameLoraCard(selected, value) {
    if (!selected?.sha256) {
      return false;
    }
    const next = String(value || "").trim();
    if (!next) {
      return false;
    }
    const previousName = selected.display_name || "";
    const previousHasName = !!selected.hasName;
    selected.display_name = next;
    selected.hasName = true;
    this.invalidateVisibleLoras?.();
    this.refreshLoraCard(selected.sha256);
    this.refreshStacks();
    this.updateModifiedIndicators();
    try {
      const response = await postLoraJson("/metadata", {
        sha256: selected.sha256,
        name: next,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      this.commitSavedMetadata(selected, { fields: ["display_name", "hasName"] });
      this.refreshInfo();
      return true;
    } catch {
      selected.display_name = previousName;
      selected.hasName = previousHasName;
      this.invalidateVisibleLoras?.();
      this.refreshLoraCard(selected.sha256);
      this.refreshStacks();
      this.updateModifiedIndicators();
      this.refreshInfo();
      krcAlert("Could not rename LoRA. Check the ComfyUI server log.", this.node);
      return false;
    }
  },

  writeMetadataFlag(selected, key, value) {
    return postLoraJson("/metadata", {
      sha256: selected.sha256,
      [key]: value,
    });
  },

  applySharedFlag(selected, key, value) {
    if (selected) selected[key] = value;
    this.invalidateVisibleLoras?.();
  },

  refreshMetadataSurfaces(key) {
    const sha = this.selectedSha;
    // Patch the affected library card (star / nsfw badge) in place.
    if (sha) {
      this.refreshLoraCard(sha);
    }
    // The browser list only changes membership when a matching filter is on:
    // favorites while the favorites filter is active, or tagging NSFW while
    // NSFW items are hidden.
    // A pin moves the card to (or from) the top.
    const affectsVisibility = key === "pinned" || (key === "favorite" ? this.showFavorites : this.shouldHideNsfw?.());
    if (affectsVisibility) {
      this.refreshBrowser({ focusSelection: true });
    }
    // Slots show a ★ prefix for favorites; only rebuild stacks if this LoRA is
    // actually in one.
    if (sha && ["A", "B"].some((stackId) => this.stacks[stackId].some((entry) => entry.sha256 === sha))) {
      this.refreshStacks();
    }
    // Update only the info-panel action buttons (their active state changed),
    // not the whole panel.
    this.refreshInfoActions();
    // NSFW also drives the info-panel thumbnail blur; the card already re-renders
    // via refreshLoraCard, but the info thumb needs its own re-render.
    if (key === "nsfw") {
      this.refreshInfoThumb();
    }
  },
};
