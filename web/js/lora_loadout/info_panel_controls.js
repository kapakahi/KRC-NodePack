import { createCardColorButton } from "../shared/card_color_button.js";
import { applyStabilizeGlow } from "../shared/stabilize_glow.js";
import { renderVerificationShield } from "../shared/verification_shield.js";
import { copyText } from "../shared/clipboard.js";
import { switchToggle } from "../shared/browser_controls.js";
import { thumbnailBox } from "../shared/browser_cards.js";
import { openKrcModal, krcModalSection } from "../shared/modal.js";
import { buildNodePaletteField } from "../shared/node_palette.js";
import { nodeTransferRow } from "../shared/transfer/node_transfer_row.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";
import { clearKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { loraApiUrl } from "./api.js";
import { setWidgetValue, stopCanvasEvents, widgetValue } from "./helpers.js";
import { truthyWidgetValue } from "./panel_state.js";
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
    thumb.title = "Drag into a stack slot";
    thumb.addEventListener("dragstart", (event) => {
      const dragSha = this.canonicalId?.(selected?.sha256) || selected?.sha256 || "";
      if (!dragSha) {
        event.preventDefault();
        return;
      }
      const isVideoThumb = selected?.thumbnailType === "video";
      const thumbUrl = selected?.thumbnail
        ? this.thumbnailUrl(selected, isVideoThumb && selected?.thumbnailHasPoster ? "poster" : "")
        : "";
      const payload = {
        kind: "lora",
        id: dragSha,
        modelType: "lora",
        path: selected.path || "",
        relativePath: selected.relativePath || selected.relative_path || "",
        file: selected.filename || "",
        title: selected.display_name || selected.filename || "",
        thumbnailUrl: thumbUrl,
        cardColor: this.effectiveLoraCardColor?.(selected) || selected.cardColor || "",
        favorite: Boolean(selected.favorite),
      };
      clearTimeout(this._stabilizeTimer);
      this.draggedSha = dragSha;
      this.root.classList.add("is-dragging-lora");
      setKrcDragPayload(payload);
      event.dataTransfer.effectAllowed = "copy";
      event.dataTransfer.setData("application/x-krc-model", JSON.stringify(payload));
      event.dataTransfer.setData("application/x-krc-lora", dragSha);
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

  openTrainedWordEditor({ selected, index = -1, anchor, value = "", title = "Trained Word" } = {}) {
    if (!selected) {
      return;
    }
    this._trainedWordEditor?.close(false);
    const canDelete = index >= 0;
    const root = anchor?.closest?.(".krc-lora-stacker") || this.root;
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
      baseTitle: "LoRA color",
      onChange: (value) => {
        if (selected) {
          this.setLoraCardColor(selected, value);
        }
      },
    });
  },

  renderInfoText(label, value) {
    const row = document.createElement("div");
    row.className = "krc-info-text";
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
      const body = [];
      const daisyChainEnabled = truthyWidgetValue(widgetValue(this.node, "daisy_chain_mode"));
      const stackOutputBody = document.createElement("div");
      stackOutputBody.className = "krc-options-stack-output";
      stackOutputBody.classList.toggle("is-daisy-disabled", !daisyChainEnabled);
      const daisy = switchToggle({
        label: "Combine Stack",
        active: daisyChainEnabled,
        title: "Utilize both stacks on Stack A output.",
        onClick: (toggleEvent) => {
          const next = !truthyWidgetValue(widgetValue(this.node, "daisy_chain_mode"));
          setWidgetValue(this.node, "daisy_chain_mode", next);
          toggleEvent.currentTarget?.classList.toggle("is-on", next);
          stackOutputBody.classList.toggle("is-daisy-disabled", !next);
          this.refreshStacks();
        },
      });
      const daisyDesc = document.createElement("div");
      daisyDesc.className = "krc-options-description";
      daisyDesc.textContent = "Utilize both stacks on Stack A output.";
      stackOutputBody.append(daisy, daisyDesc);
      body.push(krcModalSection({
        title: "Stack Output",
        body: stackOutputBody,
      }));
      const appearanceBody = document.createElement("div");
      appearanceBody.className = "krc-options-appearance";
      if (this.surface !== "mini") {
        appearanceBody.append(switchToggle({
          label: "Swap Preset and Info Panel",
          active: !!this.swapPresetInfoColumns,
          title: "Swap the preset/stack column with the Info Panel",
          onClick: (toggleEvent) => {
            this.setSwapPresetInfoColumns(!this.swapPresetInfoColumns);
            toggleEvent.currentTarget?.classList.toggle("is-on", !!this.swapPresetInfoColumns);
          },
        }));
      }
      const thumbsIsMini = this.surface === "mini";
      appearanceBody.append(switchToggle({
        label: thumbsIsMini ? "Show thumbnails in preset slots" : "Show thumbnails in list view",
        active: !!this.listThumbs,
        title: thumbsIsMini
          ? "Show a small thumbnail on each preset slot."
          : "Show a small thumbnail on each list-view card and preset slot.",
        onClick: (toggleEvent) => {
          this.setListThumbs(!this.listThumbs);
          toggleEvent.currentTarget?.classList.toggle("is-on", !!this.listThumbs);
        },
      }));
      appearanceBody.append(switchToggle({
        label: "Show badge row in preset slots",
        active: this.slotBadgeRow !== false,
        title: "Off = simpler slots: title only, allowed to wrap to a second line.",
        onClick: (toggleEvent) => {
          this.setSlotBadgeRow(this.slotBadgeRow === false);
          toggleEvent.currentTarget?.classList.toggle("is-on", this.slotBadgeRow !== false);
        },
      }));
      appearanceBody.append(buildNodePaletteField({ node: this.node, root: this.root }));
      body.push(
        krcModalSection({
          body: nodeTransferRow({ node: this.node, sections: ["lora_library", "lora_presets"], label: "LoRAs and presets" }),
        }),
        krcModalSection({
          title: "Appearance",
          body: appearanceBody,
        }),
        krcModalSection({
          title: "Troubleshooting",
          body: this.renderResetEditsControl(),
        }),
      );
      openKrcModal({
        node: this.node,
        title: "LoRA Loadout options",
        body,
      });
    });
    stopCanvasEvents(button);

    wrap.append(button);
    return wrap;
  },

  // One item's image URL, versioned by its own thumbnailVersion (the server's newest
  // thumbnail-file mtime): an unchanged image keeps a cacheable URL, and a change busts
  // only that item's.
  thumbnailUrl(item, kind = "") {
    const params = [];
    const version = Number(item?.thumbnailVersion) || 0;
    if (version) params.push(`v=${version}`);
    if (kind) params.push(`kind=${encodeURIComponent(kind)}`);
    const suffix = params.length ? `?${params.join("&")}` : "";
    return loraApiUrl(`/thumbnail/${item?.thumbnailSha || item?.sha256 || ""}${suffix}`);
  },

  copyText,

  renderInfoFooter(selected) {
    const footer = document.createElement("div");
    footer.className = "krc-info-footer";

    const value = selected?.sha256 || "";
    const stableId = value && !String(value).startsWith("local-");
    const sha = document.createElement("div");
    sha.className = "krc-sha";
    sha.title = value || "";
    const shield = renderVerificationShield(selected?.verification);
    if (shield) sha.append(shield);
    const shaText = document.createElement("span");
    shaText.className = "krc-sha-text";
    shaText.textContent = value || "sha256";
    sha.append(shaText);
    // Reapply the in-flight glow after a panel rebuild so a background stabilize keeps
    // indicating (the class is otherwise lost when the footer is recreated).
    applyStabilizeGlow(sha, !!this._stabilizing && this._stabilizing === selected?.sha256);

    const copy = document.createElement("button");
    copy.className = "krc-icon-button krc-copy-button";
    copy.type = "button";
    copy.textContent = "⧉";
    copy.title = stableId ? "Copy full hash id" : "Save metadata first to create a stable LoRA ID";
    copy.setAttribute("aria-label", "Copy full hash id");
    copy.disabled = !stableId;
    copy.addEventListener("click", () => this.copyText(value));

    // Civitai metadata fetch — on-demand, stack-scoped, public/no-auth. Placeholder:
    // the client + wiring land in the next Stage-1 increment. Needs a stable content
    // hash to query Civitai by-hash, so it's disabled until the id is stabilized.
    const fetchBtn = document.createElement("button");
    fetchBtn.className = "krc-icon-button krc-copy-button krc-fetch-button";
    fetchBtn.type = "button";
    fetchBtn.title = stableId
      ? "Fetch metadata from Civitai — fills empty fields, keeps the ones you set"
      : "Compute a stable hash, then fetch from Civitai";
    fetchBtn.setAttribute("aria-label", "Fetch metadata from Civitai");
    fetchBtn.disabled = !value;
    const fetchGlyph = document.createElement("span");
    fetchGlyph.className = "krc-fetch-glyph";
    fetchGlyph.textContent = "⬇︎"; // filled down arrow (VS15 = monochrome, not emoji)
    fetchBtn.append(fetchGlyph);
    fetchBtn.addEventListener("click", async () => {
      // Client-side consent gate first: off means no request at all (server guard is
      // the backstop). On → the shared fetch action, with in-button state feedback.
      if (!isNetworkAllowed()) {
        notifyNetworkDisabled();
        return;
      }
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
    });

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
