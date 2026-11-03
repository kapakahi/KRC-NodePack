// Shared info-panel controls: the action row (color/custom badge/favorite/pin/nsfw),
// left column (thumbnail controls + category/base-model fields), right column
// (trained words / example prompts / description), trained-word chip editing, the
// reset-edits escape hatch, and the
// small menu/label/prompt-box helpers. Byte-shared by LoRA Loadout and Model
// Library. Node-specific pieces — the thumbnail itself (drag payload differs),
// card-color button, info-text row, config menu, thumbnail URL, footer, and the
// generic-model fields — stay in each node's info_panel_controls.js and resolve
// through `this`.
import { favoriteActionButton, nsfwActionButton, pinActionButton } from "./browser_controls.js";
import { thumbnailControlRow } from "./thumbnail_controls.js";
import { customBadgeActionButton } from "./custom_badge_button.js";
import { bindSingleLineFitLimit } from "./text_layout.js";
import { openKrcModal } from "./modal.js";
import { armConfirmButton } from "./confirm_action.js";
import { stopCanvasEvents } from "./dom.js";
import {
  addMember as addCollectionMember,
  collectionsCache,
  collectionsForMember,
  createCollection,
  loadCollections,
  removeMember as removeCollectionMember,
} from "./collections_client.js";

// Eye glyph for the per-collection "view" button in the + COLLECTION popover. Inline SVG so it
// inherits currentColor and stays crisp (an emoji eye renders inconsistently across platforms).
const COLLECTION_VIEW_ICON =
  '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8Z"/><circle cx="8" cy="8" r="1.9"/></svg>';

export const sharedInfoPanelControlMethods = {

  renderInfoActions(selected) {
    const actions = document.createElement("div");
    actions.className = "krc-info-actions";
    const color = this.renderCardColorButton(selected);
    const customBadge = customBadgeActionButton({
      value: selected?.customBadge || "",
      active: !!selected?.customBadge,
      title: selected?.customBadge ? "Edit custom badge" : "Add custom badge",
      disabled: !selected,
      onSave: (value) => this.setLoraCustomBadge(selected, value),
    });
    const favorite = favoriteActionButton({
      active: !!selected?.favorite,
      title: selected?.favorite ? "Remove favorite tag" : "Mark as favorite",
      disabled: !selected,
      onClick: () => this.toggleFavorite(selected),
    });
    const isPinned = !!selected?.pinned;
    const pin = pinActionButton({
      active: isPinned,
      title: isPinned ? "Unpin from top" : "Pin to top",
      disabled: !selected,
      onClick: () => this.togglePin(selected),
    });
    const nsfw = nsfwActionButton({
      active: !!selected?.nsfw,
      title: selected?.nsfw ? "Remove NSFW tag" : "Tag as NSFW",
      disabled: !selected,
      onClick: () => this.toggleNsfw(selected),
    });
    const modifiedSlot = document.createElement("span");
    modifiedSlot.className = "krc-info-modified-slot";
    if (this.isMetadataModified(selected)) {
      modifiedSlot.append(this.renderModifiedBadge({ discardable: true }));
    }
    actions.append(modifiedSlot, color, customBadge, favorite, pin, nsfw);
    return actions;
  },

  // Re-render just the info-panel action row (color/custom badge/favorite/pin/nsfw +
  // modified badge) without rebuilding the thumbnail, fields, and footer.
  refreshInfoActions() {
    const actions = this.querySurface(".krc-info-actions");
    if (!actions) {
      return;
    }
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || this.loras[0] || null;
    actions.replaceWith(this.renderInfoActions(selected));
  },

  // Re-render just the trained-word chip list, not the whole info panel.
  refreshTrainedWordChips() {
    const chips = this.querySurface(".krc-chip-list");
    if (!chips) {
      return;
    }
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || this.loras[0] || null;
    chips.replaceWith(this.renderTrainedWordChips(selected));
  },

  // Re-render just the info-panel thumbnail (e.g. blur on/off after an NSFW toggle),
  // without rebuilding fields/footer. Mirrors refreshInfoActions.
  refreshInfoThumb() {
    const thumb = this.querySurface(".krc-info-thumb");
    if (!thumb) {
      return;
    }
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || this.loras[0] || null;
    thumb.replaceWith(this.renderInfoThumb(selected));
  },

  renderInfoLeft(selected) {
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
      this.renderField("CATEGORY", selected?.category || "", (value) => {
        if (selected) {
          selected.category = value;
          this.markMetadataEdited();
        }
      }),
      this.renderField("BASE MODEL", selected?.baseModel || "", (value) => {
        if (selected) {
          selected.baseModel = value;
          this.markMetadataEdited();
        }
      }),
      this.renderCollectionControl(selected),
      this.renderDuplicateControl(selected)
    );
    return left;
  },

  renderDuplicateControl(selected) {
    const wrap = document.createElement("div");
    wrap.className = "krc-duplicate-row";
    const paths = Array.isArray(selected?.duplicatePaths) ? selected.duplicatePaths : [];
    if (paths.length < 2) {
      return wrap;
    }
    const button = document.createElement("button");
    button.className = "krc-action-button krc-duplicate-button";
    button.type = "button";
    button.textContent = `DUPLICATE LORA (${paths.length})`;
    button.title = `${paths.length} copies of this LoRA on disk — the oldest is loaded`;
    button.addEventListener("click", () => this.showDuplicatePaths(selected));
    stopCanvasEvents(button);
    wrap.append(button);
    return wrap;
  },

  // "+ COLLECTION": add/remove this model or LoRA to/from any Collection (a named, cross-node
  // link of models + LoRAs; membership lives in the shared store, not on the record). A stable
  // content id is required to join, so the button is disabled until the file is stabilized.
  // Repurposes the info-panel slot the removed metadata-pairing control used to hold.
  renderCollectionControl(selected) {
    const row = document.createElement("div");
    row.className = "krc-collection-row";
    if (!selected) {
      return row;
    }
    const memberId = String(selected.sha256 || "");
    const stableId = !!memberId && !memberId.startsWith("local-");
    const memberOf = stableId ? collectionsForMember(memberId) : [];

    const label = document.createElement("span");
    label.className = "krc-field-label";
    label.textContent = "Collections";

    const wrap = document.createElement("div");
    wrap.className = "krc-config krc-collection-menu-wrap";
    const button = document.createElement("button");
    button.className = "krc-action-button krc-collection-button" + (memberOf.length ? " is-member" : "");
    button.type = "button";
    button.textContent = memberOf.length ? `+ COLLECTION · ${memberOf.length}` : "+ COLLECTION";
    button.disabled = !stableId;
    button.title = !stableId
      ? "Stabilize this file first — a Collection links by content hash"
      : "Add or remove this file from Collections";

    const menu = document.createElement("div");
    menu.className = "krc-config-menu krc-collection-menu";
    menu.hidden = true;

    if (stableId) {
      // Fetch the collection list lazily on first open, then repopulate the (already-open) menu.
      button.addEventListener("click", () => {
        loadCollections().then(() => {
          if (!menu.hidden) this.buildCollectionMenu(menu, selected, button);
        });
      });
      this.wireMenu(button, menu);
      this.buildCollectionMenu(menu, selected, button);
    }
    wrap.append(button, menu);

    row.append(label, wrap);
    return row;
  },

  // Repopulate the collection popover from the shared cache: one row per collection — name
  // (left), a membership checkmark (right, toggles in place, menu stays open), then a "view"
  // eye button (right of the check) that opens the collection viewer where one exists (ML has
  // viewCollection; LL omits it until the Portal lands). A "New collection…" inline creator sits
  // at the bottom. This is a list-all interface: every collection shows, membership is the check.
  buildCollectionMenu(menu, selected, button) {
    const memberId = String(selected?.sha256 || "");
    if (!memberId) {
      return;
    }
    const source = this.metadataSyncSource?.();
    const canView = typeof this.viewCollection === "function";
    menu.replaceChildren();

    const syncButton = () => {
      const memberOf = collectionsForMember(memberId);
      button.textContent = memberOf.length ? `+ COLLECTION · ${memberOf.length}` : "+ COLLECTION";
      button.classList.toggle("is-member", !!memberOf.length);
    };

    const { collections } = collectionsCache();
    for (const collection of collections) {
      const item = document.createElement("div");
      item.className = "krc-collection-item";
      const isMember = (collection.members || []).includes(memberId);
      item.classList.toggle("is-checked", isMember);

      const name = document.createElement("span");
      name.className = "krc-collection-name";
      name.textContent = collection.name || "Untitled";
      name.title = collection.name || "Untitled";

      const check = document.createElement("span");
      check.className = "krc-collection-check";
      check.textContent = isMember ? "✓" : "";

      item.append(name, check);

      // Clicking the row (name/check region) toggles membership; the menu stays open.
      item.addEventListener("click", async (event) => {
        event.stopPropagation();
        const nowMember = item.classList.toggle("is-checked");
        check.textContent = nowMember ? "✓" : "";
        try {
          if (nowMember) {
            await addCollectionMember(collection.id, memberId, { source });
          } else {
            await removeCollectionMember(collection.id, memberId, { source });
          }
          syncButton();
        } catch {
          // Revert the optimistic check on failure.
          item.classList.toggle("is-checked");
          check.textContent = item.classList.contains("is-checked") ? "✓" : "";
        }
      });

      // Eye "view" button, right of the check — jumps to the collection in the viewer.
      if (canView) {
        const view = document.createElement("button");
        view.type = "button";
        view.className = "krc-collection-view";
        view.title = `View ${collection.name || "collection"}`;
        view.innerHTML = COLLECTION_VIEW_ICON;
        view.addEventListener("click", (event) => {
          event.stopPropagation();
          menu.dispatchEvent(new CustomEvent("krc-close"));
          this.viewCollection(collection.id);
        });
        stopCanvasEvents(view);
        item.append(view);
      }

      menu.append(item);
    }

    // "New collection…" — an inline name entry that creates the collection with this file in it.
    const creator = document.createElement("div");
    creator.className = "krc-collection-create";
    const input = document.createElement("input");
    input.className = "krc-collection-input";
    input.placeholder = "New collection…";
    input.maxLength = 60;
    const commit = async () => {
      const name = input.value.trim();
      if (!name) {
        return;
      }
      input.value = "";
      try {
        await createCollection(name, { memberId, source });
        this.buildCollectionMenu(menu, selected, button);
        syncButton();
      } catch {
        // Leave the menu as-is; the name stays for a retry.
        input.value = name;
      }
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit();
    });
    creator.append(input);
    menu.append(creator);
    stopCanvasEvents(menu);
  },

  // Repaint just the + COLLECTION row (called when a sibling surface changed the store).
  refreshCollectionControl() {
    const row = this.querySurface?.(".krc-collection-row");
    if (!row) {
      return;
    }
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || this.loras[0] || null;
    row.replaceWith(this.renderCollectionControl(selected));
  },

  showDuplicatePaths(selected) {
    const paths = Array.isArray(selected?.duplicatePaths) ? selected.duplicatePaths : [];
    if (paths.length < 2) {
      return;
    }
    const list = document.createElement("div");
    list.className = "krc-modal-list";
    paths.forEach((path, index) => list.append(this.duplicatePathRow(path, index)));
    openKrcModal({
      node: this.node,
      title: `Duplicate copies — ${selected.display_name || selected.filename || "LoRA"}`,
      body: [list],
    });
  },

  // One path row for a duplicate LoRA copy: LOADED/dupe tag, path, copy button.
  // Shared by the per-LoRA info-panel modal and the browser's all-duplicates modal.
  duplicatePathRow(path, index) {
    const row = document.createElement("div");
    row.className = "krc-modal-row krc-duplicate-path-row";
    const tag = document.createElement("span");
    tag.className = index === 0 ? "krc-duplicate-tag is-canonical" : "krc-duplicate-tag";
    tag.textContent = index === 0 ? "LOADED" : "dupe";
    tag.title = index === 0 ? "Oldest copy — this is the one that loads" : "Extra copy on disk";
    const text = document.createElement("span");
    text.className = "krc-duplicate-path-text";
    text.textContent = path;
    text.title = path;
    const copy = document.createElement("button");
    copy.className = "krc-action-button";
    copy.type = "button";
    copy.textContent = "copy";
    copy.addEventListener("click", () => this.copyText(path));
    row.append(tag, text, copy);
    return row;
  },

  renderInfoRight(selected) {
    const right = document.createElement("div");
    right.className = "krc-info-right";

    const trainedWordsLabel = this.renderLabel("TRAINED WORDS");
    const chips = this.renderTrainedWordChips(selected);

    const promptOne = this.renderPromptBox(selected, 0);
    const promptTwo = this.renderPromptBox(selected, 1);

    const description = document.createElement("textarea");
    description.className = "krc-textarea krc-description";
    description.value = selected?.description || "";
    description.addEventListener("input", (event) => {
      if (selected) {
        selected.description = event.target.value;
        this.markMetadataEdited();
      }
    });

    right.append(
      trainedWordsLabel,
      chips,
      this.renderLabel("EXAMPLE PROMPT 1"),
      promptOne,
      this.renderLabel("EXAMPLE PROMPT 2"),
      promptTwo,
      this.renderLabel("DESCRIPTION"),
      description
    );
    return right;
  },

  renderTrainedWordChips(selected) {
    const chips = document.createElement("div");
    chips.className = "krc-chip-list";
    const words = Array.isArray(selected?.trainedWords) ? selected.trainedWords : [];
    words.forEach((word, index) => {
      const chip = document.createElement("button");
      chip.className = "krc-chip krc-chip-editable";
      chip.type = "button";
      chip.textContent = word;
      chip.title = "Edit or clear trained word";
      stopCanvasEvents(chip);
      chip.addEventListener("click", (event) => this.editTrainedWord(selected, index, event.currentTarget));
      chips.append(chip);
    });
    const add = document.createElement("button");
    add.className = "krc-chip krc-chip-add";
    add.type = "button";
    add.textContent = "+ add";
    add.title = selected ? "Add a trained word" : "Select a LoRA first";
    add.disabled = !selected;
    stopCanvasEvents(add);
    if (selected) {
      add.addEventListener("click", (event) => this.addTrainedWord(selected, event.currentTarget));
    }
    chips.append(add);
    return chips;
  },

  addTrainedWord(selected, anchor) {
    this.openTrainedWordEditor({ selected, anchor, title: "Add Trained Word" });
  },

  editTrainedWord(selected, index, anchor) {
    if (!selected || !Array.isArray(selected.trainedWords)) {
      return;
    }
    this.openTrainedWordEditor({
      selected,
      index,
      anchor,
      value: selected.trainedWords[index] || "",
      title: "Edit Trained Word",
    });
  },

  commitNewTrainedWord(selected, value) {
    const word = String(value || "").trim();
    if (!selected || !word) return;
    const words = Array.isArray(selected.trainedWords) ? [...selected.trainedWords] : [];
    if (!words.includes(word)) words.push(word);
    selected.trainedWords = words;
    this.markMetadataEdited();
    this.refreshTrainedWordChips();
    this.refreshBrowserResults();
  },

  commitTrainedWord(selected, index, value) {
    if (!selected || !Array.isArray(selected.trainedWords)) {
      return;
    }
    const word = String(value || "").trim();
    const words = [...selected.trainedWords];
    if (word) {
      words[index] = word;
    } else {
      words.splice(index, 1);
    }
    selected.trainedWords = words;
    this.markMetadataEdited();
    this.refreshTrainedWordChips();
    this.refreshBrowserResults();
  },

  removeTrainedWord(selected, index) {
    if (!selected || !Array.isArray(selected.trainedWords)) {
      return;
    }
    const words = [...selected.trainedWords];
    words.splice(index, 1);
    selected.trainedWords = words;
    this.markMetadataEdited();
    this.refreshTrainedWordChips();
    this.refreshBrowserResults();
  },

  renderField(label, value, onInput, { limitToVisible = false } = {}) {
    const field = document.createElement("label");
    field.className = "krc-field";
    const text = document.createElement("span");
    text.className = "krc-field-label";
    text.textContent = label;
    const input = document.createElement("input");
    input.className = "krc-input";
    input.value = value;
    if (limitToVisible) {
      bindSingleLineFitLimit(input, onInput);
    } else {
      input.addEventListener("input", (event) => onInput?.(event.target.value));
    }
    field.append(text, input);
    return field;
  },

  renderLabel(label) {
    const element = document.createElement("div");
    element.className = "krc-field-label";
    element.textContent = label;
    return element;
  },

  openLoraInfo(sha256) {
    if (!sha256) {
      return;
    }
    this.selectLora(sha256, { focus: true });
  },

  // Buried escape hatch in the Options modal: a description + confirm-guarded button
  // that clears every unsaved metadata edit on this node and rebuilds the dirty
  // baselines, unsticking any phantom "modified" badge. Rare-use, so it's tucked at
  // the bottom of the modal rather than shown in the panel.
  renderResetEditsControl() {
    const wrap = document.createElement("div");
    wrap.className = "krc-options-troubleshoot";
    const desc = document.createElement("div");
    desc.className = "krc-options-description";
    desc.textContent = "Discard current unsaved edits. Fixes stuck modified states.";
    const button = document.createElement("button");
    button.className = "krc-action-button krc-options-reset";
    button.type = "button";
    button.textContent = "Clear unsaved edits";
    armConfirmButton(button, {
      restoreText: "Clear unsaved edits",
      armedText: "Confirm — discards edits",
      onConfirm: () => {
        button.closest(".krc-modal-overlay")?._krcModalClose?.();
        this.resetMetadataEditState();
      },
    });
    stopCanvasEvents(button);
    const cleanDesc = document.createElement("div");
    cleanDesc.className = "krc-options-description";
    cleanDesc.textContent = "Review and remove stale records left behind by moved or deleted files.";
    const cleanButton = document.createElement("button");
    cleanButton.className = "krc-action-button krc-options-reset";
    cleanButton.type = "button";
    cleanButton.textContent = "Clean stale records";
    cleanButton.addEventListener("click", () => {
      cleanButton.closest(".krc-modal-overlay")?._krcModalClose?.();
      this.reviewStaleMetadata();
    });
    stopCanvasEvents(cleanButton);
    wrap.append(button, desc, cleanButton, cleanDesc);
    return wrap;
  },

  wireMenu(button, menu) {
    const close = () => {
      menu.hidden = true;
      document.removeEventListener("click", onDocClick);
    };
    const onDocClick = () => close();
    menu.addEventListener("krc-close", close);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (menu.hidden) {
        menu.hidden = false;
        document.addEventListener("click", onDocClick);
      } else {
        close();
      }
    });
    stopCanvasEvents(button);
    stopCanvasEvents(menu);
  },

  renderPromptBox(selected, index) {
    const wrap = document.createElement("div");
    wrap.className = "krc-prompt-wrap";
    const prompt = document.createElement("textarea");
    prompt.className = "krc-textarea krc-prompt has-prompt-controls";
    prompt.value = selected?.examplePrompts?.[index] || "";
    prompt.addEventListener("input", (event) => {
      if (selected) {
        const prompts = Array.isArray(selected.examplePrompts) ? [...selected.examplePrompts] : [];
        prompts[index] = event.target.value;
        selected.examplePrompts = prompts;
        this.markMetadataEdited();
      }
    });
    const copy = document.createElement("button");
    copy.className = "krc-icon-button is-compact krc-prompt-copy";
    copy.type = "button";
    copy.textContent = "⧉";
    copy.title = "Copy prompt";
    copy.setAttribute("aria-label", "Copy example prompt");
    stopCanvasEvents(copy);
    copy.addEventListener("click", (event) => {
      event.stopPropagation();
      this.copyText(prompt.value);
    });
    wrap.append(prompt, copy);
    return wrap;
  },
};
