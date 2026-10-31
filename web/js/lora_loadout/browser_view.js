import {
  BROWSER_LIST_GAP,
  BROWSER_LIST_CARD_HEIGHT,
  BROWSER_GRID_CARD_HEIGHT,
  BROWSER_GRID_COLUMNS,
  BROWSER_VIRTUAL_BUFFER_ROWS,
  FOLDER_TREE_HEIGHT,
  GRID_VIEW_CARD_BUFFER,
  LIST_VIEW_CARD_BUFFER,
  SEARCH_FIELD_ALIASES,
  THUMB_LIST_CARD_HEIGHT,
} from "./constants.js";
import { stopCanvasEvents } from "./helpers.js";
import { browserEmptyNote, browserSkeletonShell, skeletonCount, folderRowSkeletons, refreshBrowserCard } from "../shared/browser_cards.js";
import { readCountHint } from "../shared/library_snapshot.js";

const SNAPSHOT_SOURCE = "loras";
import { browserListClass } from "../shared/browser_views.js";
import { pinActionButton } from "../shared/browser_controls.js";
import { browserVirtualMetrics } from "../shared/browser_virtualization.js";
import { cachedBySignature, resetVersionedCache } from "../shared/card_cache.js";
import { cardColorHex, normalizeCardColorId } from "../shared/card_colors.js";
import { clearKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { buildColorSwatches } from "../shared/color_swatches.js";
import { queryDataAttrAny } from "../shared/dom.js";
import { renderModelCard } from "../shared/model_card.js";
import { createModelBrowserCardSource } from "../shared/model_browser_card_source.js";
import { modelBrowserChromeMethods } from "../shared/model_browser_chrome.js";
import { mountVirtualList, updateVirtualList, scrollVirtualListIntoView } from "../shared/library_browser.js";
import { openKrcModal } from "../shared/modal.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";
import { cachedFilterResult, searchValuesForField } from "../shared/search.js";
import { visibleLibraryItems } from "../shared/library_filter.js";
import {
  browserLabel,
  parseSearchToken,
  searchFieldText,
} from "./pure_helpers.js";

const LORA_CARD_CACHE_LIMIT = 48;

export const browserMethods = {
  // renderBrowser / refreshBrowserResults / scheduleBrowserResultsRefresh are shared
  // with Model Library — see shared/model_browser_chrome.js.
  ...modelBrowserChromeMethods,

  // Footer node for renderBrowser — a slot for the shared shell. LoRA-specific: the
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
    return `${visible} visible · ${counts.safetensors} safetensors · ${counts.total} total`;
  },

  browserFooterCountTitle() {
    const counts = this.browserFooterCounts();
    return [
      "Visible follows the current folder, search, favorites, and NSFW filters.",
      "Safetensors counts individual files on disk, including duplicate copies.",
      "Total counts each unique LoRA once.",
      `${counts.safetensors} safetensor file${counts.safetensors === 1 ? "" : "s"} · ${counts.total} total LoRA${counts.total === 1 ? "" : "s"}`,
    ].join("\n");
  },

  renderFolders() {
    const shell = document.createElement("div");
    shell.className = "krc-folder-shell";

    // Cold start: no folders yet — show skeleton rows so the rail doesn't read as an
    // empty column while the first scan runs (matches the list skeleton timing).
    if ((this.isLoadingLibrary || this._initialLoadPending) && !this.folders.length) {
      const skeleton = document.createElement("div");
      skeleton.className = "krc-folder-tree";
      skeleton.style.height = `${FOLDER_TREE_HEIGHT}px`;
      skeleton.append(folderRowSkeletons(8));
      shell.append(skeleton);
      return shell;
    }

    const tree = document.createElement("div");
    tree.className = "krc-folder-tree";
    tree.style.height = `${FOLDER_TREE_HEIGHT}px`;
    const folderSearchValues = searchValuesForField(this.query, SEARCH_FIELD_ALIASES, "folder");
    const rows = this.folders.filter((folder) => this.folderMatchesSearch(folder, folderSearchValues)).map((folder) => [
      folder.name,
      folder.count,
      folder.name === this.folder,
      folder.cardColor || "",
      !!folder.pinned,
      !!folder.scope || folder.name === "loras" || folder.name === "__root__",
    ]);

    rows.forEach(([name, count, active, cardColor, pinned, isScopeRow]) => {
      const row = document.createElement("div");
      row.className = `krc-folder-row ${active ? "is-active" : ""} ${pinned ? "is-pinned" : ""}`;
      row.dataset.folderName = name;

      const configButton = document.createElement("button");
      configButton.className = "krc-folder-color-button";
      configButton.type = "button";
      configButton.dataset.cardColor = normalizeCardColorId(cardColor);
      const colorHex = cardColorHex(cardColor);
      if (colorHex) {
        configButton.style.setProperty("--krc-folder-color", colorHex);
      }
      configButton.disabled = isScopeRow;
      const isOpen = this.folderConfigOpen === name && !isScopeRow;
      if (isScopeRow) {
        configButton.title = name === "__root__" ? "Root is a browser scope" : "All LoRAs is a browser scope";
      } else {
        configButton.classList.toggle("is-open", isOpen);
        configButton.title = `Folder settings for ${name}`;
        configButton.addEventListener("click", (event) => {
          event.stopPropagation();
          this.toggleFolderConfig(name);
        });
      }
      stopCanvasEvents(configButton);

      const label = document.createElement("span");
      label.className = "krc-folder-label";
      const labelText = document.createElement("span");
      labelText.className = "krc-folder-label-text";
      labelText.textContent = name === "loras" ? "All LoRAs" : name === "__root__" ? "Root" : name;
      label.append(labelText);
      if (pinned && !isScopeRow) {
        const pin = document.createElement("span");
        pin.className = "krc-folder-pin-mark";
        pin.textContent = "📌";
        pin.title = "Pinned to top";
        label.append(pin);
      }

      const badge = document.createElement("span");
      badge.className = "krc-folder-count";
      badge.textContent = count;

      row.addEventListener("click", () => {
        this.setFolder(name);
        this.refreshBrowser({ focusSelection: true });
      });

      row.append(configButton, label, badge);
      tree.append(row);
      if (isOpen) {
        tree.append(this.renderFolderConfigPanel({ name, cardColor, pinned }));
      }
    });

    shell.append(tree);
    return shell;
  },

  folderMatchesSearch(folder, values = []) {
    if (!values.length) {
      return true;
    }
    const name = folder?.name || "";
    const label = name === "loras" ? "All LoRAs loras" : name === "__root__" ? "Root root" : name;
    return values.every((value) => label.toLowerCase().includes(value));
  },

  toggleFolderConfig(name) {
    this.folderConfigOpen = this.folderConfigOpen === name ? null : name;
    this.refreshFolderShell({ focusActive: false });
  },

  // Re-render just the folder tree in place (config toggle doesn't touch the list).
  refreshFolderShell({ focusActive = true } = {}) {
    const shell = this.querySurface?.(".krc-folder-shell");
    if (!shell) {
      return;
    }
    const previousFolderScroll = this.folderTreeScrollTop?.();
    shell.replaceWith(this.renderFolders());
    this.restoreFolderTreeScroll?.(previousFolderScroll);
    if (focusActive) {
      this.focusActiveFolder?.();
    }
  },

  // In-cell folder config panel — the KRC-consistent inline equivalent of Prompt
  // Vault's category attributes: a pin toggle + shared color-swatch chips.
  renderFolderConfigPanel(folder) {
    const name = folder.name;
    const panel = document.createElement("div");
    panel.className = "krc-folder-config";
    stopCanvasEvents(panel);

    const pin = pinActionButton({
      active: !!folder.pinned,
      title: folder.pinned ? "Pinned to top" : "Pin to top",
      onClick: () => this.setFolderPin(name, !folder.pinned),
    });

    const swatches = buildColorSwatches({
      selected: normalizeCardColorId(folder.cardColor),
      onSelect: (id) => this.setFolderColor(name, id),
      noneTitle: "No folder color",
    });

    panel.append(pin, swatches);
    return panel;
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
      this.sortMode,
      folderSig,
    ].join("|");
    return cachedFilterResult(this, sig, () => {
      const source = dupeOnly ? this.loras.filter((lora) => (lora.duplicateCount || 0) > 1) : this.loras;
      return visibleLibraryItems(source, {
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
    }, {
      signatureProp: "_visibleLorasSig",
      cacheProp: "_visibleLorasCache",
    });
  },

  // ListSource seam for the shared virtualized list (shared/library_browser.js).
  // The windowing core reads rows LIVE via visibleItems() every update, so the old
  // per-card snapshot swap in refreshLoraCard is gone — a cache-delete plus update
  // re-renders the changed card from the fresh visibleLoras() (updateLibraryLora
  // invalidates that memo). cardFor is the signature-hashed card.
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
    };
    return this._listSource;
  },

  renderVirtualLoraListInto(list) {
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
    // rather than empty. `_initialLoadPending` covers the FIRST paint, before
    // loadLibrary flips isLoadingLibrary, so the very first frame is the skeleton
    // (not the empty-state note flashing in a stretched box). A genuinely empty
    // library (scan done, zero LoRAs) still shows the real note.
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

  // GroupSource seam (Beat 1): the browser shell's single interface to the primary
  // group filter — for LoRA Loadout this is the read-only disk-folder rail. The shell
  // renders the rail and reads the active group / group list through this, never
  // through `this.folder` directly. `matches` is the folder MATCH predicate — the one
  // thing that diverged between LL and ML's filter pass, now the seam that lets both
  // share shared/library_filter.js.
  groupSource() {
    if (this._groupSource) return this._groupSource;
    const ctl = this;
    this._groupSource = {
      active: () => ctl.folder,
      setActive: (id) => ctl.setFolder(id),
      groups: () => ctl.folders,
      render: () => ctl.renderFolders(),
      matches: (lora) => {
        const folder = ctl.folder;
        const folders = ctl.folders;
        return !folders.length || !folder || folder === "loras"
          || (folder === "__root__" ? (lora.folder || "") === "" : lora.folder === folder);
      },
    };
    return this._groupSource;
  },

  // Canonical item-key accessor (1d): a LoRA is keyed by its sha256. Every seam that
  // needs the key — both descriptors, pinKey, findItem — reads it through here, so
  // "what identifies an item" lives in one place (mirrors PV's controller keyOf).
  keyOf(lora) {
    return lora.sha256;
  },

  // ItemSource descriptor for the Layer-1 card primitive. Bound once; seams read
  // this.selectedSha / draggedSha / pinned live. The LoRA-specific parts vs PV are
  // the drag payload (built in the installInteractions hook) and the
  // duplicate badges (in fillBadgeRow) — the primitive stays node-agnostic.
  cardSource() {
    if (this._cardSource) return this._cardSource;
    const ctl = this;
    this._cardSource = createModelBrowserCardSource(ctl, {
      notchMenu: (lora, key) => {
        const stableId = key && !String(key).startsWith("local-");
        const canStabilize = key && !stableId;
        return {
          context: "browser",
          kind: "lora",
          id: key,
          title: ctl.browserLabel(lora) || "LoRA",
          quickActions: {
            color: {
              value: ctl.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
              title: "LoRA color",
              onChange: (value) => ctl.setLoraCardColor(lora, value),
            },
            customBadge: {
              visible: true,
              active: !!lora.customBadge,
              value: lora.customBadge || "",
              title: "Letters, numbers, spaces. 10 max.",
              onSave: (value) => ctl.setLoraCustomBadge(lora, value),
            },
            favorite: {
              active: !!lora.favorite,
              title: lora.favorite ? "Remove favorite tag" : "Mark as favorite",
              onToggle: () => ctl.toggleFavorite(lora),
            },
            pin: {
              active: !!lora.pinned,
              title: lora.pinned ? "Unpin from top" : "Pin to top",
              onToggle: () => ctl.togglePin(lora),
            },
            nsfw: {
              active: !!lora.nsfw,
              title: lora.nsfw ? "Remove NSFW tag" : "Tag as NSFW",
              onToggle: () => ctl.toggleNsfw(lora),
            },
          },
          actions: [
            { id: "rename", icon: "✎", label: "Rename", title: "Rename this LoRA", mode: "rename" },
            {
              id: "fetch",
              icon: "⬇︎",
              label: "Fetch",
              title: stableId ? "Fetch metadata from Civitai — fills empty fields, keeps the ones you set" : "Compute a stable hash, then fetch from Civitai",
              disabled: !key,
              onClick: async () => {
                if (!isNetworkAllowed()) {
                  notifyNetworkDisabled();
                  return false;
                }
                await ctl.fetchCivitaiMetadata(lora);
              },
            },
            {
              id: "stabilize",
              icon: "S",
              label: "Stabilize",
              title: "Create a stable SHA256 ID for this LoRA",
              visible: canStabilize,
              confirm: true,
              confirmLabel: "Stabilize?",
              onClick: () => {
                ctl.selectLora(lora.sha256);
                return ctl.stabilizeSelected(lora.sha256);
              },
            },
            {
              id: "copy-sha",
              icon: "#",
              label: "Copy SHA ID",
              title: stableId ? "Copy full hash id" : "Stabilize this LoRA ID before copying a full hash",
              disabled: !stableId,
              onClick: () => ctl.copyText(key),
            },
            {
              id: "more-info",
              icon: "i",
              label: "More Info",
              title: "More Info",
              onClick: () => ctl.openMoreInfoModal(lora),
            },
          ],
          rename: {
            value: lora.display_name || "",
            placeholder: "Name",
            title: "LoRA name",
            normalize: (value) => {
              const name = String(value || "").trim();
              return name ? name : null;
            },
            onSave: (value) => ctl.renameLoraCard(lora, value),
          },
        };
      },
      installInteractions: (card, lora) => {
        if (ctl.draggedSha === lora.sha256) card.classList.add("is-dragging");
        if (lora.pinned) card.classList.add("is-pinned");
        card.draggable = true;
        card.addEventListener("dragstart", (event) => {
          const dragSha = ctl.canonicalId?.(lora.sha256) || lora.sha256;
          const thumbUrl = lora.thumbnail
            ? ctl.thumbnailUrl(lora, lora.thumbnailType === "video" && lora.thumbnailHasPoster ? "poster" : "")
            : "";
          const payload = {
            kind: "lora",
            id: dragSha,
            modelType: "lora",
            path: lora.path || "",
            relativePath: lora.relativePath || lora.relative_path || "",
            file: lora.filename || "",
            title: lora.display_name || lora.filename || "",
            thumbnailUrl: thumbUrl,
            cardColor: ctl.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
            customBadge: lora.customBadge || "",
            favorite: Boolean(lora.favorite),
            nsfw: Boolean(lora.nsfw),
          };
          clearTimeout(ctl._stabilizeTimer);
          ctl.draggedSha = lora.sha256;
          card.classList.add("is-dragging");
          ctl.root.classList.add("is-dragging-lora");
          setKrcDragPayload(payload);
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("application/x-krc-model", JSON.stringify(payload));
          event.dataTransfer.setData("application/x-krc-lora", dragSha);
          event.dataTransfer.setData("text/plain", dragSha);
        });
        card.addEventListener("dragend", () => {
          ctl.draggedSha = "";
          ctl.root.classList.remove("is-dragging-lora");
          card.classList.remove("is-dragging");
          clearKrcDragPayload();
          ctl.scheduleStabilize?.(ctl.selectedSha);
        });
        card.addEventListener("click", () => {
          ctl.selectLora(lora.sha256);
        });
      },
    });
    return this._cardSource;
  },

  renderLoraCard(lora) {
    return renderModelCard(lora, this.cardSource());
  },

  refreshLoraCard(sha256) {
    // Stack slots carry the same data-lora-sha but are a different card (enable box,
    // strength, slot drag). Matching one here swapped it for a browser card whenever
    // the browser copy wasn't in the DOM (mini layout, filtered out, virtualized off
    // screen) — so slots re-render through their own source instead.
    this.refreshSlotCards?.(sha256);
    const card = queryDataAttrAny([this.root], ".krc-lora-card:not(.krc-card-slot)", "data-lora-sha", sha256);
    const virtualList = card?.closest?.(".krc-lora-list.is-virtualized");
    if (virtualList) {
      // The shared virtual list re-reads visibleLoras() live on every update, and
      // updateLibraryLora invalidates that memo — so dropping the stale card from the
      // cache and updating is enough to re-render it from the fresh object (no snapshot
      // swap needed, as when the old state.items snapshot could keep a just-uploaded
      // video's old thumbnailType and fail its variant into a placeholder).
      this._loraCardCache?.delete?.(sha256);
      this.updateVirtualLoraList(virtualList);
      return true;
    }
    refreshBrowserCard({
      key: sha256,
      replace: true,
      findCard: () => card,
      findItem: (key) => this.loras.find((item) => this.keyOf(item) === key),
      renderCard: (lora) => this.renderLoraCard(lora),
    });
  }
};
