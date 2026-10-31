import { applyCardColorStyle } from "../shared/card_colors.js";
import { switchToggle } from "../shared/browser_controls.js";
import { clearKrcDragPayload, getKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { ensureLibraryHas } from "../shared/library_wait.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { appendFragment } from "../shared/dom.js";
import { modalPaletteIdForNode } from "../shared/node_palette.js";
import { openNumericPopover } from "../shared/numeric_popover.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { LORA_STRENGTH_MAX, LORA_STRENGTH_MIN } from "./constants.js";
import { parseJsonArray } from "./pure_helpers.js";
import { setWidgetValue, stopCanvasEvents, widgetValue } from "./helpers.js";
import { renderModelCard } from "../shared/model_card.js";
import { missingSlotItem, pruneCardSnapshots, rememberCardSnapshot } from "../shared/card_snapshots.js";
import { openLibraryModal } from "../shared/library_modal.js";
import { PRESET_LINK_STATE, presetLinkSlot } from "../shared/preset_link_ui.js";

// Picker-only sentinel for the virtual "--empty--" entry. Never stored in
// active_preset (that stays "" for both empty and unsaved); selecting it clears the
// stacks. A uuid4-hex preset id can never collide with this token.
const EMPTY_PRESET_PICK = "__krc_empty__";

const STRENGTH_SLIDER_STEP = 0.1;
const STRENGTH_NUDGE_STEP = 0.01;
const STRENGTH_SLIDER_MIN = -1;
const STRENGTH_SLIDER_MAX = 3;

function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 1;
  }
  return Math.max(LORA_STRENGTH_MIN, Math.min(LORA_STRENGTH_MAX, number));
}

function formatStrength(value) {
  return clampStrength(value).toFixed(2);
}

function clampSliderStrength(value) {
  return Math.max(STRENGTH_SLIDER_MIN, Math.min(STRENGTH_SLIDER_MAX, clampStrength(value)));
}

function sanitizeStrengthInput(value) {
  let text = String(value ?? "").replace(/[^\d.-]/g, "");
  const negative = text.startsWith("-");
  text = text.replace(/-/g, "");
  const dotIndex = text.indexOf(".");
  if (dotIndex !== -1) {
    text = `${text.slice(0, dotIndex + 1)}${text.slice(dotIndex + 1).replace(/\./g, "")}`;
  }
  return `${negative ? "-" : ""}${text}`;
}

export const stackMethods = {
  renderStacks() {
    const column = document.createElement("div");
    column.className = "krc-stack-column";
    column.append(this.renderPresetPanel(), this.renderStack("A"), this.renderStack("B"));
    return column;
  },

  renderPresetPanel() {
    const panel = document.createElement("section");
    panel.className = "krc-panel krc-preset-panel";

    const header = document.createElement("div");
    header.className = "krc-panel-header";
    const title = document.createElement("div");
    title.className = "krc-preset-title";
    title.textContent = "Preset";
    const linkInfo = this.presetLinkInfo();
    // Auto only shows with a Prompt Vault on the preset input; refreshPresetLink re-renders
    // the row when that changes.
    this._presetLinkShown = linkInfo.state !== PRESET_LINK_STATE.NONE;
    title.append(presetLinkSlot(linkInfo));

    const controls = document.createElement("div");
    controls.className = "krc-preset-controls";
    const modifiedSlot = document.createElement("span");
    modifiedSlot.className = "krc-preset-modified-slot";
    const statusBadge = this.renderPresetStatusBadge();
    if (statusBadge) {
      modifiedSlot.append(statusBadge);
    }

    const autoEnabled = Boolean(widgetValue(this.node, "auto_preset_link"));
    const auto = this.renderSwitchToggle("Auto", autoEnabled, () => {
      setWidgetValue(this.node, "auto_preset_link", !autoEnabled);
      // Turning Auto on loads what the link asks for, as the next run would.
      if (autoEnabled || !this.syncFromPresetLink()) this.refreshPresetPanel();
    }, `Auto-load the linked preset ${autoEnabled ? "on" : "off"}. It loads all 12 slots.`);

    controls.append(modifiedSlot);
    if (this._presetLinkShown) controls.append(auto);
    if (this.surface === "mini") {
      const browse = document.createElement("button");
      browse.className = "krc-browse-button";
      browse.type = "button";
      browse.textContent = "Browse";
      browse.title = "Open LoRA browser";
      browse.addEventListener("click", () => this.openLibraryBrowser());
      controls.append(browse, this.renderConfigMenu());
    }
    header.append(title, controls);

    const row = document.createElement("div");
    row.className = "krc-preset-row";
    const prefixSelect = this.renderPresetPrefixSelect();
    const presetWrap = document.createElement("div");
    presetWrap.className = "krc-preset-select-wrap";
    const selectedPreset = widgetValue(this.node, "active_preset") || "";
    presetWrap.append(this.renderPresetSearch());

    const presetPrev = document.createElement("button");
    presetPrev.className = "krc-icon-button krc-info-cycle";
    presetPrev.type = "button";
    presetPrev.textContent = "▲";
    presetPrev.title = "Previous preset";
    presetPrev.setAttribute("aria-label", "Previous preset");
    presetPrev.disabled = !this.presets.length;
    presetPrev.addEventListener("click", () => this.cyclePreset(-1));
    const presetNext = document.createElement("button");
    presetNext.className = "krc-icon-button krc-info-cycle";
    presetNext.type = "button";
    presetNext.textContent = "▼";
    presetNext.title = "Next preset";
    presetNext.setAttribute("aria-label", "Next preset");
    presetNext.disabled = !this.presets.length;
    presetNext.addEventListener("click", () => this.cyclePreset(1));

    row.append(prefixSelect, presetWrap, presetPrev, presetNext);

    const actions = document.createElement("div");
    actions.className = "krc-preset-actions";
    let saveButton = null;
    [
      ["new", "Clear both stacks for a new preset", () => this.pickEmptyPreset(), false],
      ["duplicate", "Duplicate selected preset", () => this.duplicatePreset(), !selectedPreset],
      ["delete", "Delete selected preset", () => this.deletePreset(), !selectedPreset],
      ["rename", "Rename selected preset", () => this.renamePreset(), !selectedPreset],
      ["save", "Save both stacks as a preset", () => this.savePreset(), false],
    ].forEach(([label, title, handler, disabled]) => {
      const button = document.createElement("button");
      button.className = "krc-action-button krc-preset-button";
      button.type = "button";
      button.textContent = label;
      button.title = title;
      button.dataset.action = label;
      button.disabled = disabled;
      if (label === "delete") {
        armConfirmButton(button, {
          restoreText: label,
          onConfirm: handler,
        });
      } else {
        button.addEventListener("click", handler);
      }
      if (label === "save") {
        saveButton = button;
      }
      actions.append(button);
    });
    // SAVE becomes SYNC when the active preset is stale (a newer global exists).
    this.applyPresetSaveButton(saveButton);

    panel.append(header, row, actions);

    const missing = Array.isArray(this.missingLoras) ? this.missingLoras : [];
    if (missing.length) {
      const warning = document.createElement("div");
      warning.className = "krc-preset-warning";
      const count = missing.length;
      warning.textContent = `⚠ ${count} LoRA${count === 1 ? "" : "s"} from the last run ${count === 1 ? "is" : "are"} missing from the library and ${count === 1 ? "was" : "were"} skipped.`;
      warning.title = missing
        .map((entry) => `${entry?.stack || "?"}: ${entry?.id || "?"}`)
        .join("\n");
      panel.append(warning);
    }

    return panel;
  },

  renderPresetSearch() {
    // The panel re-renders on selection, so this picker is rebuilt each time
    // with the current presets; delegate to the shared searchable-select.
    // The two virtual pseudo-presets are display-only: active_preset stays "" for
    // both, and presetSelectionState() splits that into empty vs unsaved.
    const state = this.presetSelectionState();
    const prefixFilter = this.currentPresetPrefixFilter();
    const allPrefixes = prefixFilter === "__all__";
    const filtered = this.presetsForPrefix(prefixFilter);
    const options = [
      // The blank slate. Selecting it clears both stacks (silent — matches "new").
      { name: "--empty--", value: EMPTY_PRESET_PICK },
      ...filtered.map((item) => ({
        name: this.presetDisplayName(item),
        value: item.id,
        group: allPrefixes ? this.presetGroupLabel(item) : "",
      })),
    ];
    // Keep a real active preset visible in the button even when the group filter
    // hides it from the list, so its name never collapses into --empty--/--unsaved--.
    if (state.kind === "preset" && !filtered.some((item) => item.id === state.preset.id)) {
      options.push({
        name: this.presetDisplayName(state.preset),
        value: state.preset.id,
        group: allPrefixes ? this.presetGroupLabel(state.preset) : "",
      });
    }
    // value drives the button label: a real id → the preset name; the sentinel →
    // "--empty--"; "" (unsaved) → the placeholder, which reads "--unsaved--".
    let value = "";
    if (state.kind === "preset") {
      value = state.preset.id;
    } else if (state.kind === "empty") {
      value = EMPTY_PRESET_PICK;
    }
    return createSearchableSelect({
      options,
      value,
      placeholder: "--unsaved--",
      searchPlaceholder: "Search presets...",
      emptyText: "No presets found.",
      buttonTitle: "Pick a preset.",
      fixedMenu: true,
      menuWidth: 300,
      onSelect: (picked) => {
        if (picked === EMPTY_PRESET_PICK) {
          this.pickEmptyPreset();
        } else {
          this.handlePresetAction(picked);
        }
      },
    }).el;
  },

  renderPresetPrefixSelect() {
    const options = this.presetPrefixOptions().map(([value, name]) => ({ value, name }));
    const picker = createSearchableSelect({
      options,
      value: this.currentPresetPrefixFilter(),
      placeholder: "All",
      searchPlaceholder: "Search groups...",
      emptyText: "No groups found.",
      buttonTitle: "Preset group",
      ariaLabel: "Preset group",
      fixedMenu: true,
      menuWidth: 160,
      optionMenu: this.presetGroupMenu(),
      optionMenuTitle: "Group actions",
      onSelect: (value) => {
        this.resetPresetCycleSession();
        setWidgetValue(this.node, "preset_prefix_filter", value || "__all__");
        this.refreshPresetPanel();
      },
    });
    picker.el.classList.add("krc-preset-prefix-picker");
    return picker.el;
  },

  renderStack(stackId) {
    const panel = document.createElement("section");
    panel.className = "krc-panel krc-stack";

    const header = document.createElement("div");
    header.className = "krc-panel-header";
    const title = document.createElement("span");
    title.textContent = `Stack ${stackId}`;
    const controls = document.createElement("div");
    controls.className = "krc-stack-header-controls";
    const enabledName = `stack_${stackId.toLowerCase()}_enabled`;
    const stackEnabled = this.stackEnabledValue(widgetValue(this.node, enabledName));
    const power = this.renderSwitchToggle("Enabled", stackEnabled, () => {
      this.setStackEnabled(stackId, !stackEnabled);
    }, `${stackEnabled ? "Disable" : "Enable"} Stack ${stackId}`);
    controls.append(power);
    header.append(title, controls);
    panel.append(header);

    appendFragment(panel, Array.from({ length: 6 }, (_, index) => this.renderSlot(stackId, index)));

    return panel;
  },

  renderSwitchToggle(label, enabled, onClick, title = "") {
    return switchToggle({ label, active: enabled, title, onClick });
  },

  stackEnabledValue(value) {
    return value !== false && value !== "false" && value !== 0 && value !== "0";
  },

  setStackEnabled(stackId, enabled) {
    const enabledName = `stack_${stackId.toLowerCase()}_enabled`;
    setWidgetValue(this.node, enabledName, !!enabled);
    this.refreshStack(stackId);
    // The switches are part of the preset: re-check Modified / Stale / Conflict.
    this.updatePresetStatusUi?.();
  },

  renderSlot(stackId, index) {
    const entry = this.entryAtSlot(stackId, index);
    if (!entry) {
      const empty = document.createElement("div");
      empty.className = "krc-lora-card krc-card-slot is-empty";
      empty.textContent = "drag and drop here";
      this.installSlotDropTarget(empty, stackId, index);
      return empty;
    }
    const entrySha = this.canonicalId?.(entry.sha256) || entry.sha256;
    const known = this.loras.find((item) => item.sha256 === entrySha);
    // The Card API rule (shared/card_status.js) for an id-only entry: missing when the id
    // isn't in the library (aliases already followed) or its record is on an offline drive.
    const missing = !known || Boolean(known.unavailable);
    // A present card refreshes the slot's snapshot; a missing one is drawn from it.
    if (known) rememberCardSnapshot(this.node, entrySha, known);
    const item = known || missingSlotItem(this.node, entrySha);
    return renderModelCard(item, this.slotCardSource(), { stackId, index, entry, missing, entrySha });
  },

  // Re-render, in place, every stack slot showing this LoRA (thumb/badge/colour
  // changes made elsewhere).
  refreshSlotCards(sha256) {
    if (!sha256 || !this.root) return;
    this.root.querySelectorAll(".krc-card-slot[data-slot-stack]").forEach((card) => {
      if (card.dataset.loraSha !== sha256) return;
      card.replaceWith(this.renderSlot(card.dataset.slotStack, Number(card.dataset.slotIndex)));
    });
  },

  slotCardSource() {
    if (this._slotCardSource) return this._slotCardSource;
    const ctl = this;
    this._slotCardSource = {
      keyOf: (item) => ctl.keyOf(item),
      setCardKey: (card, item) => { card.dataset.loraSha = ctl.keyOf(item); },
      decorateCard: (card, item, opts) => {
        card.dataset.slotStack = opts.stackId;
        card.dataset.slotIndex = String(opts.index);
      },
      // Mini has no info panel, so there is no selection to ring.
      isSelected: (item) => ctl.surface !== "mini" && ctl.selectedSha === ctl.keyOf(item),
      cardColor: (item) => ctl.effectiveLoraCardColor?.(item) || item.cardColor || "",
      cardClass: (item, opts) => {
        // is-missing comes from renderModelCard (the shared missing look).
        const classes = ["krc-lora-card", "krc-card-slot"];
        if (opts?.entry?.enabled === false) classes.push("is-disabled");
        if (ctl.listThumbs) classes.push("krc-list-thumbs");
        // A missing card always keeps its badge row: MISSING must show.
        if (ctl.slotBadgeRow === false && !opts?.missing) classes.push("krc-no-badges");
        return classes.join(" ");
      },
      hasNotch: (item, key, opts) => !opts?.missing, // Info menu needs a real LoRA
      resolveThumbnail: (item) => {
        const isVideoThumb = item.thumbnailType === "video";
        return {
          previewVideoUrl: item.thumbnail && isVideoThumb ? ctl.thumbnailUrl(item, "animated") : "",
          url: item.thumbnail && isVideoThumb && item.thumbnailHasPoster
            ? ctl.thumbnailUrl(item, "poster")
            : (item.thumbnail && !isVideoThumb ? ctl.thumbnailUrl(item) : ""),
          placeholderKind: item.previewWithheld && !item.thumbnail
            ? "nsfw"
            : (item.thumbnailNeedsPoster || isVideoThumb ? "video" : "image"),
          blurred: ctl.shouldBlurNsfw?.(item),
        };
      },
      nameText: (item) => (item.__missing ? (item.display_name || "Unknown LoRA") : (item.display_name || ctl.keyOf(item))),
      subtitleText: () => "", // badges-only row 2
      fillBadgeRow: (row, item) => {
        let count = 0;
        if (item.favorite) {
          const star = document.createElement("span");
          star.className = "krc-badge-star";
          star.textContent = "★";
          row.append(star);
          count++;
        }
        if (item.nsfw) {
          const badge = document.createElement("span");
          badge.className = "krc-card-badge krc-nsfw-badge";
          badge.textContent = "NSFW";
          row.append(badge);
          count++;
        }
        if (item.customBadge) {
          const badge = document.createElement("span");
          badge.className = "krc-card-badge is-json";
          badge.textContent = item.customBadge;
          row.append(badge);
          count++;
        }
        return count;
      },
      notchMenu: (item, key) => ({
        context: "slot",
        kind: "lora",
        id: key,
        title: item.display_name || item.filename || key || "LoRA",
        actions: [
          {
            id: "info",
            icon: "i",
            label: "Info",
            title: "Open in Model Library",
            onClick: () => openLibraryModal({ provider: "models", scope: "lora", select: item, infoOpen: true }),
          },
        ],
      }),
      renderLeading: (item, opts) => ctl.buildSlotEnable(opts.stackId, opts.index, opts.entry),
      renderTrailing: (item, opts) => ctl.buildSlotTrailing(opts.stackId, opts.index, opts.entry),
      installInteractions: (card, item, key, opts) => ctl.installSlotCardInteractions(card, item, opts),
    };
    return this._slotCardSource;
  },

  buildSlotEnable(stackId, index, entry) {
    const enabled = document.createElement("input");
    enabled.className = "krc-enabled";
    enabled.type = "checkbox";
    enabled.checked = entry.enabled !== false;
    stopCanvasEvents(enabled);
    enabled.addEventListener("change", (event) => {
      // Live lookup — stack state can be rebuilt by modified-badge checks, orphaning
      // the captured entry (see the legacy handler's note).
      const live = this.entryAtSlot(stackId, index);
      if (!live) return;
      live.enabled = event.target.checked;
      this.persistStack(stackId);
      this.updatePresetStatusUi();
    });
    enabled.addEventListener("click", (event) => event.stopPropagation());
    return enabled;
  },

  buildSlotTrailing(stackId, index, entry) {
    const wrap = document.createElement("div");
    wrap.className = "krc-slot-trailing";
    const strength = document.createElement("button");
    strength.className = "krc-strength";
    strength.type = "button";
    strength.textContent = formatStrength(entry.strength ?? 1);
    strength.title = "Edit strength";
    strength.setAttribute("aria-label", `Edit Stack ${stackId} slot ${index + 1} strength`);
    stopCanvasEvents(strength);
    strength.addEventListener("click", (event) => {
      event.stopPropagation();
      this.openStrengthEditor(strength, stackId, index);
    });
    const remove = document.createElement("button");
    remove.className = "krc-slot-remove";
    remove.type = "button";
    remove.title = "Remove from stack";
    const glyph = document.createElement("span");
    glyph.className = "krc-slot-remove-glyph";
    glyph.textContent = "×";
    remove.append(glyph);
    stopCanvasEvents(remove);
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      this.removeFromStack(stackId, index);
    });
    wrap.append(strength, remove);
    return wrap;
  },

  installSlotCardInteractions(card, item, opts) {
    const { stackId, index, entrySha, missing } = opts;
    const lora = missing ? {} : item;
    card.draggable = true; // the whole card is the drag handle
    this.installSlotDropTarget(card, stackId, index);
    card.addEventListener("dragstart", (event) => {
      // Starting on an interactive control acts on it, not a reorder.
      if (event.target?.closest?.(".krc-enabled, .krc-strength, .krc-slot-remove, .krc-card-notch-button")) {
        event.preventDefault();
        return;
      }
      clearTimeout(this._stabilizeTimer);
      this.draggedSha = entrySha;
      card.classList.add("is-dragging");
      this.root.classList.add("is-dragging-lora");
      setKrcDragPayload({
        kind: "lora",
        id: entrySha,
        modelType: "lora",
        path: lora.path || "",
        relativePath: lora.relativePath || lora.relative_path || "",
        file: lora.filename || "",
        title: lora.display_name || lora.filename || entrySha,
        cardColor: this.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
        favorite: Boolean(lora.favorite),
      });
      event.dataTransfer.effectAllowed = "move";
      // nodeId tags the origin so another LL node's drop can tell an internal reorder
      // (same node → move) from a cross-node stack-card drop (different node → copy in).
      event.dataTransfer.setData("application/x-krc-stack-entry", JSON.stringify({ stackId, index, nodeId: this.node?.id ?? null }));
      event.dataTransfer.setData("application/x-krc-lora", entrySha);
      event.dataTransfer.setData("text/plain", entrySha);
    });
    card.addEventListener("dragend", () => {
      this.draggedSha = "";
      this.root.classList.remove("is-dragging-lora");
      card.classList.remove("is-dragging");
      clearKrcDragPayload();
      if (this.surface !== "mini") this.scheduleStabilize?.(this.selectedSha);
    });
    // Selecting feeds the info panel (and its dwell-to-stabilize); mini has neither, so a
    // slot click there does nothing.
    if (this.surface === "mini") return;
    card.addEventListener("click", () => {
      if (missing) this.selectMissingLora(entrySha);
      else this.selectLora(entrySha, { focus: true });
    });
  },

  setStackStrength(stackId, index, value) {
    // Fresh lookup because stack state can be rebuilt during modified-badge checks.
    const live = this.entryAtSlot(stackId, index);
    if (!live) {
      return null;
    }
    const nextStrength = Number(clampStrength(value).toFixed(3));
    const currentStrength = Number(clampStrength(live.strength ?? 1).toFixed(3));
    if (nextStrength === currentStrength) {
      return live.strength;
    }
    live.strength = nextStrength;
    this.persistStack(stackId);
    this.updatePresetStatusUi();
    return live.strength;
  },

  openStrengthEditor(anchor, stackId, index) {
    const live = this.entryAtSlot(stackId, index);
    if (!live) {
      return;
    }
    this.closeStrengthEditor?.(true);

    const initialValue = clampStrength(live.strength ?? 1);
    const editor = openNumericPopover({
      root: this.root,
      anchor,
      initialValue,
      classes: {
        popover: "krc-strength-popover",
        input: "krc-strength-value-input",
        slider: "krc-strength-slider",
        nudge: "krc-strength-nudge",
        sliderRow: "krc-strength-slider-row",
      },
      ariaLabel: "Edit LoRA strength",
      inputMode: "decimal",
      inputAriaLabel: "Strength value",
      slider: {
        min: STRENGTH_SLIDER_MIN,
        max: STRENGTH_SLIDER_MAX,
        step: STRENGTH_SLIDER_STEP,
        value: clampSliderStrength,
        ariaLabel: "Strength slider",
      },
      nudge: {
        step: STRENGTH_NUDGE_STEP,
        downTitle: "Decrease by 0.01",
        downAriaLabel: "Decrease strength by 0.01",
        upTitle: "Increase by 0.01",
        upAriaLabel: "Increase strength by 0.01",
      },
      themeId: modalPaletteIdForNode(this.node),
      formatValue: formatStrength,
      sanitizeInput: sanitizeStrengthInput,
      isPartialInput: (value) => !value || value === "-" || value === "." || value === "-.",
      normalizeValue: (value) => Number(clampStrength(value).toFixed(3)),
      onCommit: (draftValue) => {
        const committed = this.setStackStrength(stackId, index, draftValue);
        if (committed !== null && anchor.isConnected) {
          anchor.textContent = formatStrength(committed);
        }
      },
      onClose: ({ popover }) => {
        if (this._strengthEditor?.popover === popover) {
          this._strengthEditor = null;
        }
      },
    });
    this._strengthEditor = editor;
  },

  closeStrengthEditor(confirm = true) {
    this._strengthEditor?.close(confirm);
  },

  applyCardColor(element, lora = {}, selected = false) {
    applyCardColorStyle(element, this.effectiveLoraCardColor?.(lora) || lora.cardColor || "", { selected });
  },

  installSlotDropTarget(slot, stackId, index) {
    slot.addEventListener("dragenter", (event) => {
      event.preventDefault();
      this.updateSlotDropState(slot, event.dataTransfer);
    });
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = this.slotDropAccepts(event.dataTransfer)
        ? (Array.from(event.dataTransfer.types || []).includes("application/x-krc-stack-entry") ? "move" : "copy")
        : "none";
      this.updateSlotDropState(slot, event.dataTransfer);
    });
    slot.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && slot.contains(event.relatedTarget)) {
        return;
      }
      this.clearSlotDropState(slot);
    });
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      const accepts = this.slotDropAccepts(event.dataTransfer);
      this.clearSlotDropState(slot);
      this.draggedSha = "";
      this.root.classList.remove("is-dragging-lora");
      if (!accepts) {
        return;
      }
      const source = this.parseDragSource(event.dataTransfer.getData("application/x-krc-stack-entry"));
      // Only an intra-node stack drag is a reorder; a stack card dragged from ANOTHER
      // LL node falls through to addToStack below and is copied into this stack.
      if (source && String(source.nodeId) === String(this.node?.id ?? null)) {
        this.moveStackEntry(source.stackId, source.index, stackId, index);
        return;
      }
      const payload = getKrcDragPayload();
      const sha = event.dataTransfer.getData("application/x-krc-lora")
        || (payload?.kind === "lora" ? payload.id : "");
      if (!sha) return;
      // A fresh node may still be loading its list: wait for it rather than drop nothing.
      ensureLibraryHas(this, sha).then(() => {
        if (!this._destroyed) this.addToStack(stackId, sha, index);
      });
    });
  },

  slotDropAccepts(dataTransfer) {
    const payload = getKrcDragPayload();
    if (payload?.kind) {
      return payload.kind === "lora";
    }
    const types = Array.from(dataTransfer?.types || []);
    return types.includes("application/x-krc-stack-entry") || types.includes("application/x-krc-lora");
  },

  updateSlotDropState(slot, dataTransfer) {
    const accepts = this.slotDropAccepts(dataTransfer);
    slot.classList.toggle("is-drop-target", accepts);
    slot.classList.toggle("is-drop-reject", !accepts);
  },

  clearSlotDropState(slot) {
    slot.classList.remove("is-drop-target", "is-drop-reject");
  },

  parseDragSource(raw) {
    if (!raw) {
      return null;
    }
    try {
      const source = JSON.parse(raw);
      if ((source.stackId === "A" || source.stackId === "B") && Number.isInteger(Number(source.index))) {
        return { stackId: source.stackId, index: Number(source.index), nodeId: source.nodeId ?? null };
      }
    } catch {
      return null;
    }
    return null;
  },

  addToStack(stackId, sha, index = this.stacks[stackId].length) {
    this.syncStackFromState(stackId);
    const stableSha = this.canonicalId?.(sha) || sha;
    if (!stableSha || index < 0 || index > 5) {
      return;
    }
    if (!this.loras.some((lora) => (this.canonicalId?.(lora.sha256) || lora.sha256) === stableSha)) {
      return;
    }
    if (this.stacks[stackId].some((entry) => (this.canonicalId?.(entry.sha256) || entry.sha256) === stableSha)) {
      return;
    }

    const entry = { sha256: stableSha, enabled: true, strength: 1.0, order: index };
    this.stacks[stackId] = this.stacks[stackId].filter((item) => item.order !== index);
    this.stacks[stackId].push(entry);
    this.sortStack(stackId);
    this.persistStack(stackId);
    this.refreshStacks();
  },

  persistStack(stackId) {
    const name = stackId === "A" ? "stack_a_loras" : "stack_b_loras";
    setWidgetValue(this.node, name, JSON.stringify(this.stacks[stackId]));
    pruneCardSnapshots(this.node, [...this.stacks.A, ...this.stacks.B].map((entry) => entry.sha256));
  },

  updatePresetStatusUi() {
    // A stack edit can change the status (clean <-> modified <-> stale), so rebuild
    // the badge from the current status and re-point the SAVE/SYNC button. Cheap
    // enough to redo in place rather than tearing down the whole preset panel.
    const slot = this.root.querySelector(".krc-preset-modified-slot");
    if (slot) {
      const existing = slot.querySelector(".krc-status-badge");
      if (existing) {
        existing.remove();
      }
      const badge = this.renderPresetStatusBadge();
      if (badge) {
        slot.append(badge);
      }
    }
    this.applyPresetSaveButton(this.root.querySelector('.krc-preset-actions [data-action="save"]'));
  },

  removeFromStack(stackId, index) {
    this.syncStackFromState(stackId);
    this.stacks[stackId] = this.stacks[stackId].filter((item) => item.order !== index);
    this.sortStack(stackId);
    this.persistStack(stackId);
    this.refreshStacks();
  },

  moveStackEntry(fromStackId, fromIndex, toStackId, toIndex) {
    this.syncStackFromState(fromStackId);
    this.syncStackFromState(toStackId);
    if (fromStackId === toStackId && fromIndex === toIndex) {
      return;
    }

    const moving = this.entryAtSlot(fromStackId, fromIndex);
    if (!moving) {
      return;
    }

    const target = this.entryAtSlot(toStackId, toIndex);
    this.stacks[fromStackId] = this.stacks[fromStackId].filter((entry) => entry.order !== fromIndex);
    this.stacks[toStackId] = this.stacks[toStackId].filter((entry) => entry.order !== toIndex);

    this.stacks[toStackId].push({ ...moving, order: toIndex });
    if (target) {
      this.stacks[fromStackId].push({ ...target, order: fromIndex });
    }

    this.sortStack(fromStackId);
    this.sortStack(toStackId);
    this.persistStack(fromStackId);
    if (toStackId !== fromStackId) {
      this.persistStack(toStackId);
    }
    this.refreshStacks();
  },

  syncStackFromState(stackId) {
    const name = stackId === "A" ? "stack_a_loras" : "stack_b_loras";
    this.stacks[stackId] = parseJsonArray(widgetValue(this.node, name), this.stacks[stackId])
      .filter((entry) => entry && (entry.sha256 || entry.id) && Number.isInteger(Number(entry.order)))
      .map((entry) => ({
        ...entry,
        sha256: this.canonicalId?.(String(entry.sha256 || entry.id || "")) || String(entry.sha256 || entry.id || ""),
        order: Math.max(0, Math.min(5, Number(entry.order))),
      }));
    this.sortStack(stackId);
  },

  sortStack(stackId) {
    this.stacks[stackId].sort((a, b) => a.order - b.order);
  },

  entryAtSlot(stackId, index) {
    return this.stacks[stackId].find((entry) => entry.order === index);
  },

  firstOpenSlot(stackId) {
    this.syncStackFromState(stackId);
    for (let index = 0; index < 6; index += 1) {
      if (!this.entryAtSlot(stackId, index)) {
        return index;
      }
    }
    return -1;
  }
};
