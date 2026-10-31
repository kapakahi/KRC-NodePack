// Shared browser-chrome methods for the model/LoRA browser family — the Model
// Library and LoRA Loadout browsers. These three methods (scheduleBrowserResultsRefresh,
// refreshBrowserResults, renderBrowser) were byte-identical in both nodes: the whole
// control strip (name/sort selects, favorite/color/nsfw/refresh/view), search, and
// the renderLibraryBrowser wiring. They live here once and are spread into each node's
// browserMethods object (which is Object.assign'd onto the controller prototype), so
// `this` is the controller at call time.
//
// Contract: the controller must implement (across its mixins) —
//   _browserSearchVersion, ensureLoraCardCache(), visibleLoras(), view, listThumbs,
//   renderVirtualLoraListInto(el), nsfwDisplayMode, querySurface(sel),
//   browserFooterCountText(n), browserFooterCountTitle(),
//   nameMode/setNameMode, sortMode/setSortMode, showFavorites/setShowFavorites,
//   colorFilter/setColorFilter, showNsfw/setShowNsfw, isLoadingLibrary, query,
//   refreshBrowser(opts), refreshInfo(), refreshLibraryAndPresets(), setBrowserView(v),
//   refreshFolderShell(), groupSource(), renderBrowserFooter(filtered).
//
// PV is not a consumer (different controls, facet chips, draft item, no folders); the
// LL preset slot is unrelated. See CARD_BROWSER_CONSOLIDATION_GAMEPLAN.md (Step 4b).
import { scheduleFrame, stopCanvasEvents } from "./dom.js";
import { browserListClass, BROWSER_VIEWS } from "./browser_views.js";
import { renderLibraryBrowser } from "./library_browser.js";
import { buildModelSearchHint } from "./search_hint_tooltip.js";
import { createBrowserSelectionUI } from "./browser_selection_ui.js";
import { modelBulkAttributes } from "./model_bulk_attributes.js";
import { modelSelectionOperation } from "./model_selection_jobs.js";

export const modelBrowserChromeMethods = {
  scheduleBrowserResultsRefresh() {
    scheduleFrame(this, "_browserResultsFrame", () => this.refreshBrowserResults());
  },

  refreshBrowserResults() {
    const list = this.querySurface(".krc-lora-list");
    const count = this.querySurface(".krc-visible-count");
    if (!list) {
      return;
    }

    this.ensureLoraCardCache();
    const filtered = this.visibleLoras();
    this.renderVirtualLoraListInto(list);
    if (count) {
      count.textContent = this.browserFooterCountText(filtered.length);
      count.title = this.browserFooterCountTitle();
    }
  },

  renderBrowser({ folderShell = null } = {}) {
    this._browserSelectionUI ||= createBrowserSelectionUI({
      attributes: modelBulkAttributes(this),
      items: () => this.visibleLoras(),
      allItems: () => this.loras,
      keyOf: (item) => this.keyOf(item),
      focusedKey: () => this.selectedSha,
      scope: () => [this.folder, this.collectionModeActive?.() ? this.activeCollectionId || "" : ""],
      filters: () => [this.query, this.showFavorites, this.colorFilter, this.showNsfw, this.nsfwDisplayMode, this.nameMode],
      isFiltered: () => Boolean(this.query || this.showFavorites || this.colorFilter || this.activeCollectionId || (this.folder && this.folder !== "__model_home__")),
      actions: (selected) => [
        ...(selected.some((item) => !this.isGenericModel?.(item)) ? [{ id: "fetch", label: "Fetch (LoRAs)", eligible: (item) => !this.isGenericModel?.(item), operation: modelSelectionOperation(this, "fetch") }] : []),
        { id: "stabilize", label: "Stabilize", eligible: (item) => String(item.sha256).startsWith("local-"), operation: modelSelectionOperation(this, "stabilize") },
      ],
    });
    const searchVersion = (this._browserSearchVersion = (this._browserSearchVersion || 0) + 1);
    const searchGuard = () => searchVersion === this._browserSearchVersion;

    this.ensureLoraCardCache();
    const filtered = this.visibleLoras();
    const list = document.createElement("div");
    list.className = browserListClass(this.view, { listThumbs: this.listThumbs });
    this.renderVirtualLoraListInto(list);

    const blurMode = this.nsfwDisplayMode === "blur";

    return renderLibraryBrowser({
      selectionUI: this._browserSelectionUI,
      tag: "section",
      panelClass: "krc-panel krc-browser",
      title: "Browser",
      controls: [
        {
          kind: "select",
          title: "Display LoRAs by saved title or filename",
          value: this.nameMode,
          options: [["title", "title"], ["filename", "file"]],
          stopEvents: stopCanvasEvents,
          onChange: (value) => { this.setNameMode(value); this.refreshBrowser({ focusSelection: true, keepFolders: true }); },
        },
        {
          kind: "select",
          className: "krc-browser-select krc-sort-select",
          title: "Sort LoRAs",
          value: this.sortMode,
          // Usage sorts are appended only when the node opts in (this.usageSortEnabled) —
          // LoRA Loadout emits usage, so its LoRAs carry counts; Model Library models have
          // no usage source, so they'd all sort as 0 and the options are omitted there.
          options: [["alpha", "A-Z"], ["alpha-desc", "Z-A"], ["date-desc", "Added ▼"], ["date-asc", "Added ▲"], ["mod-desc", "Modified ▼"], ["mod-asc", "Modified ▲"],
            ...(this.usageSortEnabled ? [["used-most", "Most Used"], ["used-recent", "Last Used"]] : [])],
          stopEvents: stopCanvasEvents,
          onChange: (value) => { this.setSortMode(value); this.refreshBrowser({ focusSelection: true, keepFolders: true }); },
        },
        {
          kind: "favorite",
          active: this.showFavorites,
          onClick: () => { this.setShowFavorites(!this.showFavorites); this.refreshBrowser({ focusSelection: true, keepFolders: true }); },
        },
        {
          kind: "color",
          value: this.colorFilter,
          onChange: (value) => { this.setColorFilter(value); this.refreshBrowser({ focusSelection: true, keepFolders: true }); },
        },
        {
          kind: "nsfw",
          active: this.showNsfw,
          className: "krc-nsfw-button",
          title: this.showNsfw
            ? (blurMode ? "NSFW LoRAs unblurred (click to blur)" : "Showing NSFW LoRAs (click to hide)")
            : (blurMode ? "NSFW LoRA thumbnails blurred (click to unblur)" : "Show NSFW LoRAs"),
          onClick: () => { this.setShowNsfw(!this.showNsfw); this.refreshBrowser({ focusSelection: true, keepFolders: true }); this.refreshInfo(); },
        },
        {
          kind: "refresh",
          title: this.isLoadingLibrary ? "Scanning library" : "Refresh library",
          loading: this.isLoadingLibrary,
          onClick: () => this.refreshLibraryAndPresets(),
        },
        {
          kind: "view",
          views: BROWSER_VIEWS,
          current: this.view,
          onChange: (view) => { this.setBrowserView(view); this.refreshBrowser({ focusSelection: true, keepFolders: true }); },
        },
      ],
      search: {
        value: this.query,
        hint: buildModelSearchHint,
        stopEvents: stopCanvasEvents,
        onInput: (value) => { if (!searchGuard()) return; this.query = value; this.refreshFolderShell(); this.scheduleBrowserResultsRefresh(); },
        onClear: () => { if (!searchGuard()) return; this.query = ""; this.refreshFolderShell(); this.scheduleBrowserResultsRefresh(); },
      },
      // folderShell (when passed by a keepFolders refresh) reuses the live rail node
      // instead of rebuilding it — the rail is unchanged by sort/filter/view/name
      // toggles (its counts are static, whole-library), so this skips renderFolders()
      // and preserves the rail's scroll for free. Only filter toggles pass it; folder
      // clicks / reloads go through the full path so the rail rebuilds when it must.
      slots: [folderShell || this.groupSource().render(), list, this.renderBrowserFooter(filtered)],
    });
  },
};
