import { normalizeCardColorId } from "../shared/card_colors.js";
import { fetchLora, getSharedJson, postLoraJson } from "./api.js";
import { setWidgetValue, widgetValue } from "./helpers.js";
import { makeMetadataApiMethods } from "../shared/metadata_state.js";
import { buildNormalizedMetadata, MODEL_SNAPSHOT_FIELDS, MODEL_REVERT_FIELDS, isInstantOnlyFields } from "../shared/metadata_fields.js";
import { krcAlert } from "../shared/modal.js";

// Route/widget-bound twins of the shared metadata engine, injected with this node's
// own record route + HIDDEN_WIDGETS-bound widget accessors (see L3-2b).
const metadataApiMethods = makeMetadataApiMethods({ fetchLora, postLoraJson, getSharedJson, setWidgetValue, widgetValue });

export const infoPanelMetadataMethods = {
  ...metadataApiMethods,

  isGenericModel(record) {
    return !!record && record.modelType !== "lora";
  },

  normalizedMetadata(record = {}) {
    // Model lineage: lora snapshot fields + model classification/provenance extras.
    // Field set/order is the single-source vocabulary in shared/metadata_fields.js.
    return buildNormalizedMetadata(record, MODEL_SNAPSHOT_FIELDS);
  },

  commitSavedMetadata(selected, { fields = null } = {}) {
    if (!selected?.sha256) {
      return [];
    }
    // Instant affordance fields are outside the snapshot, so committing one must NOT
    // re-baseline the record — that would clear a coexisting unsaved text draft. Only
    // re-snapshot / drop drafts when a snapshot (text) field was actually saved.
    // A model or LoRA re-baselines against the just-saved values so it reads unmodified.
    const sha = selected.sha256;
    if (!isInstantOnlyFields(fields)) {
      this.metadataSnapshots.set(sha, this.metadataSnapshotValue(selected));
      this.metadataBaselines?.delete(sha);
      this.updateCachedMetadataSnapshots();
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
    if (this.isGenericModel(selected)) {
      MODEL_REVERT_FIELDS.forEach((key) => {
        selected[key] = metadata[key] || "";
      });
      selected.tags = Array.isArray(metadata.tags) ? [...metadata.tags] : [];
      this.captureMetadataDraft(selected.sha256);
      this.updateModifiedIndicators();
      this.refreshLoraCard(selected.sha256);
      this.refreshInfo();
      return;
    }
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
    if (this.isGenericModel(selected)) {
      this.invalidateVisibleLoras?.();
      this.refreshLoraCard(selected.sha256);
      if (this.colorFilter) {
        this.refreshBrowser({ focusSelection: true });
      }
      this.updateModifiedIndicators();
      try {
        await this.writeModelMetadata(selected, { cardColor: next });
        this.commitSavedMetadata(selected, { fields: ["cardColor"] });
        this.updateModifiedIndicators();
      } catch {
        selected.cardColor = previous;
        this.invalidateVisibleLoras?.();
        this.refreshLoraCard(selected.sha256);
        if (this.colorFilter) {
          this.refreshBrowser({ focusSelection: true });
        }
        this.updateModifiedIndicators();
        this.refreshInfo();
        krcAlert("Could not save color. Check the ComfyUI server log.", this.node);
      }
      return;
    }
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
      this.updateModifiedIndicators();
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
      if (this.isGenericModel(selected)) {
        await this.writeModelMetadata(selected, { customBadge: next });
      } else {
        const response = await postLoraJson("/metadata", {
          sha256: selected.sha256,
          customBadge: next,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
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
    this.refreshStacks?.();
    this.updateModifiedIndicators();
    try {
      if (this.isGenericModel(selected)) {
        await this.writeModelMetadata(selected, { name: next });
      } else {
        const response = await postLoraJson("/metadata", {
          sha256: selected.sha256,
          name: next,
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
      }
      this.commitSavedMetadata(selected, { fields: ["display_name", "hasName"] });
      this.refreshInfo();
      return true;
    } catch {
      selected.display_name = previousName;
      selected.hasName = previousHasName;
      this.invalidateVisibleLoras?.();
      this.refreshLoraCard(selected.sha256);
      this.refreshStacks?.();
      this.updateModifiedIndicators();
      this.refreshInfo();
      krcAlert("Could not rename model. Check the ComfyUI server log.", this.node);
      return false;
    }
  },

  writeMetadataFlag(selected, key, value) {
    if (this.isGenericModel(selected)) {
      return this.writeModelMetadata(selected, { [key]: value }).then((payload) => ({ ok: true, payload }));
    }
    return postLoraJson("/metadata", {
      sha256: selected.sha256,
      [key]: value,
    });
  },

  applySharedFlag(selected, key, value) {
    if (selected) selected[key] = value;
    this.invalidateVisibleLoras?.();
  },

  async writeModelMetadata(selected, patch = {}) {
    if (!selected?.sha256) {
      throw new Error("missing model id");
    }
    const metadata = {
      name: selected.display_name || "",
      modelType: selected.modelType || "other",
      family: selected.family || "",
      baseModel: selected.baseModel || "",
      architecture: selected.architecture || "",
      variant: selected.variant || "",
      role: selected.role || "",
      parameterCount: selected.parameterCount || "",
      quantization: selected.quantization || "",
      precision: selected.precision || "",
      version: selected.version || "",
      releaseDate: selected.releaseDate || "",
      baseModelReleaseDate: selected.baseModelReleaseDate || "",
      license: selected.license || "",
      description: selected.description || "",
      notes: selected.notes || "",
      cardColor: selected.cardColor || "",
      customBadge: selected.customBadge || "",
      favorite: Boolean(selected.favorite),
      pinned: Boolean(selected.pinned),
      nsfw: Boolean(selected.nsfw),
      nsfwLevel: Number(selected.nsfwLevel) || 0,
      tags: selected.tags || [],
      creatorName: selected.creatorName || "",
      companyName: selected.companyName || "",
      sourceName: selected.sourceName || "",
      ...patch,
    };
    const response = await postLoraJson(`/metadata/${encodeURIComponent(selected.sha256)}`, {
      path: selected.path || "",
      relative_path: selected.relativePath || selected.relative_path || selected.filename || "",
      filename: selected.filename || "",
      metadata,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const payload = await response.json().catch(() => ({}));
    const record = payload?.record || {};
    Object.assign(selected, {
      display_name: record.name || selected.display_name || selected.filename || "",
      // Mirror the server's hasName (= bool(name)); browserLabel's title mode only
      // shows display_name when hasName is truthy, so without this the card keeps
      // rendering the filename until the next full library fetch.
      hasName: !!record.name,
      modelType: record.modelType || selected.modelType || "other",
      family: record.family || "",
      baseModel: record.baseModel || "",
      architecture: record.architecture || "",
      variant: record.variant || "",
      role: record.role || "",
      parameterCount: record.parameterCount || "",
      quantization: record.quantization || "",
      precision: record.precision || "",
      version: record.version || "",
      releaseDate: record.releaseDate || "",
      baseModelReleaseDate: record.baseModelReleaseDate || "",
      license: record.license || "",
      description: record.description || "",
      notes: record.notes || "",
      cardColor: record.cardColor || "",
      customBadge: record.customBadge || "",
      favorite: Boolean(record.favorite),
      pinned: Boolean(record.pinned),
      nsfw: Boolean(record.nsfw),
      nsfwLevel: Number(record.nsfwLevel) || 0,
      tags: Array.isArray(record.tags) ? record.tags : [],
      creatorName: record.creator?.name || record.creator?.username || selected.creatorName || "",
      companyName: record.organization?.name || selected.companyName || "",
      sourceName: record.source?.name || selected.sourceName || "",
    });
    // A saved edit is durable data on a possibly path-derived record — promote it to a
    // stable SHA256 id so it survives a move/rename (no-op if already stable).
    this.autoStabilizeAfterPersist?.(selected.sha256);
    return payload;
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
