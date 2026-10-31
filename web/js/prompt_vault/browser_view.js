/*
 * KRC Prompt Vault — browser view (left column).
 * Renders the search/sort/view header, category chips, the card list, and
 * the footer. Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { el } from "./dom.js";
import { ALIASES, DRAFT_KEY, UNASSIGNED_CATEGORY, UNASSIGNED_LABEL, VIEWS, categoryLabel } from "./constants.js";
import { apiPost } from "./api.js";
import { apiSucceeded, toastApiError } from "../shared/api.js";
import { browserCountText, browserEmptyNote, browserSkeletonShell, skeletonCount, chipSkeletons } from "../shared/browser_cards.js";
import { readCountHint } from "../shared/library_snapshot.js";
import { CARD_COLOR_NONE, cardColorHex, normalizeCardColorId } from "../shared/card_colors.js";
import { chipEditor, chipStripShell, plainChip, splitChip, syncActiveChip } from "../shared/chip_strip.js";
import { buildColorSwatches } from "../shared/color_swatches.js";
import { browserListClass } from "../shared/browser_views.js";
import { browserVirtualMetrics } from "../shared/browser_virtualization.js";
import { cachedBySignature, resetVersionedCache } from "../shared/card_cache.js";
import { scheduleFrame, stopCanvasEvents } from "../shared/dom.js";
import {
  KRC_BROWSER_LIST_GAP,
  KRC_BROWSER_LIST_CARD_HEIGHT,
  KRC_BROWSER_GRID_CARD_HEIGHT,
  KRC_BROWSER_GRID_COLUMNS,
  KRC_BROWSER_VIRTUAL_BUFFER_ROWS,
  KRC_THUMB_LIST_CARD_HEIGHT,
} from "../shared/node_limits.js";
import { searchValuesForField } from "../shared/search.js";
import { renderModelCard } from "../shared/model_card.js";
import { clearKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { closeFloatingMenu, toggleFloatingMenu } from "../shared/floating_menu.js";
import { mountVirtualList, updateVirtualList, scrollVirtualListIntoView, renderLibraryBrowser } from "../shared/library_browser.js";
import { buildPromptSearchHint } from "../shared/search_hint_tooltip.js";
import { KRC_SYNC_LANES } from "../shared/sync_bus.js";
import { createBrowserSelectionUI } from "../shared/browser_selection_ui.js";

const PROMPT_CARD_CACHE_LIMIT = 48;

export const browserMethods = {
  renderBrowser({ chipShell = null } = {}) {
    this._browserSelectionUI ||= createBrowserSelectionUI({
      attributes: {
        read: (item, field) => item[field],
        apply: (ids, field, value) => this.bulkPromptAttributes(ids, field, value),
      },
      items: () => this.filtered(),
      allItems: () => this.items,
      keyOf: (item) => item.id || this.itemKey(item),
      cardKeyOf: (item) => this.itemKey(item),
      focusedKey: () => this.selKey,
      scope: () => this.activeCategory,
      filters: () => [this.query, this.favOnly, this.colorFilter, this.showNSFW, this.nsfwDisplayMode],
      isFiltered: () => Boolean(this.query || this.favOnly || this.colorFilter || this.activeCategory !== "__all__"),
      actions: () => [
        { id: "move", label: "Move to category…", operation: this.promptBulkOperation("move") },
        { id: "delete", label: "Delete", danger: true, operation: this.promptBulkOperation("delete") },
      ],
    });
    return renderLibraryBrowser({
      selectionUI: this._browserSelectionUI,
      tag: "div",
      panelClass: "krc-panel krc-browser-panel",
      actionsClass: "krc-header-controls",
      bodyClass: this.surface === "detached" ? "krc-browser-body has-profile-picker" : "krc-browser-body",
      controls: [
        {
          kind: "select",
          className: "krc-browser-select krc-sort-select",
          title: "Sort",
          value: this.sort,
          options: [["az", "A-Z"], ["za", "Z-A"], ["added_new", "Added ▼"], ["added_old", "Added ▲"], ["modified_new", "Modified ▼"], ["modified_old", "Modified ▲"], ["used_most", "Most Used"], ["used_recent", "Last Used"]],
          onChange: (value) => { this.setBrowserSort(value); this.refreshPromptList(); },
        },
        {
          kind: "favorite",
          active: this.favOnly,
          title: "Favorites only",
          onClick: () => { this.setFavoriteFilter(!this.favOnly); this.refreshBrowserPanel({ keepChips: true }); },
        },
        {
          kind: "color",
          value: this.colorFilter,
          onChange: (value) => { this.setColorFilter(value); this.refreshBrowserPanel({ keepChips: true }); },
        },
        {
          kind: "nsfw",
          active: this.showNSFW,
          className: "krc-nsfw-filter-button",
          title: this.nsfwFilterTitle(),
          onClick: () => {
            this.setShowNSFW(!this.showNSFW);
            if (this.shouldHideNSFW() && this.activeCategory !== "__all__" && this.categoryIsNsfw(this.activeCategory)) {
              this.activeCategory = "__all__";
              this.node.properties.pmActiveCategory = "__all__";
            }
            this.refreshCategoryBrowser({ list: true, header: true });
          },
        },
        {
          kind: "refresh",
          title: "Refresh prompts and LoRA Loadout presets",
          onClick: () => this.reload(true, { preserveActiveFocus: true }),
        },
        {
          kind: "view",
          views: VIEWS,
          current: this.view,
          onChange: (view) => { this.setBrowserView(view); this.refreshBrowserPanel({ keepChips: true }); },
        },
      ],
      search: {
        value: this.query,
        hint: buildPromptSearchHint,
        onInput: (value) => { this.query = value; this.refreshCategoryBrowser({ list: true }); },
        onClear: () => { this.query = ""; this.refreshCategoryBrowser({ list: true }); },
      },
      // chipShell (when passed by a keepChips refresh) reuses the live category-chip
      // node instead of rebuilding it — favorite/color/view toggles don't change the
      // chip set (visibleCategories depends only on the category list + NSFW filter)
      // or the active category, so this skips renderChips(). NSFW toggles and category
      // edits go through the full path so the chips rebuild when they must.
      slots: [...(this.surface === "detached" ? [this.renderProfileControl()] : []), chipShell || this.facet().render(), this.renderList(), this.renderFooter()],
    });
  },

  // The node-local draft is a synthetic browser item rendered as the top card in
  // the list (a real card shape: empty-thumb placeholder, "Unsaved Prompt" title,
  // Draft badge), scrolling with the rest. It is NOT in this.items / filtered(), so
  // it never counts toward the footer total and is unaffected by search/filter.
  draftItem() {
    const d = this.pvDraft() || {};
    return { __draft: true, category: d.category || UNASSIGNED_CATEGORY, name: d.name || "", cardColor: d.cardColor || "" };
  },
  browserItems() {
    const rows = this.filtered();
    return this.hasPvDraft() ? [this.draftItem(), ...rows] : rows;
  },

  renderChips() {
    // Chip DOM comes from the shared, drift-proof chip_strip primitives; PV supplies only the
    // category semantics (which chips exist, their color/pin/active, and the click/notch actions).
    const { shell, bg, scroll } = chipStripShell();
    if (this.categoryEditor) {
      scroll.classList.add("is-editing");
      scroll.append(this.renderCategoryEditor());
      shell.append(bg, scroll);
      return shell;
    }

    const mk = (label, value) => {
      // ALL and Unsorted (Unassigned) are plain, uneditable chips; a real category is a split chip with a
      // color, a pinned-bold label, and a notch that opens the category editor.
      if (value === "__all__" || value === UNASSIGNED_CATEGORY) {
        return plainChip({
          label,
          value,
          active: value === this.activeCategory,
          title: value === UNASSIGNED_CATEGORY ? "Show uncategorized prompts" : "",
          onSelect: (v) => this.setActiveCategory(v),
        });
      }
      return splitChip({
        label,
        value,
        active: value === this.activeCategory,
        pinned: this.categoryIsPinned(value),
        color: this.categoryColor(value),
        title: `Show ${label}`,
        notchTitle: "Category actions",
        onSelect: (v) => this.setActiveCategory(v),
        onOpenEditor: (v) => this.beginCategoryEdit(v),
      });
    };
    scroll.append(mk("ALL", "__all__"));
    // Cold start: prompts (and thus categories) not loaded yet — show skeleton chips
    // after the fixed ALL chip so the strip reads as pending filters, not an empty bar.
    if (this._loadingLibrary && !this.items.length) {
      scroll.append(chipSkeletons(6));
      shell.append(bg, scroll);
      return shell;
    }
    const categorySearchValues = searchValuesForField(this.query, ALIASES, "category");
    for (const cat of this.visibleCategories().filter((category) => this.categoryMatchesSearch(category, categorySearchValues))) {
      scroll.append(mk(categoryLabel(cat), cat));
    }
    shell.append(bg, scroll);
    return shell;
  },

  categoryMatchesSearch(category, values = []) {
    if (!values.length) {
      return true;
    }
    return values.every((value) => String(category || "").toLowerCase().includes(value));
  },

  renderCategoryEditor() {
    const state = this.categoryEditor;
    // Rendered by the shared chipEditor (chip_strip.js) so PV and Collections share one editor
    // layout; PV supplies its full action set (merge/purge/export) + the NSFW attribute.
    return chipEditor({
      inputValue: state.name,
      inputTitle: "Category name",
      message: this.categoryEditorMessage(state),
      messageTone: state.tone || "",
      attributes: this.renderCategoryAttributes(state),
      actions: [
        { label: state.mergeTarget ? "MERGE" : "SAVE", title: state.mergeTarget ? "Merge categories" : "Rename category", className: "is-save", onClick: () => this.commitCategoryEdit() },
        { label: state.deleteArm ? "MOVE?" : "DELETE", title: `Delete category and move prompts to ${UNASSIGNED_LABEL}`, className: "is-delete", confirming: !!state.deleteArm, onClick: () => this.deleteCategoryClick() },
        { label: state.purgeStage === 2 ? "SURE?" : state.purgeStage === 1 ? "PURGE?" : "PURGE", title: "Purge category and every prompt inside", className: "is-danger", confirming: !!state.purgeStage, onClick: () => this.purgeCategoryClick() },
        { label: "EXPORT", title: "Export this category as a .zip bundle", className: "is-export", onClick: () => this.exportCategory(state.category) },
        { label: "EXIT", title: "Cancel", className: "is-exit", onClick: () => this.cancelCategoryEdit() },
      ],
      onInput: (value) => {
        state.name = value;
        state.mergeTarget = null;
        state.deleteArm = false;
        state.purgeStage = 0;
        state.purgeReady = false;
        state.tone = "";
      },
      onEnter: () => this.commitCategoryEdit(),
      onEscape: () => this.cancelCategoryEdit(),
      onMount: (input) => scheduleFrame(this, "_categoryEditorFocusFrame", () => {
        if (input.isConnected) input.focus();
      }),
    });
  },

  renderCategoryAttributes(state) {
    const row = el("div", "krc-chip-editor-attrs");
    const toggles = el("div", "krc-chip-editor-attr-toggles");
    const nsfw = el("button", "krc-icon-button is-nsfw" + (state.nsfw ? " is-on" : ""), {
      title: state.nsfw ? "Category marked NSFW" : "Mark category NSFW",
    });
    nsfw.append(el("span", "krc-nsfw-glyph", { textContent: "⊘" }));
    nsfw.addEventListener("click", () => this.setCategoryNsfw(!state.nsfw));
    const pin = el("button", "krc-icon-button is-pin" + (state.pinned ? " is-on" : ""), {
      title: state.pinned ? "Category pinned" : "Pin category near top",
    });
    pin.append(el("span", "krc-pin-glyph"));
    pin.addEventListener("click", () => this.setCategoryPinned(!state.pinned));
    const swatches = buildColorSwatches({
      selected: state.cardColor || CARD_COLOR_NONE,
      onSelect: (id) => this.setCategoryColor(id),
      noneTitle: "No category color",
      className: "krc-chip-editor-swatches",
    });
    toggles.append(nsfw, pin);
    row.append(toggles, swatches);
    return row;
  },

  categoryEditorMessage(state) {
    const count = this.categoryPromptCount(state.category);
    if (state.mergeTarget) return `${state.mergeTarget} exists. Merge ${count} prompt${count === 1 ? "" : "s"} into it?`;
    if (state.purgeStage === 2) return `Last chance. ${count} prompt${count === 1 ? "" : "s"} will be deleted.`;
    if (state.purgeStage === 1) return `Purge deletes every prompt in this category.`;
    if (state.deleteArm) return `Delete category. ${count} prompt${count === 1 ? "" : "s"} will move to ${UNASSIGNED_LABEL}.`;
    if (state.tone === "danger" || state.tone === "warning") return state.message || "";
    return `Rename or manage ${count} prompt${count === 1 ? "" : "s"}.`;
  },

  categoryPromptCount(category) {
    const bucket = this.data?.[category];
    if (!bucket || typeof bucket !== "object") return 0;
    return Object.entries(bucket).filter(([name, value]) => name !== "__meta__" && value && typeof value === "object").length;
  },

  beginCategoryEdit(category) {
    clearTimeout(this._categoryDeleteTimer);
    clearTimeout(this._categoryPurgeTimer);
    this.categoryEditor = {
      category,
      name: category,
      deleteArm: false,
      purgeStage: 0,
      purgeReady: false,
      mergeTarget: null,
      message: "",
      tone: "",
      nsfw: this.categoryIsNsfw(category),
      pinned: this.categoryIsPinned(category),
      cardColor: this.categoryColor(category),
    };
    this.renderChipsOnly();
  },

  async setCategoryNsfw(value) {
    const state = this.categoryEditor;
    if (!state) return;
    const next = !!value;
    const previous = state.nsfw;
    state.nsfw = next;
    state.message = next
      ? (this.nsfwDisplayMode === "blur" ? "Category thumbnails blurred unless NSFW is unblurred." : "Category hidden unless NSFW is shown.")
      : "Category no longer marked NSFW.";
    state.tone = next ? "warning" : "";
    if (next && this.shouldHideNSFW()) {
      this.setShowNSFW(true);
    }
    this.renderChipsOnly();
    const res = await apiPost.call(this, "/save-category-meta", { category: state.category, nsfw: next });
    if (!apiSucceeded(res)) {
      state.nsfw = previous;
      toastApiError((msg) => this.toast(msg), res, "NSFW save failed");
      this.renderChipsOnly();
      return;
    }
    this.publishPromptLibrary(res.prompts || this.data, { lane: KRC_SYNC_LANES.METADATA });
    this.preserveSelectedPromptText();
    this.markCanvasDirty();
    this.refreshCategoryBrowser({ list: true, header: true });
  },

  async setCategoryPinned(value) {
    const state = this.categoryEditor;
    if (!state) return;
    const next = !!value;
    const previous = state.pinned;
    state.pinned = next;
    state.message = next ? "Category pinned near the top." : "Category unpinned.";
    state.tone = "";
    this.renderChipsOnly();
    const res = await apiPost.call(this, "/save-category-meta", { category: state.category, pinned: next });
    if (!apiSucceeded(res)) {
      state.pinned = previous;
      toastApiError((msg) => this.toast(msg), res, "Pin save failed");
      this.renderChipsOnly();
      return;
    }
    this.publishPromptLibrary(res.prompts || this.data, { lane: KRC_SYNC_LANES.METADATA });
    this.preserveSelectedPromptText();
    this.renderChipsOnly();
  },

  async setCategoryColor(value) {
    const state = this.categoryEditor;
    if (!state) return;
    const next = normalizeCardColorId(value);
    const previous = state.cardColor;
    state.cardColor = next;
    const hex = cardColorHex(next);
    state.message = hex ? "Category chip color saved." : "Category chip color cleared.";
    state.tone = "";
    this.renderChipsOnly();
    const res = await apiPost.call(this, "/save-category-meta", { category: state.category, cardColor: next });
    if (!apiSucceeded(res)) {
      state.cardColor = previous;
      toastApiError((msg) => this.toast(msg), res, "Color save failed");
      this.renderChipsOnly();
      return;
    }
    this.publishPromptLibrary(res.prompts || this.data, { lane: KRC_SYNC_LANES.METADATA });
    this.preserveSelectedPromptText();
    this.renderChipsOnly();
  },

  cancelCategoryEdit() {
    clearTimeout(this._categoryDeleteTimer);
    clearTimeout(this._categoryPurgeTimer);
    this.categoryEditor = null;
    this.renderChipsOnly();
  },

  async commitCategoryEdit() {
    const state = this.categoryEditor;
    if (!state) return;
    const category = state.category;
    const newCategory = (state.name || "").trim();
    if (!newCategory) {
      state.message = "Name is required.";
      state.tone = "warning";
      this.renderChipsOnly();
      return;
    }
    if (newCategory === category) { this.cancelCategoryEdit(); return; }
    const res = await apiPost.call(this, "/rename-category", { category, new_category: newCategory, merge: !!state.mergeTarget });
    if (!apiSucceeded(res)) {
      if (res?.conflict === "category_exists" && res.existing_category) {
        state.name = res.existing_category;
        state.mergeTarget = res.existing_category;
        state.message = `${res.existing_category} already exists.`;
        state.tone = "warning";
        this.renderChipsOnly();
        return;
      }
      toastApiError((msg) => this.toast(msg), res, "Rename failed");
      return;
    }
    this.applyCategoryMutation(res.prompts || this.data, category, newCategory);
  },

  deleteCategoryClick() {
    const state = this.categoryEditor;
    if (!state) return;
    if (state.deleteArm) {
      clearTimeout(this._categoryDeleteTimer);
      clearTimeout(this._categoryPurgeTimer);
      this.doDeleteCategorySafe();
      return;
    }
    clearTimeout(this._categoryPurgeTimer);
    state.deleteArm = true;
    state.purgeStage = 0;
    state.purgeReady = false;
    state.mergeTarget = null;
    state.tone = "warning";
    this.renderChipsOnly();
    this._categoryDeleteTimer = setTimeout(() => {
      if (this.categoryEditor) {
        this.categoryEditor.deleteArm = false;
        this.categoryEditor.tone = "";
      }
      this.renderChipsOnly();
    }, 3000);
  },

  async doDeleteCategorySafe() {
    const state = this.categoryEditor;
    if (!state) return;
    const category = state.category;
    const res = await apiPost.call(this, "/delete-category-safe", { category });
    if (!apiSucceeded(res)) {
      toastApiError((msg) => this.toast(msg), res, "Delete failed");
      return;
    }
    this.applyCategoryMutation(res.prompts || this.data, category, res.new_category || UNASSIGNED_CATEGORY);
  },

  purgeCategoryClick() {
    const state = this.categoryEditor;
    if (!state) return;
    clearTimeout(this._categoryDeleteTimer);
    state.deleteArm = false;
    state.mergeTarget = null;
    if (state.purgeStage === 2 && state.purgeReady) {
      this.doPurgeCategory();
      return;
    }
    state.purgeStage = state.purgeStage === 1 ? 2 : 1;
    state.purgeReady = state.purgeStage === 2;
    state.tone = "danger";
    this.renderChipsOnly();
    clearTimeout(this._categoryPurgeTimer);
    this._categoryPurgeTimer = setTimeout(() => {
      if (this.categoryEditor) {
        this.categoryEditor.purgeStage = 0;
        this.categoryEditor.purgeReady = false;
        this.categoryEditor.tone = "";
      }
      this.renderChipsOnly();
    }, 3500);
  },

  async doPurgeCategory() {
    const state = this.categoryEditor;
    if (!state) return;
    clearTimeout(this._categoryPurgeTimer);
    const category = state.category;
    const res = await apiPost.call(this, "/delete-category", { category });
    if (!apiSucceeded(res)) {
      toastApiError((msg) => this.toast(msg), res, "Purge failed");
      return;
    }
    this.applyCategoryMutation(res.prompts || this.data, category, null);
  },

  applyCategoryMutation(data, oldCategory, newCategory) {
    clearTimeout(this._categoryDeleteTimer);
    this.categoryEditor = null;
    this.publishPromptLibrary(data);
    if (newCategory) {
      if (this.activeCategory === oldCategory) this.activeCategory = newCategory;
      if (this.orig?.category === oldCategory) {
        this.orig = { category: newCategory, name: this.orig.name };
        this.selKey = this.keyOf(newCategory, this.orig.name);
      }
      if (this.draft?.category === oldCategory) {
        this.draft.category = newCategory;
        this.syncWidgetsFromDraft();
      }
      this.preserveSelectedPromptText();
    } else {
      if (this.activeCategory === oldCategory) this.activeCategory = "__all__";
      if (this.orig?.category === oldCategory) {
        this.selKey = null;
        this.orig = null;
        this.draft = null;
        this.clearPersistedDraft();   // deleted category's prompt shouldn't return as a draft on reload
      }
    }
    if (this.node.properties) this.node.properties.pmActiveCategory = this.activeCategory;
    this.refreshCategoryBrowser({ list: true, info: true });
  },

  refreshCategoryBrowser({ list = false, info = false, header = false } = {}) {
    this.renderChipsOnly();
    if (list) this.refreshPromptList();
    else this.updateBrowserFooter();
    if (header) this.updateNsfwFilterButton();
    if (info) this.refreshInfoPanel();
  },

  updateNsfwFilterButton() {
    const button = this.root.querySelector(".krc-nsfw-filter-button");
    if (!button) return;
    button.classList.toggle("is-active", this.showNSFW);
    button.title = this.nsfwFilterTitle();
  },

  nsfwFilterTitle() {
    const blurMode = this.nsfwDisplayMode === "blur";
    if (this.showNSFW) {
      return blurMode ? "NSFW thumbnails unblurred (click to blur)" : "Showing NSFW (click to hide)";
    }
    return blurMode ? "NSFW thumbnails blurred (click to unblur)" : "Show NSFW (hidden by default)";
  },

  renderChipsOnly() {
    const old = this.root.querySelector(".krc-chip-list-shell, .krc-chip-list");
    if (!old) return this.refreshBrowserPanel();
    old.replaceWith(this.renderChips());
  },

  updateActiveCategoryChips() {
    const wrap = this.root.querySelector(".krc-chip-list-scroll, .krc-chip-list");
    if (!wrap || this.categoryEditor) return false;
    return syncActiveChip(wrap, this.activeCategory);
  },

  renderList() {
    this.ensureCardCache();
    const list = el("div", browserListClass(this.view, { listThumbs: this.listThumbs }));
    list.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      const card = event.target.closest(".krc-lora-card");
      if (!card || !list.contains(card)) return;
      const key = decodeURIComponent(card.dataset.pmKey || "");
      if (key === DRAFT_KEY) { this.selectDraft(); return; }
      const item = this.findByKey(key);
      if (item) this.select(item);
    });
    this.renderVirtualPromptListInto(list);
    return list;
  },
  renderListOnly() {
    const old = this.root.querySelector(".krc-lora-list");
    if (!old) return this.refreshAll();
    const scroll = old.scrollTop;
    const fresh = this.renderList();
    old.replaceWith(fresh);
    fresh.scrollTop = scroll;
    this.updateVirtualPromptList(fresh);
    const foot = this.root.querySelector(".krc-footer");
    if (foot) foot.textContent = this.footerText();
  },

  // ListSource seam for the shared virtualized list (shared/library_browser.js).
  // Prompt Vault's cards are now signature-hashed like LoRA Loadout's (the 2026-08-21
  // card-cache decision) via cachedCard below. The shared core already re-reads
  // filtered() live on every update — the badge-flicker fix PV pioneered, now universal.
  listSource() {
    if (this._listSource) return this._listSource;
    const ctl = this;
    this._listSource = {
      view: () => ctl.view,
      listClass: () => browserListClass(ctl.view, { listThumbs: ctl.listThumbs }),
      visibleItems: () => ctl.browserItems(),
      renderEmpty: () => ctl.renderEmptyPrompts(),
      metrics: (view) => ctl.virtualMetrics(view),
      keyOf: (it) => ctl.itemKey(it),
      cardFor: (it) => ctl.cachedCard(it),
      selectedKey: () => ctl.selKey,
      selectItem: (it) => (it.__draft ? ctl.selectDraft() : ctl.select(it)),
    };
    return this._listSource;
  },

  // Cold start with nothing loaded yet: skeleton placeholders read as loading
  // rather than empty. Only while the initial load is in flight AND no prompts
  // exist at all — a filter that hides everything still shows "No prompts."
  renderEmptyPrompts() {
    if (this._loadingLibrary && !this.items.length) {
      return browserSkeletonShell(this.view, skeletonCount(readCountHint("prompts")));
    }
    if (this.promptTextSearchPending?.()) return browserEmptyNote("Searching prompt text…", "krc-footer");
    if (this._promptTextFailed && this.promptTextTerms?.().length) {
      return browserEmptyNote("Couldn't search prompt text.", "krc-footer");
    }
    return browserEmptyNote("No prompts.", "krc-footer");
  },

  renderVirtualPromptListInto(list) {
    mountVirtualList(list, this.listSource());
    this.scheduleVirtualPromptViewportUpdate?.();
  },

  updateVirtualPromptList(list) {
    updateVirtualList(list, this.listSource());
  },

  scrollVirtualPromptIntoView(key) {
    return scrollVirtualListIntoView(this.root.querySelector(".krc-lora-list"), this.listSource(), key);
  },

  virtualMetrics(view) {
    return browserVirtualMetrics(view, {
      listGap: KRC_BROWSER_LIST_GAP,
      listCardHeight: KRC_BROWSER_LIST_CARD_HEIGHT,
      thumbCardHeight: KRC_THUMB_LIST_CARD_HEIGHT,
      gridCardHeight: KRC_BROWSER_GRID_CARD_HEIGHT,
      gridColumns: KRC_BROWSER_GRID_COLUMNS,
      bufferRows: KRC_BROWSER_VIRTUAL_BUFFER_ROWS,
    });
  },

  ensureCardCache() {
    resetVersionedCache(this, "_cardCache", "_cardCacheVersion", `${this._itemsVersion || 0}:${this.nsfwDisplayMode || "hide"}:${this.showNSFW ? 1 : 0}`);
  },

  cachedCard(it) {
    const key = this.itemKey(it);
    return cachedBySignature(this._cardCache, key, this.cardSignature(it), () => this.renderCard(it), {
      maxEntries: PROMPT_CARD_CACHE_LIMIT,
    });
  },

  // Every field renderCard depends on, so a scrolled-away card that changed state
  // rebuilds when it returns (explicit edits also cache-delete + update, but scroll
  // relies on this). The cache is version-reset on _itemsVersion/nsfw (ensureCardCache);
  // this catches the per-render volatile state that changes without that bump —
  // selection, draft overlay (colour + badges), pinned, view. Selection stays in the
  // signature (LL/ML's proven Safari-smooth model); thumb fields mirror thumbUrl().
  cardSignature(it) {
    const key = this.itemKey(it);
    if (it.__draft) {
      // Draft card volatile state: selection + the title it shows.
      return ["draft", this.view, key === this.selKey ? 1 : 0, (it.name || "").trim(), it.cardColor || ""].join("|");
    }
    const modified = key === this.modifiedKey() ? 1 : 0;
    const shown = modified && this.draft ? { ...it, ...this.draft } : it;
    return [
      this.view,
      key === this.selKey ? 1 : 0,
      modified,
      it.pinned ? 1 : 0,
      it.name || "",
      it.category || "",
      it.model || "",
      shown.favorite ? 1 : 0,
      shown.nsfw ? 1 : 0,
      shown.customBadge || "",
      shown.cardColor || "",
      this.shouldBlurNSFW?.(it) ? 1 : 0,
      it.id || "",
      it.hasThumb ? 1 : 0,
      it.thumbType || "",
      it.thumbHasPoster ? 1 : 0,
      it.thumbnailVersion || "",
      it.dateModified || "",
    ].join("|");
  },

  // Facet seam (Beat 1): Prompt Vault's category chips modelled as a single-select
  // Facet (chips), NOT a group rail — the 2026-08-21 seam decision (folders are the
  // only GroupSource; categories and the future model Quantization are Facets). The
  // browser shell renders the chip strip and reads the active category through this;
  // the editable category manager is the facet's edit capability (PV-only). `matches`
  // is the single-select category predicate — the facet counterpart to a GroupSource's
  // matches — so filtered() reads the category filter through the seam, not inline.
  facet() {
    if (this._facet) return this._facet;
    const ctl = this;
    this._facet = {
      mode: "single",
      active: () => ctl.activeCategory,
      setActive: (value) => ctl.setActiveCategory(value),
      values: () => ctl.visibleCategories(),
      render: () => ctl.renderChips(),
      matches: (item) => ctl.activeCategory === "__all__" || item.category === ctl.activeCategory,
    };
    return this._facet;
  },

  // ItemSource descriptor for the Layer-1 card primitive. Bound once to this
  // controller; its seams read this.draft/selKey/etc. live. The draft overlay
  // applies only to colour + badges (not name/thumb/subtitle), so it is merged
  // inside those two seams — never handed down pre-merged (see model_card.js).
  cardSource() {
    if (this._cardSource) return this._cardSource;
    const ctl = this;
    const merged = (item, modified) => (modified && ctl.draft ? { ...item, ...ctl.draft } : item);
    this._cardSource = {
      keyOf: (item) => ctl.itemKey(item),
      setCardKey: (card, item, key) => { card.dataset.pmKey = ctl.attrKey(key); },
      isSelected: (item) => (item.__draft ? ctl.isDraftActive() : ctl.keyOf(item.category, item.name) === ctl.selKey),
      isModified: (item) => !item.__draft && ctl.keyOf(item.category, item.name) === ctl.modifiedKey(),
      cardColor: (item, modified) => merged(item, modified)?.cardColor || "",
      resolveThumbnail: (item) => {
        if (item.__draft) return { url: "", placeholderKind: "image", blurred: false };
        const isVideoThumb = item.thumbType === "video";
        return {
          previewVideoUrl: isVideoThumb ? ctl.thumbUrl(item, "animated") : "",
          url: isVideoThumb && item.thumbHasPoster ? ctl.thumbUrl(item, "poster") : (isVideoThumb ? "" : ctl.thumbUrl(item)),
          placeholderKind: isVideoThumb ? "video" : "image",
          blurred: ctl.shouldBlurNSFW?.(item),
        };
      },
      nameText: (item) => (item.__draft ? ((item.name || "").trim() || "Unsaved Prompt") : (item.name || "(unnamed)")),
      subtitleText: (item) => (item.__draft ? categoryLabel(item.category || "") : [categoryLabel(item.category), item.model].filter(Boolean).join(" · ")),
      fillBadgeRow: (row, item, modified) => ctl.fillBadgeRow(row, item.__draft ? item : merged(item, modified), modified),
      isPinned: (item) => !item.__draft && item.pinned,
      hasNotch: (item) => !item.__draft, // thumb-list + list side-rail; grid footer strip
      notchMenu: (item, key) => ({
        context: "browser",
        kind: "prompt",
        id: key,
        title: item?.name || "Prompt",
        quickActions: {
          color: {
            value: merged(item, ctl.keyOf(item.category, item.name) === ctl.modifiedKey())?.cardColor || "",
            title: "Prompt color",
            onChange: (value) => ctl.quickSetPromptCardColor(item, value),
          },
          customBadge: {
            visible: true,
            active: !!item.customBadge,
            value: item.customBadge || "",
            title: "Letters, numbers, spaces. 10 max.",
            onSave: (value) => ctl.quickSetPromptCustomBadge(item, value),
          },
          favorite: {
            active: !!item.favorite,
            title: item.favorite ? "Remove favorite" : "Favorite",
            onToggle: () => ctl.quickTogglePromptCardFlag(item, "favorite"),
          },
          pin: {
            active: !!item.pinned,
            title: item.pinned ? "Unpin prompt" : "Pin prompt",
            onToggle: () => ctl.quickTogglePromptCardFlag(item, "pinned"),
          },
          nsfw: {
            active: !!item.nsfw,
            title: item.nsfw ? "Clear NSFW" : "Mark NSFW",
            onToggle: () => ctl.quickTogglePromptCardFlag(item, "nsfw"),
          },
        },
        actions: [
          {
            id: "copy-prompt-a",
            icon: "A",
            label: "Copy Prompt A",
            title: "Copy Prompt A to clipboard",
            onClick: () => ctl.copyPromptCardText(item, "prompt"),
          },
          {
            id: "copy-prompt-b",
            icon: "B",
            label: "Copy Prompt B",
            title: "Copy Prompt B to clipboard",
            onClick: () => ctl.copyPromptCardText(item, "promptB"),
          },
          {
            kind: "separator",
          },
          {
            id: "rename",
            icon: "✎",
            label: "Rename",
            title: "Rename this prompt",
            mode: "rename",
          },
          {
            id: "move",
            icon: "→",
            label: "Move",
            title: "Move this prompt to another category",
            mode: "move",
          },
          {
            id: "duplicate",
            icon: "⧉",
            label: "Duplicate",
            title: "Duplicate this prompt",
            onClick: () => ctl.duplicatePromptCard(item),
          },
          {
            id: "delete",
            icon: "×",
            label: "Delete",
            title: "Delete this prompt",
            danger: true,
            confirm: true,
            confirmLabel: "Delete?",
            onClick: () => ctl.deletePromptCard(item),
          },
        ],
        rename: {
          value: item.name || "",
          placeholder: "Name",
          title: "Prompt name",
          normalize: (value) => {
            const name = String(value || "").trim();
            return name ? name : null;
          },
          onSave: (value) => ctl.renamePromptCard(item, value),
        },
        modes: {
          move: (_cfg, _context, setMode) => ctl.renderPromptMovePicker(item, setMode),
        },
      }),
      // Prompt cards are draggable so their prompt text can be snapshotted into a
      // Config Switcher raw STRING field. The payload carries only the record
      // identity (category + name); the heavy prompt text is hydrated on drop via
      // GET /prompt-detail. Clicks stay on the list-level delegated handler (see
      // renderList) — we wire drag only here, so selection is untouched. The unsaved
      // draft card isn't a persisted record, so it isn't draggable.
      installInteractions: (card, item) => {
        if (item.__draft) return;
        card.draggable = true;
        card.addEventListener("dragstart", (event) => {
          const thumbUrl = item.thumbType === "video" && item.thumbHasPoster
            ? ctl.thumbUrl(item, "poster")
            : ctl.thumbUrl(item);
          const payload = {
            kind: "prompt",
            id: item.id || "",
            category: item.category || "",
            title: item.name || "",
            thumbnailUrl: thumbUrl || "",
            cardColor: merged(item, ctl.keyOf(item.category, item.name) === ctl.modifiedKey())?.cardColor || "",
            customBadge: item.customBadge || "",
            favorite: Boolean(item.favorite),
            nsfw: Boolean(item.nsfw),
          };
          card.classList.add("is-dragging");
          ctl.root.classList.add("is-dragging-prompt");
          setKrcDragPayload(payload);
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("application/x-krc-prompt", JSON.stringify(payload));
          event.dataTransfer.setData("text/plain", item.name || "");
        });
        card.addEventListener("dragend", () => {
          card.classList.remove("is-dragging");
          ctl.root.classList.remove("is-dragging-prompt");
          clearKrcDragPayload();
        });
      },
    };
    return this._cardSource;
  },

  renderCard(it) {
    return renderModelCard(it, this.cardSource());
  },

  // Sub-view for the card notch "Move" mode: a back button, a scrollable list of
  // target categories (color dot + name; the current one is omitted), and a
  // "+ New category" creator. Picking a category moves the prompt and closes the menu.
  renderPromptMovePicker(item, setMode) {
    const wrap = el("div", "krc-card-menu-move");

    const back = el("button", "krc-card-menu-mode-back", { textContent: "‹", title: "Back" });
    back.type = "button";
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMode("quick");
    });
    const head = el("div", "krc-card-menu-move-head");
    head.append(back, el("span", "krc-card-menu-move-title", { textContent: "Move to…" }));
    wrap.append(head);

    const list = el("div", "krc-card-menu-move-list");
    const targets = this.visibleCategories().filter((cat) => cat !== item.category);
    if (!targets.length) {
      list.append(el("div", "krc-card-menu-move-empty", { textContent: "No other categories" }));
    } else {
      for (const cat of targets) {
        const dot = el("span", "krc-card-menu-move-dot");
        const color = this.categoryColor(cat);
        const hex = color && color !== CARD_COLOR_NONE ? cardColorHex(color) : "";
        if (hex) dot.style.setProperty("--krc-move-dot", hex);
        else dot.classList.add("is-none");
        const label = el("span", "krc-card-menu-move-name", { textContent: cat });
        if (this.categoryIsPinned(cat)) label.classList.add("is-pinned");
        const row = el("button", "krc-card-menu-move-item", { type: "button", title: `Move to ${cat}` });
        row.append(dot, label);
        row.addEventListener("click", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (await this.movePromptCard(item, cat) !== false) closeFloatingMenu();
        });
        list.append(row);
      }
    }
    wrap.append(list);

    // "+ New category" — create it and move in one step.
    const input = el("input", "krc-card-menu-move-input", {
      type: "text",
      placeholder: "New category…",
      maxLength: 80,
    });
    const add = el("button", "krc-card-menu-move-add", { type: "button", textContent: "✓", title: "Create category and move here" });
    const commit = async () => {
      const name = input.value.trim();
      if (!name) return;
      if (await this.createCategoryAndMovePrompt(item, name) !== false) closeFloatingMenu();
    };
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") { event.preventDefault(); commit(); }
    });
    add.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); commit(); });
    const creator = el("div", "krc-card-menu-move-create");
    creator.append(input, add);
    wrap.append(creator);

    return wrap;
  },

  // True if a saved prompt named `name` (case-insensitive) already lives in `category`,
  // ignoring the prompt identified by `excludeKey` (so a same-slot re-casing isn't a
  // collision). Mirrors the backend's block-on-collision test for a client pre-check.
  promptExists(category, name, excludeKey = "") {
    const bucket = this.data?.[category];
    if (!bucket) return false;
    const target = String(name || "").trim().toLowerCase();
    if (!target) return false;
    for (const existingName of Object.keys(bucket)) {
      if (existingName === "__meta__") continue;
      if (existingName.toLowerCase() !== target) continue;
      if (excludeKey && this.keyOf(category, existingName) === excludeKey) continue;
      return true;
    }
    return false;
  },

  // Anchored confirm popover for a rename/move name collision. Resolves true to
  // overwrite the existing prompt, false to cancel (outside-click / Cancel / Esc).
  // Anchors to the source prompt's card when it's rendered, else the node root.
  confirmOverwritePopover(anchorKey, categoryName, promptName) {
    return new Promise((resolve) => {
      const anchor = this.cardForKey(anchorKey) || this.root;
      const menu = el("div", "krc-card-context-menu krc-overwrite-popover");
      const msg = el("div", "krc-overwrite-msg");
      msg.textContent = `“${promptName}” already exists in ${categoryName}.`;
      const sub = el("div", "krc-overwrite-sub", { textContent: "Overwrite it? This replaces its content." });
      const actions = el("div", "krc-overwrite-actions");
      const cancel = el("button", "krc-overwrite-btn", { type: "button", textContent: "Cancel" });
      const confirm = el("button", "krc-overwrite-btn is-danger", { type: "button", textContent: "Overwrite" });
      actions.append(cancel, confirm);
      menu.append(msg, sub, actions);
      stopCanvasEvents(menu);

      let settled = false;
      const done = (value) => {
        if (settled) return;
        settled = true;
        closeFloatingMenu();
        resolve(value);
      };
      cancel.addEventListener("click", (event) => { event.stopPropagation(); done(false); });
      confirm.addEventListener("click", (event) => { event.stopPropagation(); done(true); });
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") { event.stopPropagation(); done(false); }
      });
      // toggleFloatingMenu closes any menu currently open (e.g. the card notch popover
      // the rename/move was triggered from) before showing this one. Outside-click
      // closes it → resolve false (cancel).
      toggleFloatingMenu(anchor, menu, { align: "left", onClose: () => done(false) });
      // Focus the safe option so Esc/Enter resolve to Cancel by default.
      scheduleFrame(this, "_overwriteFocusFrame", () => { if (cancel.isConnected) cancel.focus(); });
    });
  },

  footerText() {
    return browserCountText(this.filtered().length, this.items.length);
  },
  updateBrowserFooter() {
    const foot = this.root.querySelector(".krc-browser-body > .krc-footer");
    if (foot) foot.textContent = this.footerText();
  },
  renderFooter() { return el("div", "krc-footer", { textContent: this.footerText() }); }
};
