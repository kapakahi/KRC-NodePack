/*
 * KRC Prompt Vault — info view (right column).
 * Renders the selected/draft prompt's editor: header actions, name, thumbnail,
 * fields, prompt type metadata and toggles; the preset rows, preset sync, prompt boxes
 * and Options live in preset_fields / preset_sync / prompt_boxes / options_menu.
 * Mixed onto PMRedesign.prototype via Object.assign.
 */
import { createCardColorButton } from "../shared/card_color_button.js";
import { installMediaThumbnailDrop } from "../shared/media_thumbnail_drop.js";
import { thumbnailBox } from "../shared/browser_cards.js";
import {
  favoriteActionButton,
  nsfwActionButton,
  pinActionButton,
  switchToggle,
} from "../shared/browser_controls.js";
import { customBadgeActionButton } from "../shared/custom_badge_button.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { bindSingleLineFitLimit } from "../shared/text_layout.js";
import { thumbnailControlRow } from "../shared/thumbnail_controls.js";
import { el } from "./dom.js";
import { UNASSIGNED_CATEGORY } from "./constants.js";
import { loadPvKitsOnce, _pvKitsLoaded } from "./preset_fields.js";

export const infoMethods = {
  renderInfo() {
    const foreign = this.profileMismatch?.() || this.profileMissing?.();
    const panel = el("div", "krc-panel krc-info-panel");
    const header = el("div", "krc-panel-header");
    const canCycle = this.filtered().length > 0;
    const cycleControls = el("div", "krc-header-controls");
    const upBtn = el("button", "krc-icon-button krc-info-cycle", { textContent: "▲", title: "Previous prompt" });
    upBtn.disabled = !canCycle;
    upBtn.addEventListener("click", () => this.cycleSelection(-1));
    const downBtn = el("button", "krc-icon-button krc-info-cycle", { textContent: "▼", title: "Next prompt" });
    downBtn.disabled = !canCycle;
    downBtn.addEventListener("click", () => this.cycleSelection(1));
    cycleControls.append(upBtn, downBtn);

    const title = el("div", "krc-info-title", { textContent: "Editor" });

    const editControls = el("div", "krc-header-actions krc-info-actions");
    const modifiedSlot = el("span", "krc-info-modified-slot");
    const statusBadge = this.statusBadgeEl();
    if (statusBadge) modifiedSlot.append(statusBadge);
    const colorBtn = this.cardColorButton(this.draft);
    const badgeBtn = customBadgeActionButton({
      value: this.draft?.customBadge || "",
      active: !!this.draft?.customBadge,
      title: this.draft?.customBadge ? "Edit custom badge" : "Add custom badge",
      disabled: !this.orig || foreign,
      onSave: (value) => {
        if (this.profileMismatch?.() || this.profileMissing?.()) return false;
        const item = this.orig ? this.findByKey(this.keyOf(this.orig.category, this.orig.name)) : null;
        return item ? this.quickSetPromptCustomBadge(item, value) : false;
      },
    });
    const favBtn = favoriteActionButton({
      active: !!this.draft?.favorite,
      title: "Favorite",
      disabled: !this.draft || foreign,
      className: "krc-icon-button is-fav",
      onClick: () => this.togglePromptFlag("favorite"),
    });
    const pinBtn = pinActionButton({
      active: !!this.draft?.pinned,
      title: "Pin to top",
      disabled: !this.orig || foreign,
      className: "krc-icon-button is-pin",
      onClick: () => this.togglePromptFlag("pinned"),
    });
    const nsfwBtn = nsfwActionButton({
      active: !!this.draft?.nsfw,
      title: "Mark NSFW",
      disabled: !this.draft || foreign,
      className: "krc-icon-button is-nsfw",
      onClick: () => this.togglePromptFlag("nsfw"),
    });
    editControls.append(modifiedSlot, colorBtn, badgeBtn, favBtn, pinBtn, nsfwBtn);
    header.append(cycleControls, title, editControls);

    this._pmDotEls = null;
    if (!this.draft) {
      const empty = el("div", "krc-info-empty");
      empty.append(
        el("div", "krc-footer", { textContent: "Select a prompt, or create a new one." }),
        this.renderNewPromptButton()
      );
      panel.append(header, empty);
      return panel;
    }

    const d = this.draft;
    const nameInp = el("input", "krc-input", { value: d.name || "", placeholder: "Name" });
    bindSingleLineFitLimit(nameInp, (value) => { d.name = value; this.draftChanged(); });

    // left sub-column
    const left = el("div", "krc-info-left");
    const isVideoThumb = d.thumbType === "video";
    const blurNsfw = this.shouldBlurNSFW?.(d);
    const useAnimatedThumb = isVideoThumb && this.webmThumbnailsEnabled && !blurNsfw;
    const thumb = thumbnailBox({
      className: "krc-info-thumb",
      url: this.thumbUrl(d, useAnimatedThumb ? "animated" : (isVideoThumb && d.thumbHasPoster ? "poster" : "")),
      mediaType: useAnimatedThumb ? "video" : "image",
      playOnHover: useAnimatedThumb,
      playOnce: useAnimatedThumb && this.webmThumbnailAutoplayEnabled,
      posterUrl: useAnimatedThumb && d.thumbHasPoster ? this.thumbUrl(d, "poster") : "",
      placeholderKind: isVideoThumb ? "video" : "image",
      blurred: blurNsfw,
    });

    const saved = !!this.orig && !foreign;   // upload requires an existing record
    // A Media card dropped here becomes the thumbnail, like picking that file with UPLOAD.
    installMediaThumbnailDrop(thumb, {
      enabled: () => saved,
      onFile: (file) => this.uploadThumbFile(file),
      onError: (message) => this.toast(message),
    });
    this._thumbRemoveConfirm?.dispose();
    this._thumbRemoveConfirm = null;
    const thumbCtl = thumbnailControlRow({
      pasteMode: this.pasteThumbMode,
      actionDisabled: !saved,
      removeDisabled: !saved || !d.hasThumb,
      onAction: () => this.uploadThumb(),
      onRemove: () => this.removeThumb(),
      onPasteModeChange: (next) => {
        this.pasteThumbMode = next;
      },
    });
    this._thumbRemoveConfirm = thumbCtl.removeConfirm;

    const typeField = this.field("Type", d.model || "", v => d.model = v);
    const categoryValue = d.category === UNASSIGNED_CATEGORY ? "" : (d.category || "");
    const category = this.field("Category", categoryValue, v => d.category = v);
    const replaceTools = this.renderReplaceTools();
    left.append(thumb, thumbCtl, category, typeField, replaceTools);

    // right sub-column
    const right = el("div", "krc-info-right");
    const llPreset = this.presetPickerField(d);
    // LL preset + any kit preset rows share the first grid row; a kit row's height comes
    // out of Prompt A only (promptSplitRows).
    const presetStack = el("div", "krc-pv-preset-stack");
    const kitRows = this.visibleKitRows().map((kit) => this.kitPresetPickerField(kit));
    presetStack.append(llPreset, ...kitRows);
    if (!_pvKitsLoaded) {
      loadPvKitsOnce().then(() => {
        if (presetStack.isConnected && this.visibleKitRows().length) this.refreshInfoPanel();
      });
    }
    const promptBox = this.textBox("Prompt A", d.prompt || "", v => d.prompt = v, { large: true, controls: this.promptAControls() });
    // The A/B resize handle lives centered in Prompt B's header (the gap between
    // the two boxes), not as its own full-width row.
    const promptBBox = this.textBox("Prompt B", d.promptB || "", v => d.promptB = v, {
      notes: true, controls: this.promptBControls(), middle: this.renderPromptDivider(),
    });
    right.append(presetStack, promptBox, promptBBox);
    this._pmSplitEls = { right, a: promptBox, b: promptBBox, presets: presetStack, ll: llPreset, kitRows };
    // Refs to the editable text controls so undo/redo can update them in place
    // instead of rebuilding the whole info panel.
    this._pmEditFields = {
      prompt: promptBox.querySelector("textarea"),
      promptB: promptBBox.querySelector("textarea"),
      model: typeField.querySelector("input"),
      replaceFind: replaceTools.querySelector(".krc-replace-find"),
      replaceWith: replaceTools.querySelector(".krc-replace-with"),
    };
    this.applyPromptSplit();

    const body = el("div", "krc-info-body");
    body.append(left, right);

    // bottom row: new | duplicate | delete | save | config
    const actions = el("div", "krc-bottom-actions");
    const newBtn = this.renderNewPromptButton();
    const dupBtn = el("button", "krc-action-button", { textContent: "Duplicate" });
    dupBtn.disabled = !this.orig || foreign;
    dupBtn.addEventListener("click", () => this.duplicate());
    this._deleteConfirm?.dispose();
    this._deleteConfirm = null;
    const delBtn = el("button", "krc-action-button is-delete", { textContent: "Delete" });
    delBtn.disabled = !this.orig || foreign;
    this._deleteConfirm = armConfirmButton(delBtn, {
      restoreText: "Delete",
      shouldArm: () => !!this.orig && !this.profileMismatch?.() && !this.profileMissing?.(),
      onConfirm: () => this.doDelete(),
    });
    const configMenu = this.renderConfigMenu();
    const saveBtn = el("button", "krc-save-button", { textContent: "save" });
    saveBtn.addEventListener("click", () => this.save());
    this.applyPromptSaveButton(saveBtn);   // SAVE -> SYNC when the record is stale
    actions.append(newBtn, dupBtn, delBtn, saveBtn, configMenu);

    // assemble: name on top, then body, then the single bottom control row
    const top = el("div");
    top.style.cssText = "margin-bottom:7px;";
    const dateMeta = el("div", "krc-date-meta");
    this.updateDateMetaEl(dateMeta, d);
    // The name box is positioned so its Modified dot can sit at its right end.
    const nameWrap = el("div", "krc-pv-name-wrap");
    nameWrap.append(nameInp);
    top.append(nameWrap, dateMeta);

    panel.append(header, top, body, actions);
    // Where the per-field Modified dots go (record_status.js renderModifiedFields): the
    // name box, else each field's label. Keys are normalizedRecord's ("kit:<id>" per kit).
    const label = (box) => box?.querySelector(".krc-field-label") || null;
    this._pmDotEls = {
      name: nameWrap,
      category: label(category),
      model: label(typeField),
      llPreset: label(llPreset),
      ...Object.fromEntries(kitRows.map((row) => [`kit:${row.dataset.kit}`, label(row)])),
      prompt: label(promptBox),
      promptB: label(promptBBox),
    };
    this.renderModifiedFields();
    return panel;
  },

  renderNewPromptButton() {
    const newBtn = el("button", "krc-action-button", { textContent: "NEW" });
    newBtn.addEventListener("click", () => this.newPrompt());
    return newBtn;
  },

  fieldLabel(text) { return el("div", "krc-field-label", { textContent: text }); },

  fieldHeader(label, controls = null, middle = null) {
    const header = el("div", "krc-field-header");
    header.append(this.fieldLabel(label));
    if (middle) header.append(middle);
    if (controls) header.append(controls);
    return header;
  },

  field(label, value, onInput, { placeholder = "" } = {}) {
    const wrap = el("div");
    const inp = el("input", "krc-input", { value, placeholder });
    inp.addEventListener("input", () => { onInput(inp.value); this.draftChanged(); });
    wrap.append(this.fieldLabel(label), inp);
    return wrap;
  },

  cardColorButton(record) {
    return createCardColorButton({
      record,
      disabled: !record || this.profileMismatch?.() || this.profileMissing?.(),
      baseTitle: "Prompt color",
      inheritedTitle: "Prompt color inherited from parent",
      onChange: (value) => this.setPromptCardColor(value),
    });
  },

  renderSwitch(label, on, onClick) {
    return switchToggle({ label, active: on, onClick });
  },

  renderRightSwitch(label, on, onClick) {
    const wrap = el("div", "krc-switch-row-right");
    wrap.append(el("span", "krc-switch-label", { textContent: label }), this.renderSwitch("", on, onClick));
    return wrap;
  },

};
