import {
  BROWSER_LIST_GAP,
  BROWSER_LIST_CARD_HEIGHT,
  BROWSER_GRID_CARD_HEIGHT,
  BROWSER_GRID_COLUMNS,
  BROWSER_VIRTUAL_BUFFER_ROWS,
  GRID_VIEW_CARD_BUFFER,
  LIST_VIEW_CARD_BUFFER,
  SEARCH_FIELD_ALIASES,
  THUMB_LIST_CARD_HEIGHT,
} from "./constants.js";
import { stopCanvasEvents } from "./helpers.js";
import { browserEmptyNote, browserSkeletonShell, skeletonCount } from "../shared/browser_cards.js";
import { readCountHint } from "../shared/library_snapshot.js";

const SNAPSHOT_SOURCE = "models";
import { browserListClass } from "../shared/browser_views.js";
import { browserVirtualMetrics } from "../shared/browser_virtualization.js";
import { cachedBySignature, resetVersionedCache } from "../shared/card_cache.js";
import { el } from "../shared/dom.js";
import { modelBrowserChromeMethods } from "../shared/model_browser_chrome.js";
import { mountVirtualList, updateVirtualList, scrollVirtualListIntoView } from "../shared/library_browser.js";
import { openKrcModal } from "../shared/modal.js";
import { cachedFilterResult } from "../shared/search.js";
import { visibleLibraryItems } from "../shared/library_filter.js";
import { browserLabel, parseSearchToken, searchFieldText } from "./pure_helpers.js";

const LORA_CARD_CACHE_LIMIT = 48;

export const browserMethods = {
  // renderBrowser / refreshBrowserResults / scheduleBrowserResultsRefresh are shared
  // with LoRA Loadout — see shared/model_browser_chrome.js.
  ...modelBrowserChromeMethods,

  // Footer node for renderBrowser — a slot for the shared shell. Node-specific: the
  // visible count, the on-disk duplicate readout (click to list), and the scan status.
  renderBrowserFooter(filtered) {
    const footer = document.createElement("div");
    footer.className = "krc-footer";
    // First footer row: visible count (left) + duplicate total (right), so the
    // duplicate readout doesn't consume its own line of browser height.
    const countRow = document.createElement("div");
    countRow.className = "krc-footer-count-row";
    const count = document.createElement("div");
    count.className = "krc-visible-count";
    count.textContent = this.browserFooterCountText(filtered.length);
    count.title = this.browserFooterCountTitle();
    countRow.append(count);

    const dupeTotal = this.loras.filter((lora) => (lora.duplicateCount || 0) > 1).length;
    if (dupeTotal) {
      const dupes = document.createElement("div");
      dupes.className = "krc-duplicate-note";
      dupes.textContent = `${dupeTotal} duplicate${dupeTotal === 1 ? "" : "s"}`;
      dupes.title = `Click to list the ${dupeTotal} LoRA${dupeTotal === 1 ? " that has" : "s that have"} more than one copy on disk`;
      dupes.addEventListener("click", () => this.showAllDuplicates());
      stopCanvasEvents(dupes);
      countRow.append(dupes);
    }

    const scan = document.createElement("div");
    scan.className = "krc-scan-note";
    if (this.isLoadingLibrary) scan.classList.add("is-refreshing");
    scan.title = this.scanDetails();
    scan.textContent = this.status;
    footer.append(countRow, scan);
    return footer;
  },

  browserFooterCounts() {
    const safetensors = this.loras.reduce((total, lora) => total + Math.max(1, Number(lora.duplicateCount || 0)), 0);
    return {
      safetensors,
      total: this.loras.length,
    };
  },

  browserFooterCountText(visible) {
    const counts = this.browserFooterCounts();
    return `${visible} visible · ${counts.safetensors} files · ${counts.total} total`;
  },

  browserFooterCountTitle() {
    const counts = this.browserFooterCounts();
    return [
      "Visible follows the current folder, search, favorites, and NSFW filters.",
      "Files counts individual model files on disk, including duplicate copies.",
      "Total counts each unique model once.",
      `${counts.safetensors} file${counts.safetensors === 1 ? "" : "s"} · ${counts.total} total model${counts.total === 1 ? "" : "s"}`,
    ].join("\n");
  },

  parseSearchToken(token) {
    return parseSearchToken(token);
  },

  searchFieldText(lora, field) {
    return searchFieldText(lora, field, this.nameMode);
  },

  visibleLoras() {
    // Typing "duplicate"/"duplicates" is a shortcut filter for LoRAs that have
    // more than one physical copy on disk; other filters/sort still apply.
    const q = (this.query || "").trim().toLowerCase();
    const dupeOnly = q === "duplicate" || q === "duplicates";
    const folderSig = (this.folders || []).map((folder) => `${folder.name}:${folder.count}:${folder.pinned ? 1 : 0}`).join(",");
    const sig = [
      this._visibleLorasVersion || 0,
      this.loras?.length || 0,
      this.query || "",
      this.nameMode,
      this.showFavorites ? 1 : 0,
      this.colorFilter || "",
      this.showNsfw ? 1 : 0,
      this.nsfwDisplayMode || "hide",
      this.folder || "",
      this.activeCollectionId || "",
      this.sortMode,
      folderSig,
    ].join("|");
    return cachedFilterResult(this, sig, () => {
      const source = dupeOnly ? this.loras.filter((lora) => (lora.duplicateCount || 0) > 1) : this.loras;
      const items = visibleLibraryItems(source, {
        query: dupeOnly ? "" : this.query,
        aliases: SEARCH_FIELD_ALIASES,
        fieldText: (lora, field) => this.searchFieldText(lora, field),
        label: (lora) => this.browserLabel(lora),
        showFavorites: this.showFavorites,
        colorFilter: this.colorFilter,
        effectiveColor: (lora) => this.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
        showNsfw: this.showNsfw,
        nsfwDisplayMode: this.nsfwDisplayMode,
        groupMatch: (lora) => this.groupSource().matches(lora),
        sortMode: this.sortMode,
      });
      // Collection mode clusters members by model type (section headers in the shared list),
      // which needs same-type items contiguous. A stable sort by type groups them while keeping
      // the current sort order WITHIN each type.
      if (this.collectionModeActive()) {
        return [...items].sort((a, b) =>
          String(a.modelType || "other").localeCompare(String(b.modelType || "other")));
      }
      return items;
    }, {
      signatureProp: "_visibleLorasSig",
      cacheProp: "_visibleLorasCache",
    });
  },

  // ListSource seam for the shared virtualized list (shared/library_browser.js).
  // Mirror of LoRA Loadout's; the windowing core reads rows LIVE via visibleItems()
  // every update, so refreshLoraCard's old per-card snapshot swap is gone —
  // updateLibraryLora invalidates the visibleLoras() memo, so a cache-delete + update
  // re-renders the changed card from the fresh row. cardFor is the signature-hashed card.
  listSource() {
    if (this._listSource) return this._listSource;
    const ctl = this;
    this._listSource = {
      view: () => ctl.view,
      listClass: () => browserListClass(ctl.view, { listThumbs: ctl.listThumbs }),
      visibleItems: () => ctl.visibleLoras(),
      renderEmpty: () => ctl.renderEmptyLibrary(),
      metrics: (view) => ctl.virtualMetrics(view),
      keyOf: (lora) => ctl.keyOf(lora),
      cardFor: (lora) => ctl.cachedLoraCard(lora),
      selectedKey: () => ctl.selectedSha,
      selectItem: (lora) => ctl.selectLora(lora.sha256),
      // Opt-in section headers (shared list) — collection mode only: cluster members by model
      // type (raw, open-vocabulary — no "Other" collapse). Off in normal folder browsing, so the
      // flat fast path is used there.
      grouped: () => ctl.collectionModeActive(),
      _krcSectionLayoutToken: () => ctl._visibleLorasVersion || 0,
      groupOf: (lora) => String(lora?.modelType || "other"),
      renderGroupHeader: (key) => el("div", "krc-lora-type-header", { textContent: key.replace(/[_-]+/g, " ") }),
    };
    return this._listSource;
  },

  // HOME lists models from every type: always in the Portal (its menu cards are the Home
  // mode's, model_library/home_provider.js); on a node only with something in the search
  // box (the Stats page's cells fill the search this way), an empty search shows the menu.
  homeSearchActive() {
    if (this.folder !== "__model_home__" || this.collectionModeActive()) return false;
    return this.surface === "detached" || !!String(this.query || "").trim();
  },

  renderVirtualLoraListInto(list) {
    if (this.folder === "__model_home__" && !this.homeSearchActive()) {
      const homeMenu = this.renderHomeMenu();
      list.className = homeMenu.className;
      list.replaceChildren(...Array.from(homeMenu.childNodes));
      return;
    }
    // Collection mode reuses the SAME shared virtual list — members are just visibleLoras()
    // filtered to the active collection (groupSource.matches). No bespoke grid: identical
    // sizing / scrollbar / ring to the folder browser by construction.
    mountVirtualList(list, this.listSource());
  },

  updateVirtualLoraList(list) {
    updateVirtualList(list, this.listSource());
  },

  scrollVirtualLoraIntoView(sha256) {
    return scrollVirtualListIntoView(this.querySurface(".krc-lora-list"), this.listSource(), sha256);
  },

  virtualMetrics(view) {
    return browserVirtualMetrics(view, {
      listGap: BROWSER_LIST_GAP,
      listCardHeight: BROWSER_LIST_CARD_HEIGHT,
      thumbCardHeight: THUMB_LIST_CARD_HEIGHT,
      gridCardHeight: BROWSER_GRID_CARD_HEIGHT,
      gridColumns: BROWSER_GRID_COLUMNS,
      bufferRows: BROWSER_VIRTUAL_BUFFER_ROWS,
      listExtraBufferRows: LIST_VIEW_CARD_BUFFER,
      gridExtraBufferRows: GRID_VIEW_CARD_BUFFER,
    });
  },

  browserLabel(lora) {
    return browserLabel(lora, this.nameMode);
  },

  ensureLoraCardCache() {
    resetVersionedCache(this, "_loraCardCache", "_loraCardCacheVersion", `${this.loras.length}:${this.cardCacheEpoch}:${this.nameMode}:${this.nsfwDisplayMode}:${this.showNsfw ? 1 : 0}`);
  },

  cachedLoraCard(lora) {
    const key = lora.sha256;
    const signature = [
      this.view,
      this.selectedSha === lora.sha256 ? 1 : 0,
      this.draggedSha === lora.sha256 ? 1 : 0,
      this._stabilizing === lora.sha256 ? 1 : 0,
      lora.pinned ? 1 : 0,
      lora.display_name || "",
      lora.filename || "",
      lora.baseModel || "",
      lora.category || "",
      lora.favorite ? 1 : 0,
      lora.nsfw ? 1 : 0,
      lora.customBadge || "",
      this.shouldBlurNsfw?.(lora) ? 1 : 0,
      lora.thumbnailSha || lora.sha256 || "",
      lora.thumbnail ? 1 : 0,
      lora.thumbnailVersion || 0,
      this.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
      this.isMetadataModified?.(lora) ? 1 : 0,
      lora.duplicateCount || 0,
    ].join("|");
    return cachedBySignature(this._loraCardCache, key, signature, () => this.renderLoraCard(lora), {
      maxEntries: LORA_CARD_CACHE_LIMIT,
    });
  },

  renderEmptyLibrary() {
    // Cold start with nothing to show yet: skeleton placeholders read as loading
    // rather than empty. Only while a scan is actually in flight — a genuinely
    // empty library (scan done, zero models) still shows the real note.
    if ((this.isLoadingLibrary || this._initialLoadPending) && !this.loras.length) {
      return browserSkeletonShell(this.view, skeletonCount(readCountHint(SNAPSHOT_SOURCE)));
    }
    const roots = (this.scan?.roots || []).map((root) => `${root.exists ? "found" : "missing"}: ${root.path}`).join("\n");
    return browserEmptyNote(roots ? `${this.status}\n${roots}` : this.status);
  },

  scanDetails() {
    const roots = (this.scan?.roots || []).map((root) => `${root.exists ? "found" : "missing"}: ${root.path}`);
    const errors = this.scan?.errors || [];
    return [...roots, ...errors].join("\n");
  },

  // Footer duplicate-count click: one modal listing every duplicated LoRA with
  // all of its copy paths (oldest tagged LOADED). Reuses the info-panel row.
  showAllDuplicates() {
    const dupes = this.loras
      .filter((lora) => (lora.duplicateCount || 0) > 1)
      .sort((a, b) => (a.display_name || a.filename || "").localeCompare(b.display_name || b.filename || "", undefined, { sensitivity: "base" }));
    if (!dupes.length) {
      return;
    }
    const list = document.createElement("div");
    list.className = "krc-modal-list";
    dupes.forEach((lora) => {
      const group = document.createElement("div");
      group.className = "krc-duplicate-group";
      const name = document.createElement("div");
      name.className = "krc-duplicate-group-name";
      name.textContent = lora.display_name || lora.filename || "LoRA";
      group.append(name);
      (lora.duplicatePaths || []).forEach((path, index) => group.append(this.duplicatePathRow(path, index)));
      list.append(group);
    });
    openKrcModal({
      node: this.node,
      title: `Duplicate LoRAs (${dupes.length})`,
      body: [list],
    });
  },

  // Canonical item-key accessor (1d): a model is keyed by its sha256. Every seam that
  // needs the key — both descriptors, pinKey, findItem — reads it through here, so
  // "what identifies an item" lives in one place (mirrors PV's controller keyOf).
  keyOf(lora) {
    return lora.sha256;
  },

};
