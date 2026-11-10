import { canonicalModelId } from "../shared/model_identity.js";
import { postLoraJson } from "./api.js";
import { setWidgetValue } from "./helpers.js";
import { debounce, queryDataAttrAny, scheduleFrame, scrollNearest } from "../shared/dom.js";
import { browserMethods } from "./browser_view.js";
import { cardSourceMethods } from "./card_source.js";
import { collectionsViewMethods } from "./collections_view.js";
import { folderRailMethods } from "./folder_rail.js";
import { homeMenuMethods } from "./home_menu.js";
import { cardDecorMethods } from "./card_decor.js";
import { sharedInfoPanelControlMethods } from "../shared/info_panel_controls.js";
import { infoPanelControlMethods } from "./info_panel_controls.js";
import { infoPanelMethods } from "./info_panel_view.js";
import { civitaiFetchPageMethods } from "./civitai_fetch_page.js";
import { infoPageMethods } from "./info_page.js";
import { statsPageMethods } from "./stats_page.js";
import { profilesPageMethods } from "./profiles_page.js";
import { apiPageMethods } from "./api_page.js";
import { optionsPageMethods } from "./options_page.js";
import { extraOptionsPageMethods } from "./extra_options_page.js";
import { transferPageMethods } from "./transfer_page.js";
import { metadataStateMethods, remapMetadataIdentity } from "../shared/metadata_state.js";
import { infoPanelMetadataMethods } from "./info_panel_metadata.js";
import { sharedMoreInfoModalMethods } from "../shared/more_info_modal.js";
import { moreInfoModalMethods } from "./more_info_modal.js";
import { hfImportMethods } from "./hf_import.js";
import { panelDataMethods, registerMountedPanel } from "./panel_data.js";
import { panelLifecycleMethods } from "./panel_lifecycle.js";
import { initialPanelState } from "./panel_state.js";
import { transferMethods } from "./transfer_controller.js";

export class LoraStackerPanel {
  constructor(node, { surface = "full", deferInit = false } = {}) {
    this.node = node;
    Object.assign(this, initialPanelState(node, {
      surface,
      showNsfw: this.resolveShowNsfw(),
      nsfwDisplayMode: this.globalNsfwDisplayMode(),
      webmThumbnailsEnabled: this.globalWebmThumbnailsEnabled(),
      webmThumbnailAutoplayEnabled: this.globalWebmThumbnailAutoplayEnabled(),
    }));
    registerMountedPanel(this);
    if (!deferInit) this.start();
  }

  browserListScrollTop() {
    return this.querySurface(".krc-lora-list")?.scrollTop || 0;
  }

  folderTreeScrollTop() {
    return this.querySurface(".krc-folder-tree")?.scrollTop || 0;
  }

  restoreBrowserListScroll(scrollTop) {
    scheduleFrame(this, "_restoreBrowserListScrollFrame", () => {
      const list = this.querySurface(".krc-lora-list");
      if (list) {
        list.scrollTop = scrollTop;
        this.updateVirtualLoraList?.(list);
      }
    });
  }

  scheduleBrowserViewportUpdateAfterResize() {
    if (this.surface === "mini") {
      return;
    }
    if (!this._browserViewportResizeDebounce) {
      this._browserViewportResizeDebounce = debounce(() => {
        const list = this.querySurface(".krc-lora-list.is-virtualized");
        if (list) this.updateVirtualLoraList?.(list);
      }, 140);
    }
    this._browserViewportResizeDebounce();
  }

  restoreFolderTreeScroll(scrollTop) {
    scheduleFrame(this, "_restoreFolderTreeScrollFrame", () => {
      const tree = this.querySurface(".krc-folder-tree");
      if (tree) {
        tree.scrollTop = scrollTop;
      }
    });
  }

  focusActiveFolder() {
    scheduleFrame(this, "_focusActiveFolderFrame", () => {
      const row = queryDataAttrAny([this.pickerPortal, this.root], ".krc-folder-row", "data-folder-name", this.folder);
      scrollNearest(row);
    });
  }

  focusFolder(folderName) {
    if (!folderName) {
      return;
    }
    scheduleFrame(this, "_focusFolderFrame", () => {
      const row = queryDataAttrAny([this.pickerPortal, this.root], ".krc-folder-row", "data-folder-name", folderName);
      scrollNearest(row);
    });
  }

  focusSelectedLora() {
    scheduleFrame(this, "_focusSelectedLoraFrame", () => {
      if (this.scrollVirtualLoraIntoView?.(this.selectedSha)) {
        return;
      }
      const card = queryDataAttrAny([this.pickerPortal, this.root], ".krc-lora-card", "data-lora-sha", this.selectedSha);
      scrollNearest(card);
    });
  }

  refreshStacks() {
    return;
  }

  refreshStack(stackId) {
    return;
  }

  refreshPresetPanel() {
    return;
  }

  invalidateVisibleLoras() {
    this._visibleLorasVersion = (this._visibleLorasVersion || 0) + 1;
  }

  canonicalId(value) {
    return canonicalModelId(value, this.aliases);
  }

  canonicalizeRuntimeIds() {
    const remap = (value) => this.canonicalId(value);
    this.selectedSha = remap(this.selectedSha);
    this.draggedSha = remap(this.draggedSha);
    this._browserSelectionUI?.remapIds(remap);
  }

  applyIdentityChange(identity = {}, { rememberAlias = true } = {}) {
    const oldId = identity.oldId || "";
    const newId = identity.newId || "";
    if (!oldId || !newId || oldId === newId) {
      return false;
    }

    const remap = (value) => (value === oldId ? newId : value);
    this.aliases = { ...(this.aliases || {}) };
    if (rememberAlias) {
      this.aliases[oldId] = newId;
    } else {
      delete this.aliases[oldId];
      Object.keys(this.aliases).forEach((key) => {
        if (this.aliases[key] === oldId) {
          delete this.aliases[key];
        }
      });
    }
    this.selectedSha = remap(this.selectedSha);
    setWidgetValue(this.node, "selected_lora_sha256", this.selectedSha);

    this.draggedSha = remap(this.draggedSha);

    remapMetadataIdentity(this, oldId, newId);

    // The visible-loras cache is keyed by a signature that does NOT hash the LoRAs'
    // ids, so remapping oldId->newId here leaves the cached list holding the stale
    // objects. A following refreshBrowser would then render cards with the dead
    // (local-) id in data-lora-sha and their click closures, so reselecting sets
    // selectedSha to an id no longer in this.loras and renderInfo falls back to
    // loras[0]. Invalidate so cards rebuild with the new id. Only a manual refresh
    // fixed it before because that recomputes the list from scratch.
    this.invalidateVisibleLoras();
    this._browserSelectionUI?.remap(oldId, newId);

    this.updateLibraryCache({
      loras: this.loras,
      aliases: this.aliases,
      metadataSnapshots: this.metadataSnapshots,
    });
    this.shareMetadataSnapshots(this.metadataSnapshots);
    return true;
  }

  refreshBrowser({ focusSelection = false, focusFolder = null, keepFolders = false } = {}) {
    const browser = this.querySurface(".krc-browser");
    if (!browser) {
      this.render({ preserveBrowserScroll: true, focusSelection });
      if (focusFolder) {
        this.focusFolder(focusFolder);
      }
      return;
    }
    const previousListScroll = this.browserListScrollTop();
    const previousFolderScroll = this.folderTreeScrollTop();
    // Sort/filter/view/name toggles don't touch the folder rail (its counts are
    // static, whole-library), so reuse the live rail node: skips renderFolders()
    // and carries its scroll over. Folder clicks / reloads leave keepFolders off
    // so the rail rebuilds when its active row or counts actually change.
    const folderShell = keepFolders ? browser.querySelector(".krc-folder-shell") : null;
    browser.replaceWith(this.renderBrowser(folderShell ? { folderShell } : undefined));
    this.restoreBrowserListScroll(previousListScroll);
    this.restoreFolderTreeScroll(previousFolderScroll);
    if (focusFolder) {
      this.focusFolder(focusFolder);
    } else {
      this.focusActiveFolder();
    }
    if (focusSelection) {
      this.focusSelectedLora();
    }
  }

  async setFolderColor(folderName, cardColor) {
    const folder = folderName || "loras";
    this.folders = this.folders.map((item) => (
      item.name === folder ? { ...item, cardColor: cardColor || "" } : item
    ));
    this.invalidateVisibleLoras();
    this.updateLibraryCache({ loras: this.loras, folders: this.folders });
    this.cardCacheEpoch += 1;
    this.refreshBrowser();
    this.refreshStacks();
    try {
      const response = await postLoraJson("/folder-color", { folder, cardColor: cardColor || "" });
      if (!response.ok) {
        await this.loadLibrary({ restoreScroll: true });
      }
    } catch {
      await this.loadLibrary({ restoreScroll: true });
    }
  }

  async setFolderPin(folderName, pinned) {
    const folder = folderName || "";
    if (!folder || folder === "loras" || folder === "__root__") {
      return;
    }
    this.folders = this.reorderFolders(this.folders.map((item) => (
      item.name === folder ? { ...item, pinned: !!pinned } : item
    )));
    this.invalidateVisibleLoras();
    this.updateLibraryCache({ folders: this.folders });
    this.folderConfigOpen = null;
    this.refreshBrowser({ focusFolder: folder });
    try {
      const response = await postLoraJson("/folder-pin", { folder, pinned: !!pinned });
      if (!response.ok) {
        await this.loadLibrary({ restoreScroll: true });
      }
    } catch {
      await this.loadLibrary({ restoreScroll: true });
    }
  }

  // Match the server order: fixed scope rows first, then real folders with
  // pinned ones on top, alphabetical within each group.
  reorderFolders(folders) {
    const isScope = (folder) => folder.scope || folder.name === "loras" || folder.name === "__root__";
    const compareFolderName = (a, b) => {
      const left = a.name || "";
      const right = b.name || "";
      return left.toLowerCase().localeCompare(right.toLowerCase())
        || left.localeCompare(right);
    };
    const scope = folders.filter(isScope);
    const real = folders.filter((folder) => !isScope(folder));
    real.sort(compareFolderName);
    real.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    return [...scope, ...real];
  }

  refreshInfo() {
    const info = this.querySurface(".krc-info");
    if (!info) {
      this.render({ preserveBrowserScroll: true });
      return;
    }
    info.replaceWith(this.renderInfo());
  }

  markMetadataEdited() {
    // Persist the unsaved edit after typing settles; keep badge feedback instant.
    this.invalidateVisibleLoras();
    this.scheduleMetadataDraftCapture();
    this.updateModifiedIndicators();
  }

}

Object.assign(
  LoraStackerPanel.prototype,
  panelLifecycleMethods,
  panelDataMethods,
  browserMethods,
  folderRailMethods,
  homeMenuMethods,
  collectionsViewMethods,
  cardSourceMethods,
  cardDecorMethods,
  metadataStateMethods,
  infoPanelMetadataMethods,
  infoPanelMethods,
  infoPageMethods,
  civitaiFetchPageMethods,
  statsPageMethods,
  transferPageMethods,
  optionsPageMethods,
  profilesPageMethods,
  apiPageMethods,
  extraOptionsPageMethods,
  sharedInfoPanelControlMethods,
  infoPanelControlMethods,
  sharedMoreInfoModalMethods,
  moreInfoModalMethods,
  hfImportMethods,
  transferMethods
);
