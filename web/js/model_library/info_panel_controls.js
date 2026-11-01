import { createCardColorButton } from "../shared/card_color_button.js";
import { isVideoFile } from "../shared/files.js";
import { installMediaThumbnailDrop } from "../shared/media_thumbnail_drop.js";
import { applyStabilizeGlow } from "../shared/stabilize_glow.js";
import { renderVerificationShield } from "../shared/verification_shield.js";
import { copyText } from "../shared/clipboard.js";
import { switchToggle } from "../shared/browser_controls.js";
import { thumbnailBox } from "../shared/browser_cards.js";
import { krcAlert, openKrcModal, krcModalSection, openKrcConfirm } from "../shared/modal.js";
import { buildNodePaletteField, portalPaletteNote } from "../shared/node_palette.js";
import { nodeTransferRow } from "../shared/transfer/node_transfer_row.js";
import { thumbnailControlRow } from "../shared/thumbnail_controls.js";
import { renderInfoPanel } from "../shared/info_panel.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";
import { closeFloatingMenu, toggleFloatingMenu } from "../shared/floating_menu.js";
import { clearKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { libraryThumbnailUrl } from "./api.js";
import { stopCanvasEvents } from "./helpers.js";
import { openTrainedWordPopover } from "../shared/trained_words_popover.js";


export const infoPanelControlMethods = {

  // The info-panel thumbnail, extracted so an NSFW toggle can re-render just the
  // thumb (blur state) without rebuilding the whole info panel. See refreshInfoThumb.
  renderInfoThumb(selected) {
    const isVideoThumb = selected?.thumbnailType === "video";
    const blurNsfw = this.shouldBlurNsfw?.(selected);
    const useAnimatedThumb = isVideoThumb && this.webmThumbnailsEnabled && !blurNsfw;
    const thumb = thumbnailBox({
      className: "krc-info-thumb",
      url: selected?.thumbnail
        ? this.thumbnailUrl(selected, useAnimatedThumb ? "animated" : (isVideoThumb && selected?.thumbnailHasPoster ? "poster" : ""))
        : "",
      draggable: false,
      mediaType: useAnimatedThumb ? "video" : "image",
      playOnHover: useAnimatedThumb,
      playOnce: useAnimatedThumb && this.webmThumbnailAutoplayEnabled,
      posterUrl: useAnimatedThumb && selected?.thumbnailHasPoster ? this.thumbnailUrl(selected, "poster") : "",
      placeholderKind: selected?.previewWithheld && !selected?.thumbnail
        ? "nsfw"
        : (selected?.thumbnailNeedsPoster || isVideoThumb ? "video" : "image"),
      blurred: blurNsfw,
    });
    thumb.draggable = true;
    thumb.title = this.isGenericModel?.(selected) ? "Drag model" : "Drag into a stack slot";
    // A Media card dropped here becomes the thumbnail, like picking that file with UPLOAD.
    installMediaThumbnailDrop(thumb, {
      enabled: () => Boolean(selected?.sha256),
      onFile: (file) => (isVideoFile(file) ? this.uploadThumbnailVideo(selected, file) : this.uploadThumbnail(selected, file)),
      onError: (message) => krcAlert(message, this.node),
    });
    thumb.addEventListener("dragstart", (event) => {
      const dragSha = this.canonicalId?.(selected?.sha256) || selected?.sha256 || "";
      if (!dragSha) {
        event.preventDefault();
        return;
      }
      clearTimeout(this._stabilizeTimer);
      this.draggedSha = dragSha;
      this.root.classList.add("is-dragging-lora");
      const isGeneric = this.isGenericModel?.(selected);
      const thumbUrl = selected.thumbnail
        ? this.thumbnailUrl(selected, selected.thumbnailType === "video" && selected.thumbnailHasPoster ? "poster" : "")
        : "";
      setKrcDragPayload({
        kind: isGeneric ? "model" : "lora",
        id: dragSha,
        modelType: selected.modelType || "",
        path: selected.path || "",
        relativePath: selected.relativePath || selected.relative_path || "",
        file: selected.filename || "",
        title: selected.display_name || selected.filename || "",
        thumbnailUrl: thumbUrl,
        cardColor: this.effectiveLoraCardColor?.(selected) || selected.cardColor || "",
        favorite: Boolean(selected.favorite),
      });
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-krc-model", JSON.stringify({
        id: dragSha,
        kind: isGeneric ? "model" : "lora",
        modelType: selected.modelType || "",
        path: selected.path || "",
        relativePath: selected.relativePath || selected.relative_path || "",
        file: selected.filename || "",
        title: selected.display_name || selected.filename || "",
        thumbnailUrl: thumbUrl,
        cardColor: this.effectiveLoraCardColor?.(selected) || selected.cardColor || "",
        favorite: Boolean(selected.favorite),
      }));
      if (!isGeneric) {
        event.dataTransfer.setData("application/x-krc-lora", dragSha);
      }
      event.dataTransfer.setData("text/plain", dragSha);
    });
    thumb.addEventListener("dragend", () => {
      this.draggedSha = "";
      this.root.classList.remove("is-dragging-lora");
      clearKrcDragPayload();
      this.scheduleStabilize?.(this.selectedSha);
    });
    return thumb;
  },

  renderGenericModelInfo(selected) {
    return renderInfoPanel(this.modelInfoPanelSource(), selected);
  },

  // PanelSource descriptor for the generic (non-LoRA) model panel — the "model"
  // kind. Same shared shell as the shared LoRA panel (loraPanelSource); it differs
  // only in the panel class (krc-model-info), the ▲▼ labels, the richer subline
  // (source / release / creator rows), and the generic body columns.
  modelInfoPanelSource() {
    if (this._modelInfoPanelSource) return this._modelInfoPanelSource;
    const ctl = this;
    this._modelInfoPanelSource = {
      kind: "model",
      title: "Info Panel",
      panelClass: "krc-panel krc-info krc-model-info",
      cycleLabels: { prev: "Previous model", next: "Next model" },
      onCycle: (delta) => ctl.cycleSelection(delta),
      renderActions: (selected) => ctl.renderInfoActions(selected),
      renderName: (selected) => {
        const nameField = ctl.renderField("Name", selected?.display_name || "", (value) => {
          if (selected) {
            selected.display_name = value;
            ctl.markMetadataEdited();
          }
        }, { limitToVisible: true });
        nameField.classList.add("krc-info-name-field");
        return nameField;
      },
      renderSubline: (selected) => {
        const subline = document.createElement("div");
        subline.className = "krc-info-subline";
        const fileRow = document.createElement("div");
        fileRow.className = "krc-info-meta-row";
        const filename = document.createElement("span");
        filename.textContent = selected?.filename || "";
        const source = document.createElement("span");
        source.className = "krc-info-date";
        const sourceName = String(selected?.sourceName || "").trim();
        source.textContent = `Source: ${sourceName && sourceName.toLowerCase() !== "default" ? sourceName : "n/a"}`;
        fileRow.append(filename, source);
        subline.append(fileRow);
        const releaseRow = document.createElement("div");
        releaseRow.className = "krc-info-meta-row";
        const creator = document.createElement("span");
        creator.textContent = selected?.creatorName ? `Creator: ${selected.creatorName}` : "";
        const release = document.createElement("span");
        release.className = "krc-info-date";
        release.textContent = selected?.releaseDate ? `Released: ${selected.releaseDate}` : "";
        releaseRow.append(creator, release);
        subline.append(releaseRow);

        const metaRow = document.createElement("div");
        metaRow.className = "krc-info-meta-row";
        const version = document.createElement("span");
        version.textContent = selected?.version ? `Version: ${selected.version}` : "";
        const added = document.createElement("span");
        added.className = "krc-info-date";
        const addedText = ctl.formatDateOnly?.(selected?.dateAdded) || "";
        added.textContent = addedText ? `Date Added: ${addedText}` : "";
        metaRow.append(version, added);
        subline.append(metaRow);

        return subline;
      },
      renderLeft: (selected) => ctl.renderGenericModelLeft(selected),
      renderRight: (selected) => ctl.renderGenericModelRight(selected),
      renderFooter: (selected) => ctl.renderInfoFooter(selected),
    };
    return this._modelInfoPanelSource;
  },

  renderGenericModelLeft(selected) {
    const left = document.createElement("div");
    left.className = "krc-info-left";
    const thumb = this.renderInfoThumb(selected);
    const thumbControls = thumbnailControlRow({
      pasteMode: this.thumbnailPasteMode,
      actionDisabled: !selected,
      removeDisabled: !selected?.thumbnail,
      onAction: (pasteMode) => {
        if (pasteMode) {
          this.pasteThumbnail(selected);
        } else {
          this.selectThumbnailFile(selected);
        }
      },
      onRemove: () => this.deleteThumbnail(selected),
      onPasteModeChange: (next) => {
        this.thumbnailPasteMode = next;
      },
    });
    left.append(
      thumb,
      thumbControls,
      this.renderInfoText("TYPE", this.modelTypeLabel(selected?.modelType), "krc-model-type-field"),
      this.renderField("BASE MODEL", selected?.baseModel || "", (value) => this.editGenericField(selected, "baseModel", value)),
      this.renderField("QUANTIZATION", selected?.quantization || "", (value) => this.editGenericField(selected, "quantization", value)),
      // + COLLECTION works for any stabilized file — the generic-model panel has its own left
      // column, so mount the shared control here too (the LoRA panel mounts it in renderInfoLeft).
      this.renderCollectionControl(selected)
    );
    return left;
  },

  modelTypeLabel(modelType) {
    return ({
      checkpoint: "Checkpoint",
      diffusion: "Diffusion",
      unet: "UNet",
      vae: "VAE",
      clip: "CLIP",
      text_encoder: "Text Encoder",
      controlnet: "ControlNet",
      upscaler: "Upscaler",
      embedding: "Embedding",
      other: "Other",
    })[String(modelType || "").trim()] || "Other";
  },

  renderGenericModelRight(selected) {
    const right = document.createElement("div");
    right.className = "krc-info-right";
    const description = document.createElement("textarea");
    description.className = "krc-textarea krc-description krc-model-description";
    description.value = selected?.description || "";
    description.addEventListener("input", (event) => this.editGenericField(selected, "description", event.target.value));

    const notes = document.createElement("textarea");
    notes.className = "krc-textarea krc-description krc-model-notes";
    notes.value = selected?.notes || "";
    notes.addEventListener("input", (event) => this.editGenericField(selected, "notes", event.target.value));

    right.append(
      this.renderLabel("DESCRIPTION"),
      description,
      this.renderLabel("NOTES"),
      notes,
      this.renderField("TAGS", (selected?.tags || []).join(", "), (value) => {
        if (!selected) return;
        selected.tags = String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean);
        this.markMetadataEdited();
      })
    );
    return right;
  },

  editGenericField(selected, key, value) {
    if (!selected) return;
    selected[key] = value;
    this.markMetadataEdited();
  },

  openTrainedWordEditor({ selected, index = -1, anchor, value = "", title = "Trained Word" } = {}) {
    if (!selected) {
      return;
    }
    this._trainedWordEditor?.close(false);
    const canDelete = index >= 0;
    const root = anchor?.closest?.(".krc-model-library") || this.root;
    this._trainedWordEditor = openTrainedWordPopover({
      root,
      node: this.node,
      anchor,
      value,
      title,
      canDelete,
      onCommit: (nextValue) => {
        if (canDelete) this.commitTrainedWord(selected, index, nextValue);
        else this.commitNewTrainedWord(selected, nextValue);
      },
      onDelete: () => {
        if (canDelete) this.removeTrainedWord(selected, index);
      },
      onClose: ({ popover }) => {
        if (this._trainedWordEditor?.popover === popover) this._trainedWordEditor = null;
      },
    });
  },

  renderCardColorButton(selected) {
    return createCardColorButton({
      record: selected,
      baseTitle: this.isGenericModel?.(selected) ? "Model color" : "LoRA color",
      onChange: (value) => {
        if (selected) {
          this.setLoraCardColor(selected, value);
        }
      },
    });
  },

  renderInfoText(label, value, className = "") {
    const row = document.createElement("div");
    row.className = `krc-info-text ${className}`.trim();
    const text = document.createElement("span");
    text.className = "krc-field-label";
    text.textContent = label;
    const content = document.createElement("div");
    content.className = "krc-info-text-value";
    content.title = value;
    content.textContent = value;
    row.append(text, content);
    return row;
  },

  // The panel's own Options (the gear, on a node and in the Portal). The home menu's
  // Options card opens the KRC Portal's global Options page instead (openPortalPage).
  openOptionsModal() {
    openKrcModal({
      node: this.node,
      title: "Model Library options",
      body: this.optionsSections(),
    });
  },

  // The panel's own Options cells (the modal, on a node and in the Portal).
  // `section({ title, body })` builds each cell (krcModalSection by default).
  optionsSections(section = krcModalSection) {
    const appearanceBody = document.createElement("div");
    appearanceBody.className = "krc-options-appearance";
    // In the Portal the palette is the Portal's own (Options ▸ Appearance), not per panel.
    appearanceBody.append(this.surface === "detached"
      ? portalPaletteNote()
      : buildNodePaletteField({ node: this.node, root: this.root }));
    appearanceBody.append(switchToggle({
      label: "Show thumbnails in list view",
      active: !!this.listThumbs,
      title: "Show a small thumbnail on each card in the list view.",
      onClick: (toggleEvent) => {
        this.setListThumbs(!this.listThumbs);
        toggleEvent.currentTarget?.classList.toggle("is-on", !!this.listThumbs);
      },
    }));
    return [
      // This node's sections of a KRC bundle (everything else: Portal ▸ Import and Export).
      section({ body: nodeTransferRow({ node: this.node, sections: ["model_library", "collections"],
        label: "models and Collections" }) }),
      section({
        title: "Appearance",
        body: appearanceBody,
      }),
      section({
        title: "Troubleshooting",
        body: this.renderResetEditsControl(),
      }),
    ];
  },

  renderConfigMenu() {
    const wrap = document.createElement("div");
    wrap.className = "krc-config";

    const button = document.createElement("button");
    button.className = "krc-icon-button krc-config-button";
    button.type = "button";
    button.title = "Options";
    button.setAttribute("aria-label", "Options");
    const glyph = document.createElement("span");
    glyph.className = "krc-gear-glyph";
    button.append(glyph);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openOptionsModal();
    });
    stopCanvasEvents(button);

    wrap.append(button);
    return wrap;
  },

  // One item's image URL, versioned by its own thumbnailVersion (see LoRA Loadout's).
  thumbnailUrl(item, kind = "") {
    return libraryThumbnailUrl(item?.thumbnailSha || item?.sha256 || "", { version: item?.thumbnailVersion, kind });
  },

  copyText,

  renderInfoFooter(selected) {
    const footer = document.createElement("div");
    footer.className = "krc-info-footer";

    const genericModel = this.isGenericModel?.(selected);
    const value = selected?.sha256 || "";
    const stableId = value && !String(value).startsWith("local-");
    const canStabilize = !!genericModel && !!value && !stableId;
    const sha = document.createElement("div");
    sha.className = `krc-sha ${canStabilize ? "has-stabilize" : ""}`;
    sha.title = value || "";
    const shield = renderVerificationShield(selected?.verification);
    if (shield) sha.append(shield);
    if (canStabilize) {
      const shaText = document.createElement("span");
      shaText.className = "krc-sha-text";
      shaText.textContent = value;
      const stabilize = document.createElement("button");
      stabilize.className = "krc-sha-stabilize";
      stabilize.type = "button";
      stabilize.textContent = "STABILIZE";
      stabilize.title = "Create a stable SHA256 ID for this model";
      stabilize.setAttribute("aria-label", "Stabilize model ID");
      stabilize.addEventListener("click", async (event) => {
        event.stopPropagation();
        const ok = await openKrcConfirm({
          node: this.node,
          title: "Stabilize model ID",
          message: "Stabilize this model ID now? This reads the full model file and large models can take a while.",
          confirmLabel: "Stabilize",
        });
        if (!ok || stabilize.disabled) {
          return;
        }
        stabilize.disabled = true;
        stabilize.textContent = "READING";
        await this.stabilizeSelected(value, { manual: true });
        if (stabilize.isConnected) {
          stabilize.disabled = false;
          stabilize.textContent = "STABILIZE";
        }
      });
      stopCanvasEvents(stabilize);
      sha.append(shaText, stabilize);
    } else {
      const shaText = document.createElement("span");
      shaText.className = "krc-sha-text";
      shaText.textContent = value || "sha256";
      sha.append(shaText);
    }
    // Reapply the in-flight glow after a panel rebuild so a background stabilize keeps
    // indicating (the class is otherwise lost when the footer is recreated).
    applyStabilizeGlow(sha, !!this._stabilizing && this._stabilizing === selected?.sha256);

    const copy = document.createElement("button");
    copy.className = "krc-icon-button krc-copy-button";
    copy.type = "button";
    copy.textContent = "⧉";
    copy.title = stableId ? "Copy full hash id" : (genericModel ? "Stabilize this model ID before copying a full hash" : "Save metadata first to create a stable LoRA ID");
    copy.setAttribute("aria-label", "Copy full hash id");
    copy.disabled = !stableId;
    copy.addEventListener("click", () => this.copyText(value));

    // Metadata fetch. A LoRA fetches from Civitai straight away (by content hash, so an
    // unstable id is hashed first). Any other model picks its source from a small
    // popover: Civitai, or HuggingFace, which asks for the repo like More Info's
    // "Import from HF".
    const genericFetch = !!this.isGenericModel?.(selected);
    const fetchBtn = document.createElement("button");
    fetchBtn.className = "krc-icon-button krc-copy-button krc-fetch-button";
    fetchBtn.type = "button";
    fetchBtn.title = genericFetch
      ? "Fetch metadata from Civitai or HuggingFace"
      : stableId
        ? "Fetch metadata from Civitai — fills empty fields, keeps the ones you set"
        : "Compute a stable hash, then fetch from Civitai";
    fetchBtn.setAttribute("aria-label", genericFetch ? "Fetch metadata" : "Fetch metadata from Civitai");
    if (genericFetch) fetchBtn.setAttribute("aria-haspopup", "menu");
    fetchBtn.disabled = !value;
    const fetchGlyph = document.createElement("span");
    fetchGlyph.className = "krc-fetch-glyph";
    fetchGlyph.textContent = "⬇︎"; // filled down arrow (VS15 = monochrome, not emoji)
    fetchBtn.append(fetchGlyph);
    const sourceMenu = genericFetch ? document.createElement("div") : null;
    if (sourceMenu) {
      sourceMenu.className = "krc-menu-select-menu krc-fetch-source-menu";
      sourceMenu.hidden = true;
      sourceMenu.setAttribute("role", "menu");
      const sourceOption = (label, title, onPick) => {
        const option = document.createElement("button");
        option.type = "button";
        option.className = "krc-menu-select-option";
        option.setAttribute("role", "menuitem");
        option.textContent = label;
        option.title = title;
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeFloatingMenu();
          onPick();
        });
        return option;
      };
      sourceMenu.append(
        sourceOption("Civitai", stableId ? "Fetch metadata from Civitai by hash" : "Compute a stable hash, then fetch from Civitai", () => runCivitaiFetch()),
        sourceOption("HuggingFace…", "Import metadata from a HuggingFace repo (model card, author, license)", () => this.openHfImportModal(selected)),
      );
      stopCanvasEvents(sourceMenu);
    }
    fetchBtn.addEventListener("click", (event) => {
      // Client-side consent gate first: off means no request at all (server guard is
      // the backstop).
      if (!isNetworkAllowed()) {
        notifyNetworkDisabled();
        return;
      }
      if (fetchBtn.disabled) {
        return;
      }
      if (sourceMenu) {
        event.stopPropagation();
        toggleFloatingMenu(fetchBtn, sourceMenu, { align: "right" });
        return;
      }
      runCivitaiFetch();
    });
    // The Civitai fetch, with in-button state feedback.
    const runCivitaiFetch = async () => {
      if (fetchBtn.disabled) {
        return;
      }
      fetchBtn.disabled = true;
      fetchBtn.classList.remove("is-error", "is-success");
      fetchBtn.classList.add("is-loading");
      fetchGlyph.textContent = ""; // is-loading renders a centered CSS ring spinner
      const { status } = await this.fetchCivitaiMetadata(selected);
      // A merged hit re-renders the whole panel, detaching this button — nothing to
      // restore. Otherwise show a brief outcome glyph, then reset.
      if (!fetchBtn.isConnected) {
        return;
      }
      fetchBtn.classList.remove("is-loading");
      const ok = status === "hit" || status === "complete";
      fetchBtn.classList.add(ok ? "is-success" : "is-error");
      fetchGlyph.textContent = ok ? "✓" : "⚠";
      setTimeout(() => {
        if (!fetchBtn.isConnected) {
          return;
        }
        fetchBtn.classList.remove("is-error", "is-success");
        fetchGlyph.textContent = "⬇︎";
        fetchBtn.disabled = !value;
      }, 1600);
    };

    const moreInfo = document.createElement("button");
    moreInfo.className = "krc-icon-button krc-copy-button krc-more-info-button";
    moreInfo.type = "button";
    moreInfo.title = "More Info";
    moreInfo.setAttribute("aria-label", "More Info");
    moreInfo.disabled = !selected;
    const moreInfoGlyph = document.createElement("span");
    moreInfoGlyph.className = "krc-more-info-glyph";
    moreInfoGlyph.setAttribute("aria-hidden", "true");
    moreInfoGlyph.append(
      Object.assign(document.createElement("span"), { className: "krc-more-info-dot" }),
      Object.assign(document.createElement("span"), { className: "krc-more-info-stem" }),
    );
    moreInfo.append(moreInfoGlyph);
    moreInfo.addEventListener("click", () => this.openMoreInfoModal(selected));

    const config = this.renderConfigMenu();

    const save = document.createElement("button");
    save.className = "krc-save-button";
    save.type = "button";
    save.textContent = "save";
    save.disabled = !selected;
    save.addEventListener("click", () => this.saveSelected(selected));

    footer.append(sha, copy, fetchBtn, moreInfo, save, config);
    return footer;
  },
};
