/*
 * KRC NodePack public API (JS). The ONLY NodePack module other KRC packs (KRC NodePack
 * Extras) may import; everything behind it can be refactored freely.
 *
 * Contract: every name here is listed in KRC_PUBLIC_API.md (dev repo). Any change to the
 * surface (added, changed or removed) bumps KRC_API_VERSION.minor by one; .major moves only
 * when the user asks. Change this file, the blueprint and the version in the same commit.
 *
 * Import it from another pack by the URL ComfyUI loaded it from (find it in GET /extensions;
 * never assume NodePack's folder name), so it resolves to THIS file: one module instance,
 * so the sync bus, open-menu tracking and palettes stay shared. See Extras' krc_nodepack.js.
 */

export const KRC_API_VERSION = Object.freeze({ major: 2, minor: 8 });

// ---- Node plumbing: widgets, sizing, DOM, stylesheets ----------------------------
export {
  bindNodeShellSizeClamp,
  findWidget,
  makeWidgetAccessors,
  markDirty,
  promoteDomWidget,
} from "./shared/widgets.js";
export { krcNodeMinHeight, makeNodeSizing } from "./shared/node_limits.js";
export {
  appendFragment,
  debounce,
  installCanvasDragSelectionGuard,
  stopCanvasEvents,
  stopCanvasWheel,
  waitForDomReady,
  waitFrames,
} from "./shared/dom.js";
export { ensureSharedStylesheets, ensureStylesheet, revealWhenStyled } from "./shared/stylesheets.js";
// LoRA Loadout's sheet: nodes that reuse LL's slot/preset DOM classes load it.
export { ensureStylesheet as ensureLoraLoadoutStylesheet } from "./lora_loadout/helpers.js";

// ---- Memory stats (diagnostics) --------------------------------------------------
// A node publishes window.krc<Node>MemoryStats; the aggregator collects them all.
export { domSummary, imageStatsFromElements, installKrcStatsAggregator, roughJsonBytes } from "./shared/memory_stats.js";

// ---- Palette and theme --------------------------------------------------------------
export {
  applyNodeCanvasColors,
  applyNodePalette,
  buildNodePaletteField,
  modalPaletteIdForNode,
  setNodePalette,
} from "./shared/node_palette.js";

// ---- Global settings ---------------------------------------------------------------
export {
  ENABLE_WEBM_THUMBNAILS_DEFAULT,
  ENABLE_WEBM_THUMBNAILS_SETTING_ID,
  NSFW_DISPLAY_MODE_DEFAULT,
  NSFW_DISPLAY_MODE_SETTING_ID,
  SHOW_NSFW_DEFAULT,
  SHOW_NSFW_SETTING_ID,
  WEBM_AUTOPLAY_DEFAULT,
  WEBM_AUTOPLAY_SETTING_ID,
} from "./shared/settings.js";

// ---- Routes and Model Library data -----------------------------------------------
export { makeNodeApi } from "./shared/api.js";
export { getSharedJson as getLibraryJson, libraryThumbnailUrl } from "./model_library/api.js";
export { readLibrarySnapshot, writeCountHint, writeLibrarySnapshot } from "./shared/library_snapshot.js";
export { markKrcBootSettled } from "./shared/boot_state.js";
export { MODEL_SNAPSHOT_FIELDS, buildNormalizedMetadata } from "./shared/metadata_fields.js";
export { metadataStateMethods } from "./shared/metadata_state.js";

// ---- Cards, drag and drop, Portal -----------------------------------------------
// (1.17) A card source's notchMenu config may add `quickExtra(context, setMode)`: its own block
// under the quick row in the menu's main view.
// (1.19) In the KRC Portal a right-click on such a card opens the same menu at the pointer.
export { registerThumbnailPreview } from "./shared/thumbnail_preview.js";
export { renderModelCard } from "./shared/model_card.js";
// (1.14) The browser building blocks a pack's Portal mode composes its panel from (the
// built-in modes are whole node panels assembled from these).
export {
  browserCountText,
  browserEmptyNote,
  browserSkeletonShell,
  pinnedGlyph,
  teardownMedia,
  thumbnailBox,
} from "./shared/browser_cards.js";
export { mountVirtualList, renderLibraryBrowser, scrollVirtualListIntoView, updateVirtualList } from "./shared/library_browser.js";
export { renderInfoPanel } from "./shared/info_panel.js";
export { krcBrowserMetrics } from "./shared/browser_virtualization.js";
export { BROWSER_VIEWS, DEFAULT_BROWSER_VIEW, browserListClass } from "./shared/browser_views.js";
export { createNodeHostStub } from "./shared/node_host_stub.js";
export { applyCardColorStyle } from "./shared/card_colors.js";
export { clearKrcDragPayload, getKrcDragPayload, setKrcDragPayload } from "./shared/drag_payload.js";
export { openLibraryModal, registerLibraryProvider } from "./shared/library_modal.js";

// ---- Card API: model + prompt cards for any node (see shared/card_api.js) --------
export {
  cardMatchesSource,
  cardRef,
  cardStatus,
  createCardList,
  ensureCardStyles,
  fetchCards,
  makeCardDraggable,
  normalizeCardSource,
  openCardInfo,
  pickCard,
  readCardDrag,
  renderCard,
  renderCardList,
  resolveCards,
  savePrompt,
  subscribeCards,
} from "./shared/card_api.js";

// ---- Loadout Kit: a card-stack node from a Python kit descriptor (1.4) -------------
export { registerLoadout } from "./shared/loadout_kit/index.js";

// ---- Controls, menus, modals --------------------------------------------------------
export { switchToggle, menuSelect } from "./shared/browser_controls.js";
// (1.15) An InfoPanel's per-card buttons (top right, as in Model Library and Prompt Vault).
export { favoriteActionButton, pinActionButton } from "./shared/browser_controls.js";
// (1.20) Complete the shared InfoPanel attribute controls for sibling packs.
export { nsfwActionButton } from "./shared/browser_controls.js";
export { customBadgeActionButton } from "./shared/custom_badge_button.js";
// (1.22) Shared attribute constraints and display policy for sibling packs.
export { MAX_PINNED } from "./shared/pinning.js";
export { normalizeCardColorId } from "./shared/card_colors.js";
export { createCardColorFilterButton } from "./shared/card_color_button.js";
export { nsfwDisplayState } from "./shared/nsfw_visibility.js";
export { readGlobalSetting } from "./shared/global_settings.js";
export { createBrowserSelectionUI } from "./shared/browser_selection_ui.js";
export { createSelectionController } from "./shared/selection_controller.js";
export { createCardColorButton } from "./shared/card_color_button.js";
// (1.16) A chip strip (Prompt Vault's category chips): the strip shell, plain / split chips,
// the cheap active-chip sync and the inline notch editor. The strip CONTAINER layout stays
// per consumer (chip pills are styled in shared components.css).
export { chipEditor, chipStripShell, plainChip, splitChip, syncActiveChip } from "./shared/chip_strip.js";
export { closeFloatingMenu, toggleFloatingMenu } from "./shared/floating_menu.js";
export { openNumericPopover } from "./shared/numeric_popover.js";
export { createSearchableSelect } from "./shared/searchable_select.js";
export { krcModalSection, openKrcModal } from "./shared/modal.js";
export { armConfirmButton } from "./shared/confirm_action.js";
export { copyText } from "./shared/clipboard.js";

// ---- Presets: naming, status, dialogs, sync ----------------------------------------
export {
  NONE_PRESET_GROUP,
  canonicalGroup,
  composeTrigger,
  normalizePresetPrefixFilter,
  presetDisplayName,
  presetGroup,
  presetGroupLabel,
  presetPrefixOptions,
  presetsForPrefix,
} from "./shared/preset_naming.js";
export { LOCAL_STATUS, classifyLocalStatus, localStatusCopy, stableSignature } from "./shared/local_status.js";
export { localStatusBadge } from "./shared/badges.js";
export { openPresetNameDialog } from "./shared/preset_name_dialog.js";
export { KRC_SYNC_EVENTS, KRC_SYNC_LANES, isOwnSyncEvent, publishKrcSync, subscribeKrcSync } from "./shared/sync_bus.js";
// (1.11) Server events: utils/server_sync.publish_sync -> the sync bus, source "server".
export { SERVER_SOURCE as SERVER_SYNC_SOURCE } from "./shared/server_sync.js";
// KRC packs (1.10): settings on the Portal's Extra Options page.
export { onPackSettingChanged, packSetting, registerPackOptions } from "./krc_packs.js";
// KRC packs (1.13): a section of the KRC bundle (with Python register_bundle_section).
export { registerBundleSection } from "./shared/transfer/bundle_sections.js";
