import { sanitizeBrowserView } from "../shared/browser_views.js";
import { normalizeCardColorId } from "../shared/card_colors.js";
import { DOM_MIN_HEIGHT } from "./constants.js";
import { widgetValue } from "./helpers.js";


export function truthyWidgetValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}


export function browserViewValue(value) {
  return sanitizeBrowserView(value);
}


const NAME_MODES = new Set(["title", "filename"]);
const SORT_MODES = new Set(["alpha", "alpha-desc", "date-desc", "date-asc", "mod-desc", "mod-asc", "used-most", "used-recent"]);


export function browserNameModeValue(value) {
  return NAME_MODES.has(value) ? value : "title";
}


export function browserSortModeValue(value) {
  return SORT_MODES.has(value) ? value : "alpha";
}


export function truthyPropertyValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}


export function colorFilterValue(value) {
  return value === "__none__" ? "__none__" : normalizeCardColorId(value);
}


export function browserFolderValue(value) {
  const folder = String(value || "").trim();
  return folder || "__model_home__";
}


function initialDomHeightForSurface(surface) {
  return DOM_MIN_HEIGHT;
}


export function createPanelRoot(surface) {
  const root = document.createElement("div");
  const isMini = surface === "mini";
  const isDetached = surface === "detached";
  root.className = `krc-node krc-model-library krc-solo-widget${isMini ? " is-mini" : ""}${isDetached ? " is-detached" : ""}`;
  // Detached (library modal): the modal owns sizing — fill the host container
  // (library_modal.css positions this root absolutely inside the modal body).
  if (isDetached) {
    return root;
  }
  const height = initialDomHeightForSurface(surface);
  if (height) {
    const px = `${height}px`;
    root.style.height = px;
    root.style.overflow = "hidden";
    root.style.setProperty("--krc-dom-h", px);
  }
  return root;
}


export function initialPanelState(node, { surface, showNsfw, nsfwDisplayMode, webmThumbnailsEnabled, webmThumbnailAutoplayEnabled }) {
  return {
    node,
    surface,
    selectedSha: widgetValue(node, "selected_lora_sha256") || "",
    folder: browserFolderValue(node.properties?.mlBrowserFolder ?? node.properties?.llBrowserFolder),
    query: "",
    view: browserViewValue(widgetValue(node, "browser_view")),
    nameMode: browserNameModeValue(node.properties?.llBrowserNameMode),
    sortMode: browserSortModeValue(node.properties?.llBrowserSortMode),
    showFavorites: truthyWidgetValue(widgetValue(node, "show_favorites")),
    colorFilter: colorFilterValue(widgetValue(node, "color_filter")),
    showNsfw,
    nsfwDisplayMode,
    webmThumbnailsEnabled,
    webmThumbnailAutoplayEnabled,
    listThumbs: truthyPropertyValue(node.properties?.mlListThumbs),
    swapPresetInfoColumns: truthyPropertyValue(node.properties?.llSwapPresetInfoColumns),
    loras: [],
    aliases: {},
    metadataSnapshots: new Map(),
    metadataBaselines: new Map(),
    folders: [{ name: "__model_home__", label: "All Models", count: 0, scope: true }],
    scan: { roots: [], model_count: 0, errors: [] },
    isLoadingLibrary: false,
    draggedSha: "",
    // Bumped when every card must rebuild (folder colours, webm settings); image URLs
    // are versioned per item (thumbnailVersion on each record), not by this.
    cardCacheEpoch: 0,
    thumbnailPasteMode: false,
    status: "Scanning model library...",
    root: createPanelRoot(surface),
    missingLoras: [],
    missingSelection: "",
    missingInfo: null,
    // Non-item Info Panel page (e.g. "civitaiFetch"); "" = the selected item.
    infoPage: "",
    _started: false,
    _visibleLorasVersion: 0,
  };
}
