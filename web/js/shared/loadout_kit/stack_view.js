// Loadout Kit stack view: the preset panel, the one stack (header + slots), slot cards,
// drag-drop and stack edits. RefMod Loadout's stack view made generic: cards come from
// the kit's provider, incoming drags are matched with the Card API's readCardDrag, and
// the field strip under each slot is generated from the descriptor (field_strip.js).
import { switchToggle } from "../browser_controls.js";
import { applyCardColorStyle } from "../card_colors.js";
import { clearKrcDragPayload, getKrcDragPayload, setKrcDragPayload } from "../drag_payload.js";
import { ensureLibraryHas } from "../library_wait.js";
import { armConfirmButton } from "../confirm_action.js";
import { createSearchableSelect } from "../searchable_select.js";
import { renderModelCard } from "../model_card.js";
import { missingSlotItem, pruneCardSnapshots, rememberCardSnapshot } from "../card_snapshots.js";
import { cardMatchesSource, cardRef } from "../card_api.js";
import { modalPaletteIdForNode } from "../node_palette.js";
import { appendFragment, stopCanvasEvents } from "../dom.js";
import { STACK_HEADER_HEIGHT, STACK_ID, STACK_WIDGET } from "./constants.js";
import { entryFieldValues } from "./fields.js";
import { parseJsonArray } from "./util.js";
import { PRESET_LINK_STATE, presetLinkSlot } from "../preset_link_ui.js";

// Picker-only sentinel for the virtual "--empty--" entry. Never stored in active_preset
// (that stays "" for both empty and unsaved); selecting it clears the stack.
const EMPTY_PRESET_PICK = "__krc_empty__";

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export const stackMethods = {
  renderStacks() {
    const column = document.createElement("div");
    column.className = "krc-stack-column";
    // The column is exactly preset panel + gap + stack (LL's sheet sizes it for LL mini).
    column.style.gridTemplateRows = `auto ${this.kit.stackHeight}px`;
    column.style.height = `${this.kit.domHeight}px`;
    column.style.maxHeight = `${this.kit.domHeight}px`;
    column.append(this.renderPresetPanel(), this.renderStack(STACK_ID));
    return column;
  },

  renderPresetPanel() {
    const kit = this.kit;
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
    if (statusBadge) modifiedSlot.append(statusBadge);

    const autoEnabled = Boolean(this.getWidget("auto_preset_link"));
    const auto = this.renderSwitchToggle("Auto", autoEnabled, () => {
      this.setWidget("auto_preset_link", !autoEnabled);
      // Turning Auto on loads what the link asks for, as the next run would.
      if (autoEnabled || !this.syncFromPresetLink()) this.refreshPresetPanel();
    }, `Auto-load the linked preset ${autoEnabled ? "on" : "off"}. It loads all ${kit.slots} slots.`);

    const browse = document.createElement("button");
    browse.className = "krc-browse-button";
    browse.type = "button";
    browse.textContent = "Browse";
    browse.title = `Open ${kit.noun} browser`;
    browse.addEventListener("click", () => this.openLibraryBrowser());
    controls.append(modifiedSlot, ...(this._presetLinkShown ? [auto] : []), browse, this.renderConfigMenu());
    header.append(title, controls);

    const row = document.createElement("div");
    row.className = "krc-preset-row";
    const prefixSelect = this.renderPresetPrefixSelect();
    const presetWrap = document.createElement("div");
    presetWrap.className = "krc-preset-select-wrap";
    const selectedPreset = this.getWidget("active_preset") || "";
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
      ["new", "Clear the stack for a new preset", () => this.pickEmptyPreset(), false],
      ["duplicate", "Duplicate selected preset", () => this.duplicatePreset(), !selectedPreset],
      ["delete", "Delete selected preset", () => this.deletePreset(), !selectedPreset],
      ["rename", "Rename selected preset", () => this.renamePreset(), !selectedPreset],
      ["save", "Save the stack as a preset", () => this.savePreset(), false],
    ].forEach(([label, buttonTitle, handler, disabled]) => {
      const button = document.createElement("button");
      button.className = "krc-action-button krc-preset-button";
      button.type = "button";
      button.textContent = label;
      button.title = buttonTitle;
      button.dataset.action = label;
      button.disabled = disabled;
      if (label === "delete") {
        armConfirmButton(button, { restoreText: label, onConfirm: handler });
      } else {
        button.addEventListener("click", handler);
      }
      if (label === "save") saveButton = button;
      actions.append(button);
    });
    // SAVE becomes OVERWRITE when the active preset is stale (a newer global exists).
    this.applyPresetSaveButton(saveButton);

    panel.append(header, row, actions);

    const missing = Array.isArray(this.missingLoras) ? this.missingLoras : [];
    if (missing.length) {
      const warning = document.createElement("div");
      warning.className = "krc-preset-warning";
      const count = missing.length;
      const noun = count === 1 ? kit.noun : kit.nounPlural;
      warning.textContent = `⚠ ${count} ${noun} from the last run ${count === 1 ? "is" : "are"} missing from the library and ${count === 1 ? "was" : "were"} skipped.`;
      warning.title = missing.map((entry) => entry?.id || "?").join("\n");
      panel.append(warning);
    }
    return panel;
  },

  renderPresetSearch() {
    // Rebuilt with the current presets on every panel render. The two virtual
    // pseudo-presets are display-only: active_preset stays "" for both.
    const state = this.presetSelectionState();
    const prefixFilter = this.currentPresetPrefixFilter();
    const allPrefixes = prefixFilter === "__all__";
    const filtered = this.presetsForPrefix(prefixFilter);
    const options = [
      { name: "--empty--", value: EMPTY_PRESET_PICK },
      ...filtered.map((item) => ({
        name: this.presetDisplayName(item),
        value: item.id,
        group: allPrefixes ? this.presetGroupLabel(item) : "",
      })),
    ];
    // Keep a real active preset visible in the button even when the group filter hides it.
    if (state.kind === "preset" && !filtered.some((item) => item.id === state.preset.id)) {
      options.push({
        name: this.presetDisplayName(state.preset),
        value: state.preset.id,
        group: allPrefixes ? this.presetGroupLabel(state.preset) : "",
      });
    }
    let value = "";
    if (state.kind === "preset") value = state.preset.id;
    else if (state.kind === "empty") value = EMPTY_PRESET_PICK;
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
        if (picked === EMPTY_PRESET_PICK) this.pickEmptyPreset();
        else this.handlePresetAction(picked);
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
        this.setWidget("preset_prefix_filter", value || "__all__");
        this.refreshPresetPanel();
      },
    });
    picker.el.classList.add("krc-preset-prefix-picker");
    return picker.el;
  },

  renderStack(stackId) {
    const panel = document.createElement("section");
    panel.className = "krc-panel krc-stack";
    // Header row + one FIXED row per slot: cards never stretch to fill (project rule);
    // the node's height follows from the slot count instead.
    panel.style.gridTemplateRows = `${STACK_HEADER_HEIGHT}px repeat(${this.kit.slots}, ${this.kit.rowHeight}px)`;
    panel.style.minHeight = `${this.kit.stackHeight}px`;
    panel.style.height = `${this.kit.stackHeight}px`;

    const header = document.createElement("div");
    header.className = "krc-panel-header";
    const title = document.createElement("span");
    title.textContent = this.kit.nounPlural;
    const controls = document.createElement("div");
    controls.className = "krc-stack-header-controls";
    const right = this.renderHeaderRight();
    if (right) controls.append(right);
    header.append(title, controls);
    panel.append(header);

    appendFragment(panel, Array.from({ length: this.kit.slots }, (_, index) => this.renderSlotRow(stackId, index)));
    return panel;
  },

  // ---- header extension (registerLoadout({ header: { right } })) ----------------------

  // What a header extension sees: the stack, card names, widgets, and a way to refresh
  // itself. Built once per panel.
  headerContext() {
    if (this._headerContext) return this._headerContext;
    this._headerContext = {
      node: this.node,
      root: this.root,
      kitId: this.kit.id,
      // Per-panel scratch space for the extension (e.g. a token-count cache).
      state: this.headerState,
      // Enabled and disabled entries in slot order: { id, slot, enabled, <field>: value }.
      entries: () => [...(this.stacks?.[STACK_ID] || [])]
        .sort((a, b) => a.order - b.order)
        .map((entry) => ({
          id: this.canonicalId(entry.sha256),
          slot: Number(entry.order),
          enabled: entry.enabled !== false,
          ...entryFieldValues(this.kit.fields, entry),
        })),
      // The library card for an id: { id, title, item } (item = the provider's record).
      card: (id) => {
        const item = this.loras?.find((lora) => lora.sha256 === id) || null;
        return { id, title: item?.display_name || item?.filename || id, item };
      },
      getWidget: (name) => this.getWidget(name),
      setWidget: (name, value) => this.setWidget(name, value),
      refresh: () => this.refreshHeader(),
      isDestroyed: () => Boolean(this._destroyed),
      // An extension's popover joins the strip editors: one open at a time, closed on render.
      closeEditor: () => this.closeFieldEditor(true),
      trackEditor: (editor) => { this._fieldEditor = editor; },
      themeId: () => modalPaletteIdForNode(this.node),
    };
    return this._headerContext;
  },

  renderHeaderRight() {
    const render = this.kit.options.header?.right;
    if (typeof render !== "function") return null;
    try {
      return render(this.headerContext()) || null;
    } catch (error) {
      console.warn(`[KRC Loadout ${this.kit.id}] header extension failed`, error);
      return null;
    }
  },

  // Re-render the header extension in place (after any stack or field change).
  refreshHeader() {
    const controls = this.root?.querySelector(".krc-stack > .krc-panel-header > .krc-stack-header-controls");
    if (!controls) return;
    const right = this.renderHeaderRight();
    controls.replaceChildren(...(right ? [right] : []));
  },

  renderSwitchToggle(label, enabled, onClick, title = "") {
    return switchToggle({ label, active: enabled, title, onClick });
  },

  // One slot row: the LL slot card with the field strip under it (when the kit has fields).
  renderSlotRow(stackId, index) {
    const row = document.createElement("div");
    row.className = "krc-kit-slot-row";
    row.classList.toggle("has-strip", this.kit.hasFields);
    row.dataset.slotIndex = String(index);
    row.append(this.renderSlot(stackId, index));
    if (this.kit.hasFields) row.append(this.renderFieldStrip(stackId, index));
    return row;
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
    const entrySha = this.canonicalId(entry.sha256);
    const known = this.loras.find((item) => item.sha256 === entrySha);
    // The Card API rule (shared/card_status.js) for an id-only entry: missing when the id
    // isn't in the library (aliases already followed) or its record is on an offline drive.
    const missing = !known || Boolean(known.unavailable);
    // A present card refreshes the slot's snapshot; a missing one is drawn from it.
    if (known) rememberCardSnapshot(this.node, entrySha, known);
    const item = known || missingSlotItem(this.node, entrySha);
    return renderModelCard(item, this.slotCardSource(), { stackId, index, entry, missing, entrySha });
  },

  // Re-render, in place, every slot showing this card (changes made elsewhere).
  refreshSlotCards(sha256) {
    if (!sha256 || !this.root) return;
    this.root.querySelectorAll(".krc-card-slot[data-slot-stack]").forEach((card) => {
      if (card.dataset.loraSha !== sha256) return;
      const row = card.closest(".krc-kit-slot-row") || card;
      row.replaceWith(this.renderSlotRow(card.dataset.slotStack, Number(card.dataset.slotIndex)));
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
      isSelected: () => false, // no info panel, so no selection to ring
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
      hasNotch: (item, key, opts) => !opts?.missing, // Info needs a real card
      resolveThumbnail: (item) => {
        // Prompt cards carry a ready URL; model cards use the Model Library route.
        if (item.__thumbUrl !== undefined) {
          return { url: item.__thumbUrl || "", previewVideoUrl: item.__previewVideoUrl || "", placeholderKind: "image", blurred: ctl.shouldBlurNsfw?.(item) };
        }
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
      nameText: (item) => (item.__missing ? (item.display_name || `Unknown ${ctl.kit.noun}`) : (item.display_name || ctl.keyOf(item))),
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
        kind: ctl.kit.source.kind,
        id: key,
        title: item.display_name || item.filename || key || ctl.kit.noun,
        actions: [
          {
            id: "info",
            icon: "i",
            label: "Info",
            title: ctl.cardInfoTitle(),
            onClick: () => ctl.openCardInfoFor(item),
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
      // Live lookup — stack state can be rebuilt by modified-badge checks.
      const live = this.entryAtSlot(stackId, index);
      if (!live) return;
      live.enabled = event.target.checked;
      this.persistStack(stackId);
      this.updatePresetStatusUi();
      this.refreshHeader();
    });
    enabled.addEventListener("click", (event) => event.stopPropagation());
    return enabled;
  },

  // Field values live in the strip, so the card keeps only remove.
  buildSlotTrailing(stackId, index) {
    const wrap = document.createElement("div");
    wrap.className = "krc-slot-trailing";
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
    wrap.append(remove);
    return wrap;
  },

  installSlotCardInteractions(card, item, opts) {
    const { stackId, index, entrySha, missing } = opts;
    card.draggable = true; // the whole card is the drag handle
    this.installSlotDropTarget(card, stackId, index);
    card.addEventListener("dragstart", (event) => {
      // Starting on an interactive control acts on it, not a reorder.
      if (event.target?.closest?.(".krc-enabled, .krc-strength, .krc-slot-remove, .krc-card-notch-button")) {
        event.preventDefault();
        return;
      }
      this.draggedSha = entrySha;
      card.classList.add("is-dragging");
      this.root.classList.add("is-dragging-lora");
      const payload = this.dragPayloadFor(missing ? {} : item, entrySha);
      setKrcDragPayload(payload);
      event.dataTransfer.effectAllowed = "move";
      // nodeId tags the origin so another node of this kit can tell an internal reorder
      // (same node → move) from a cross-node drop (different node → copy in).
      event.dataTransfer.setData(this.kit.entryMime, JSON.stringify({ stackId, index, nodeId: this.node?.id ?? null }));
      event.dataTransfer.setData(
        payload.kind === "prompt" ? "application/x-krc-prompt" : "application/x-krc-model",
        JSON.stringify(payload),
      );
      event.dataTransfer.setData("text/plain", entrySha);
    });
    card.addEventListener("dragend", () => {
      this.draggedSha = "";
      this.root.classList.remove("is-dragging-lora");
      card.classList.remove("is-dragging");
      clearKrcDragPayload();
    });
  },

  applyCardColor(element, item = {}, selected = false) {
    applyCardColorStyle(element, this.effectiveLoraCardColor?.(item) || item.cardColor || "", { selected });
  },

  installSlotDropTarget(slot, stackId, index) {
    slot.addEventListener("dragenter", (event) => {
      event.preventDefault();
      this.updateSlotDropState(slot, event.dataTransfer);
    });
    slot.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = this.slotDropAccepts(event.dataTransfer)
        ? (Array.from(event.dataTransfer.types || []).includes(this.kit.entryMime) ? "move" : "copy")
        : "none";
      this.updateSlotDropState(slot, event.dataTransfer);
    });
    slot.addEventListener("dragleave", (event) => {
      if (event.relatedTarget && slot.contains(event.relatedTarget)) return;
      this.clearSlotDropState(slot);
    });
    slot.addEventListener("drop", (event) => {
      event.preventDefault();
      const accepts = this.slotDropAccepts(event.dataTransfer);
      this.clearSlotDropState(slot);
      this.draggedSha = "";
      this.root.classList.remove("is-dragging-lora");
      if (!accepts) return;
      const source = this.parseDragSource(event.dataTransfer.getData(this.kit.entryMime));
      // Only an intra-node stack drag is a reorder; a stack card dragged from ANOTHER
      // node of this kit falls through to addToStack below and is copied in.
      if (source && String(source.nodeId) === String(this.node?.id ?? null)) {
        this.moveStackEntry(source.stackId, source.index, stackId, index);
        return;
      }
      const ref = this.droppedCard(event.dataTransfer);
      if (!ref) return;
      // A fresh node may still be loading its list: wait for it rather than drop nothing.
      ensureLibraryHas(this, ref.id).then(() => {
        if (!this._destroyed) this.addToStack(stackId, ref.id, index);
      });
    });
  },

  // The card being dropped, if it belongs to this kit's source: the in-page KRC drag
  // payload, else the drag's own JSON (Card API refs, either kind).
  droppedCard(dataTransfer) {
    const payload = getKrcDragPayload()
      || parseJson(dataTransfer?.getData?.("application/x-krc-model"))
      || parseJson(dataTransfer?.getData?.("application/x-krc-prompt"));
    const ref = payload ? cardRef(payload) : null;
    return cardMatchesSource(ref, this.kit.source) ? ref : null;
  },

  slotDropAccepts(dataTransfer) {
    const payload = getKrcDragPayload();
    if (payload?.kind) return cardMatchesSource(cardRef(payload), this.kit.source);
    return Array.from(dataTransfer?.types || []).includes(this.kit.entryMime);
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
    const source = parseJson(raw);
    if (source && source.stackId === STACK_ID && Number.isInteger(Number(source.index))) {
      return { stackId: source.stackId, index: Number(source.index), nodeId: source.nodeId ?? null };
    }
    return null;
  },

  addToStack(stackId, sha, index = this.firstOpenSlot(stackId)) {
    this.syncStackFromState(stackId);
    const stableSha = this.canonicalId(sha);
    if (!stableSha || index < 0 || index >= this.kit.slots) return;
    if (!this.loras.some((item) => this.canonicalId(item.sha256) === stableSha)) return;
    if (this.stacks[stackId].some((entry) => this.canonicalId(entry.sha256) === stableSha)) return;

    // Fields start at their defaults (an absent field reads as its default everywhere).
    const entry = { sha256: stableSha, enabled: true, order: index };
    this.stacks[stackId] = this.stacks[stackId].filter((item) => item.order !== index);
    this.stacks[stackId].push(entry);
    this.sortStack(stackId);
    this.persistStack(stackId);
    this.refreshStacks();
  },

  persistStack(stackId) {
    this.setWidget(STACK_WIDGET, JSON.stringify(this.stacks[stackId]));
    pruneCardSnapshots(this.node, this.stacks[STACK_ID].map((entry) => entry.sha256));
  },

  updatePresetStatusUi() {
    // A stack edit can change the status (clean <-> modified <-> stale), so rebuild the
    // badge and re-point the SAVE button in place.
    const slot = this.root.querySelector(".krc-preset-modified-slot");
    if (slot) {
      slot.querySelector(".krc-status-badge")?.remove();
      const badge = this.renderPresetStatusBadge();
      if (badge) slot.append(badge);
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
    if (fromIndex === toIndex) return;
    const moving = this.entryAtSlot(fromStackId, fromIndex);
    if (!moving) return;
    // Positional swap: the target slot's entry (if any) takes the vacated slot.
    const target = this.entryAtSlot(toStackId, toIndex);
    this.stacks[toStackId] = this.stacks[toStackId].filter((entry) => entry.order !== fromIndex && entry.order !== toIndex);
    this.stacks[toStackId].push({ ...moving, order: toIndex });
    if (target) this.stacks[toStackId].push({ ...target, order: fromIndex });
    this.sortStack(toStackId);
    this.persistStack(toStackId);
    this.refreshStacks();
  },

  syncStackFromState(stackId) {
    this.stacks[stackId] = parseJsonArray(this.getWidget(STACK_WIDGET), this.stacks[stackId])
      .filter((entry) => entry && (entry.sha256 || entry.id) && Number.isInteger(Number(entry.order)))
      .map((entry) => ({
        ...entry,
        sha256: this.canonicalId(String(entry.sha256 || entry.id || "")),
        order: Math.max(0, Math.min(this.kit.slots - 1, Number(entry.order))),
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
    for (let index = 0; index < this.kit.slots; index += 1) {
      if (!this.entryAtSlot(stackId, index)) return index;
    }
    return -1;
  },
};
