import { nsfwDisplayState } from "../shared/nsfw_visibility.js";
import { app } from "../../../scripts/app.js";
import { applyNodePalette } from "../shared/node_palette.js";
import { cancelFrame } from "../shared/dom.js";
import { teardownMedia } from "../shared/browser_cards.js";
import { normalizeCardColorId } from "../shared/card_colors.js";
import { revealWhenStyled } from "../shared/stylesheets.js";
import { isOwnSyncEvent, subscribeKrcSync } from "../shared/sync_bus.js";
import { followGroupChange } from "../shared/preset_group_actions.js";
import {
  NSFW_DISPLAY_MODE_SETTING_ID,
  NSFW_DISPLAY_MODE_DEFAULT,
  ENABLE_WEBM_THUMBNAILS_SETTING_ID,
  ENABLE_WEBM_THUMBNAILS_DEFAULT,
  WEBM_AUTOPLAY_SETTING_ID,
  WEBM_AUTOPLAY_DEFAULT,
} from "../shared/settings.js";
import { parseJsonArray } from "./pure_helpers.js";
import { getCachedPresets, unregisterMountedPanel } from "./panel_data.js";
import { browserFolderValue, browserNameModeValue, browserSortModeValue, browserViewValue, colorFilterValue, truthyPropertyValue, truthyWidgetValue } from "./panel_state.js";
import { markDirty, setWidgetValue, widgetValue } from "./helpers.js";


function getGlobalSetting(id, fallback) {
  const setting = app.extensionManager?.setting;
  if (setting?.get) {
    return setting.get(id);
  }
  return app.ui?.settings?.getSettingValue?.(id, fallback);
}

export const panelLifecycleMethods = {
  start() {
    if (this._started || this._destroyed) return;
    this._started = true;
    const hasCachedLibrary = this.applyCachedLibrary();
    // Resolve a legacy name pointer against the synchronously-cached presets so the
    // first paint already shows the right preset (loadPresets reconciles again once
    // the fresh list arrives).
    this.reconcileActivePresetId();
    this.restoreActivePresetBaseline();
    const willLoad = !hasCachedLibrary || this._libraryFromStaleSnapshot;
    // Cold start with nothing cached: mark the load pending BEFORE the first render so
    // the list paints its skeleton on the very first frame, instead of flashing the
    // empty-state note in a stretched empty box until loadLibrary sets isLoadingLibrary.
    this._initialLoadPending = willLoad && !this.loras?.length;
    this.render({ focusSelection: true });
    this._initialLoadPending = false;
    this.installMetadataSyncListener?.();
    this.loadPresets();
    if (willLoad) {
      // No cache, or the cache came from a persisted snapshot (stale by
      // definition) — refresh in the background while the snapshot stays visible.
      this.loadLibrary({ focusSelection: true });
    }
    // Presets are global; when a sibling stacker (e.g. the mini surface) writes,
    // adopt the freshly-cached list and re-render so this panel isn't stale.
    this.unsubscribePresetsChanged = subscribeKrcSync("krc-lora-presets-changed", (event) => {
      if (isOwnSyncEvent(event, this.node?.id)) {
        return;
      }
      // A group renamed / ungrouped / deleted elsewhere: a filter on it follows.
      const filter = widgetValue(this.node, "preset_prefix_filter");
      const followed = followGroupChange(filter, event);
      if (followed !== filter) {
        setWidgetValue(this.node, "preset_prefix_filter", followed);
      }
      // An import (Portal or another node's Options) changed the store server-side and no
      // page holds a fresh copy — refetch instead of adopting the module cache.
      if (event?.detail?.refetch) {
        this.loadPresets().then(() => this.adoptNewerActivePreset());
        return;
      }
      this.presets = getCachedPresets();
      this.reconcileActivePresetId();
      this.restoreActivePresetBaseline();
      this.refreshPresetPanel();
      // Clean but behind the newer save: load it instead of showing Stale.
      this.adoptNewerActivePreset();
    });
    this.globalNsfwHandler = () => {
      const next = this.resolveShowNsfw();
      this.showNsfw = next;
      this.nsfwDisplayMode = this.globalNsfwDisplayMode();
      this.refreshBrowser({ focusSelection: true });
      this.refreshInfo();
    };
    window.addEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
    this.webmThumbnailsHandler = () => {
      this.webmThumbnailsEnabled = this.globalWebmThumbnailsEnabled();
      this.webmThumbnailAutoplayEnabled = this.globalWebmThumbnailAutoplayEnabled();
      this.cardCacheEpoch += 1;   // cards rebuild; image URLs don't change
      this.refreshBrowser({ focusSelection: true });
      this.refreshInfo();
    };
    window.addEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
    window.addEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
  },

  // What rehydrate reads from the node, as the panel holds it now.
  rehydrateState() {
    return JSON.stringify([
      this.selectedSha, this.folder, this.view, this.nameMode, this.sortMode, this.showFavorites,
      this.colorFilter, this.nsfwDisplayMode, this.showNsfw, this.swapPresetInfoColumns,
      this.listThumbs, this.slotBadgeRow, this.stacks,
    ]);
  },

  rehydrateFromNode() {
    const before = this._started ? this.rehydrateState() : "";
    const lorasBefore = this.loras;
    this.usageSortEnabled = true;   // LL emits LoRA usage → offer Most/Last Used sorts
    this.selectedSha = widgetValue(this.node, "selected_lora_sha256") || this.selectedSha;
    this.folder = browserFolderValue(this.node.properties?.llBrowserFolder);
    this.view = browserViewValue(widgetValue(this.node, "browser_view"));
    this.nameMode = browserNameModeValue(this.node.properties?.llBrowserNameMode);
    this.sortMode = browserSortModeValue(this.node.properties?.llBrowserSortMode);
    this.showFavorites = truthyWidgetValue(widgetValue(this.node, "show_favorites"));
    this.colorFilter = colorFilterValue(widgetValue(this.node, "color_filter"));
    this.nsfwDisplayMode = this.globalNsfwDisplayMode();
    this.showNsfw = this.resolveShowNsfw();
    this.swapPresetInfoColumns = truthyPropertyValue(this.node.properties?.llSwapPresetInfoColumns);
    this.listThumbs = truthyPropertyValue(this.node.properties?.llListThumbs);
    this.slotBadgeRow = this.node.properties?.llSlotBadgeRow !== false; // default on
    this.stacks = {
      A: parseJsonArray(widgetValue(this.node, "stack_a_loras"), []),
      B: parseJsonArray(widgetValue(this.node, "stack_b_loras"), []),
    };
    if (!this._started) return;
    this.syncStackFromState("A");
    this.syncStackFromState("B");
    this.applyCachedLibrary();
    // Rehydrate runs on every node re-attach / onConfigure (frequent on the Vue frontend).
    // When the node holds what the panel already shows, there's nothing to rebuild, and
    // the presets are kept live by their sync subscription — no refetch either.
    if (this.rehydrateState() === before && this.loras === lorasBefore && this.root.firstChild) return;
    // Plain render here — forcing focusSelection each time snaps the browser list back to
    // the selected LoRA mid-scroll (reads as "can't scroll"). The genuine focus-after-
    // restore is handled once by start().
    this.render();
    this.loadPresets();
  },

  globalNsfwDisplayMode() {
    return getGlobalSetting(NSFW_DISPLAY_MODE_SETTING_ID, NSFW_DISPLAY_MODE_DEFAULT) === "blur" ? "blur" : "hide";
  },

  globalWebmThumbnailsEnabled() {
    return !!getGlobalSetting(ENABLE_WEBM_THUMBNAILS_SETTING_ID, ENABLE_WEBM_THUMBNAILS_DEFAULT);
  },

  globalWebmThumbnailAutoplayEnabled() {
    return !!getGlobalSetting(WEBM_AUTOPLAY_SETTING_ID, WEBM_AUTOPLAY_DEFAULT);
  },

  // The node's own eye; the global option only seeded it when the node was created.
  resolveShowNsfw() {
    return truthyWidgetValue(widgetValue(this.node, "show_nsfw"));
  },

  shouldHideNsfw() {
    return nsfwDisplayState({ nsfw: true }, { showNsfw: this.showNsfw, displayMode: this.nsfwDisplayMode }).hidden;
  },

  shouldBlurNsfw(item) {
    return nsfwDisplayState(item, { showNsfw: this.showNsfw, displayMode: this.nsfwDisplayMode }).blurred;
  },

  setShowNsfw(value) {
    this.showNsfw = !!value;
    setWidgetValue(this.node, "show_nsfw", this.showNsfw);
  },

  setShowFavorites(value) {
    this.showFavorites = !!value;
    setWidgetValue(this.node, "show_favorites", this.showFavorites);
  },

  setColorFilter(value) {
    this.colorFilter = value === "__none__" ? "__none__" : normalizeCardColorId(value);
    setWidgetValue(this.node, "color_filter", this.colorFilter);
  },

  setSerializableProperty(name, value) {
    this.node.properties ||= {};
    if (typeof this.node.setProperty === "function") {
      this.node.setProperty(name, value);
    } else {
      this.node.properties[name] = value;
    }
    markDirty(this.node);
  },

  setNameMode(value) {
    this.nameMode = browserNameModeValue(value);
    this.setSerializableProperty("llBrowserNameMode", this.nameMode);
  },

  setSortMode(value) {
    this.sortMode = browserSortModeValue(value);
    this.setSerializableProperty("llBrowserSortMode", this.sortMode);
  },

  setFolder(value) {
    this.folder = browserFolderValue(value);
    this._browserSelectionUI?.refresh();
    this.setSerializableProperty("llBrowserFolder", this.folder);
  },

  setBrowserView(value) {
    this.view = browserViewValue(value);
    setWidgetValue(this.node, "browser_view", this.view);
  },

  render({ preserveBrowserScroll = false, focusSelection = false } = {}) {
    this.closeStrengthEditor?.(false);
    const previousListScroll = preserveBrowserScroll ? this.browserListScrollTop() : 0;
    const previousFolderScroll = preserveBrowserScroll ? this.folderTreeScrollTop() : 0;
    applyNodePalette(this.node, this.root); // restore saved per-node palette
    teardownMedia(this.root);
    this.root.innerHTML = "";
    const layout = this.renderLayout();
    this.root.append(layout);
    // Hide the layout until its grid CSS is actually applied to this element, so a
    // fresh boot never flashes the browser column full-width over the stacks/info
    // panels while the @imported layout sheet is still landing. No-op once styled.
    revealWhenStyled(layout);
    if (preserveBrowserScroll) {
      this.restoreBrowserListScroll(previousListScroll);
      this.restoreFolderTreeScroll(previousFolderScroll);
    }
    if (focusSelection) {
      this.focusSelectedLora();
    }
  },

  renderLayout() {
    const layout = document.createElement("div");
    layout.className = this.surface === "mini" ? "krc-lora-mini-layout" : "krc-lora-layout";
    if (this.surface !== "mini") {
      layout.classList.toggle("is-info-before-stacks", !!this.swapPresetInfoColumns);
    }
    if (this.surface === "mini") {
      layout.append(this.renderStacks());
    } else {
      layout.append(this.renderBrowser(), this.renderStacks(), this.renderInfo());
    }
    return layout;
  },

  setSwapPresetInfoColumns(value) {
    this.swapPresetInfoColumns = !!value;
    this.node.properties ||= {};
    if (typeof this.node.setProperty === "function") {
      this.node.setProperty("llSwapPresetInfoColumns", this.swapPresetInfoColumns);
    } else {
      this.node.properties.llSwapPresetInfoColumns = this.swapPresetInfoColumns;
    }
    markDirty(this.node);
    const layout = this.querySurface(".krc-lora-layout");
    if (layout) {
      layout.classList.toggle("is-info-before-stacks", this.swapPresetInfoColumns);
    }
  },

  setListThumbs(value) {
    this.listThumbs = !!value;
    this.setSerializableProperty("llListThumbs", this.listThumbs);
    this.refreshBrowser?.({ focusSelection: true });
    this.refreshStacks?.(); // preset slots share this toggle
  },

  setSlotBadgeRow(value) {
    this.slotBadgeRow = !!value;
    this.setSerializableProperty("llSlotBadgeRow", this.slotBadgeRow);
    this.refreshStacks?.();
  },

  querySurface(selector) {
    return this.root.querySelector(selector);
  },

  querySurfaceAll(selector) {
    return Array.from(this.root.querySelectorAll(selector));
  },

  destroy() {
    this._browserSelectionUI?.destroy();
    this._destroyed = true;
    teardownMedia(this.root);
    unregisterMountedPanel(this);
    [
      "_browserResultsFrame",
      "_restoreBrowserListScrollFrame",
      "_restoreFolderTreeScrollFrame",
      "_focusActiveFolderFrame",
      "_focusFolderFrame",
      "_focusSelectedLoraFrame",
    ].forEach((prop) => cancelFrame(this, prop));
    this._browserViewportResizeDebounce?.cancel?.();
    this.flushMetadataDraftCapture?.();
    this.uninstallMetadataSyncListener?.();
    this.closeStrengthEditor?.(false);
    clearTimeout(this._stabilizeTimer);
    if (this.unsubscribePresetsChanged) {
      this.unsubscribePresetsChanged();
      this.unsubscribePresetsChanged = null;
    }
    if (this.globalNsfwHandler) {
      window.removeEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
      this.globalNsfwHandler = null;
    }
    if (this.webmThumbnailsHandler) {
      window.removeEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
      window.removeEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
      this.webmThumbnailsHandler = null;
    }
  },
};
