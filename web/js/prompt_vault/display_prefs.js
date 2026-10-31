import { nsfwDisplayState } from "../shared/nsfw_visibility.js";
/*
 * KRC Prompt Vault — display prefs.
 * The global NSFW / webm settings and the per-node NSFW eye, browser view,
 * sort, favorite / colour filters and list thumbnails (with their value sanitizers).
 * Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { app } from "../../../scripts/app.js";
import { normalizeCardColorId } from "../shared/card_colors.js";
import {
  ENABLE_WEBM_THUMBNAILS_DEFAULT,
  ENABLE_WEBM_THUMBNAILS_SETTING_ID,
  NSFW_DISPLAY_MODE_DEFAULT,
  NSFW_DISPLAY_MODE_SETTING_ID,
  WEBM_AUTOPLAY_DEFAULT,
  WEBM_AUTOPLAY_SETTING_ID,
} from "../shared/settings.js";
import { sanitizeBrowserView } from "../shared/browser_views.js";

function getGlobalSetting(id, fallback) {
  const setting = app.extensionManager?.setting;
  if (setting?.get) {
    return setting.get(id);
  }
  return app.ui?.settings?.getSettingValue?.(id, fallback);
}

export function browserViewValue(value) {
  return sanitizeBrowserView(value);
}

function nsfwDisplayModeValue(value) {
  return value === "blur" ? "blur" : "hide";
}

const SORT_MODES = new Set(["az", "za", "added_new", "added_old", "modified_new", "modified_old", "used_most", "used_recent"]);

export function browserSortValue(value) {
  return SORT_MODES.has(value) ? value : "az";
}

export function colorFilterValue(value) {
  return value === "__none__" ? "__none__" : normalizeCardColorId(value);
}

export const displayMethods = {
  globalNsfwDisplayMode() {
    return nsfwDisplayModeValue(getGlobalSetting(NSFW_DISPLAY_MODE_SETTING_ID, NSFW_DISPLAY_MODE_DEFAULT));
  },

  globalWebmThumbnailsEnabled() {
    return !!getGlobalSetting(ENABLE_WEBM_THUMBNAILS_SETTING_ID, ENABLE_WEBM_THUMBNAILS_DEFAULT);
  },

  globalWebmThumbnailAutoplayEnabled() {
    return !!getGlobalSetting(WEBM_AUTOPLAY_SETTING_ID, WEBM_AUTOPLAY_DEFAULT);
  },

  // The node's own eye; the global option only seeded it when the node was created.
  resolveShowNSFW() {
    return !!this.node.properties?.pmShowNSFW;
  },

  shouldHideNSFW() {
    return nsfwDisplayState({ nsfw: true }, { showNsfw: this.showNSFW, displayMode: this.nsfwDisplayMode }).hidden;
  },

  itemIsNsfw(item) {
    return !!(item?.nsfw || this.categoryIsNsfw(item?.category));
  },

  shouldBlurNSFW(item) {
    return nsfwDisplayState({ nsfw: this.itemIsNsfw(item) }, { showNsfw: this.showNSFW, displayMode: this.nsfwDisplayMode }).blurred;
  },

  setShowNSFW(value) {
    this.showNSFW = !!value;
    this.node.properties ||= {};
    this.node.properties.pmShowNSFW = this.showNSFW;
    this.markCanvasDirty();
  },

  setFavoriteFilter(value) {
    this.favOnly = !!value;
    this.setSerializableProperty("pmFavOnly", this.favOnly);
    this.markCanvasDirty();
  },

  setColorFilter(value) {
    this.colorFilter = value === "__none__" ? "__none__" : normalizeCardColorId(value);
    this.setSerializableProperty("pmColorFilter", this.colorFilter);
    this.markCanvasDirty();
  },

  setBrowserView(value) {
    this.view = browserViewValue(value);
    this.setSerializableProperty("pmBrowserView", this.view);
    this.markCanvasDirty();
  },

  setBrowserSort(value) {
    this.sort = browserSortValue(value);
    this.setSerializableProperty("pmBrowserSort", this.sort);
    this.markCanvasDirty();
  },

  setListThumbs(value) {
    this.listThumbs = !!value;
    this.setSerializableProperty("pmListThumbs", this.listThumbs);
    this.refreshBrowserPanel();
  },

  restoreBrowserState(props = this.node.properties || {}) {
    this.view = browserViewValue(props.pmBrowserView);
    this.sort = browserSortValue(props.pmBrowserSort);
    this.favOnly = !!props.pmFavOnly;
    this.colorFilter = colorFilterValue(props.pmColorFilter);
    this.listThumbs = !!props.pmListThumbs;
    this.nsfwDisplayMode = this.globalNsfwDisplayMode();
    this.showNSFW = this.resolveShowNSFW();
  },
};
