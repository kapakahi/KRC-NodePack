// The Loadout Kit panel: LL mini's surface (preset panel + one stack) for any kit.
// Generic rewrite of KRC RefMod Loadout's panel (which was a copy of LL mini). Two
// classes share every mixin but the card provider: model kits get the Model Library
// data layer + metadata sync, prompt kits get Prompt Vault cards via the Card API.
import { app } from "../../../../scripts/app.js";
import { applyNodePalette } from "../node_palette.js";
import { teardownMedia } from "../browser_cards.js";
import { revealWhenStyled } from "../stylesheets.js";
import { isOwnSyncEvent, subscribeKrcSync } from "../sync_bus.js";
import { followGroupChange } from "../preset_group_actions.js";
import { markDirty } from "../widgets.js";
import {
  ENABLE_WEBM_THUMBNAILS_DEFAULT,
  ENABLE_WEBM_THUMBNAILS_SETTING_ID,
  NSFW_DISPLAY_MODE_DEFAULT,
  NSFW_DISPLAY_MODE_SETTING_ID,
  SHOW_NSFW_DEFAULT,
  SHOW_NSFW_SETTING_ID,
  WEBM_AUTOPLAY_DEFAULT,
  WEBM_AUTOPLAY_SETTING_ID,
} from "../settings.js";
import {
  SLOT_CARD_HEIGHT,
  STRIP_GAP,
  STRIP_HEIGHT,
  PRESETS_CHANGED_EVENT,
  PROP_LIST_THUMBS,
  PROP_SLOT_BADGE_ROW,
  STACK_ID,
  STACK_WIDGET,
} from "./constants.js";
import { controlMethods } from "./panel_controls.js";
import { presetMethods } from "./preset_controller.js";
import { stackMethods } from "./stack_view.js";
import { fieldStripMethods } from "./field_strip.js";
import { parseJsonArray, truthyPropertyValue } from "./util.js";
import {
  modelProviderMethods,
  promptProviderMethods,
  registerProviderPanel,
  unregisterProviderPanel,
} from "./providers.js";

function getGlobalSetting(id, fallback) {
  const setting = app.extensionManager?.setting;
  if (setting?.get) return setting.get(id);
  return app.ui?.settings?.getSettingValue?.(id, fallback);
}

function createPanelRoot(kit) {
  // LL mini's classes (its sheet styles the preset panel + slots) + the kit's own.
  const root = document.createElement("div");
  root.className = `krc-node krc-lora-stacker krc-loadout-kit krc-kit-${kit.id} krc-solo-widget is-mini`;
  root.dataset.kit = kit.id;
  const px = `${kit.domHeight}px`;
  root.style.height = px;
  root.style.overflow = "hidden";
  root.style.setProperty("--krc-dom-h", px);
  // Fixed card / strip sizes for loadout_kit.css (cards are never resized).
  root.style.setProperty("--krc-kit-card-h", `${SLOT_CARD_HEIGHT}px`);
  root.style.setProperty("--krc-kit-strip-h", `${STRIP_HEIGHT}px`);
  root.style.setProperty("--krc-kit-strip-gap", `${STRIP_GAP}px`);
  return root;
}

class LoadoutKitPanelBase {
  constructor(node, kit, { deferInit = false } = {}) {
    this.node = node;
    this.kit = kit;
    Object.assign(this, {
      surface: "mini",
      // No selection on this node (no info panel); kept "" for the shared metadata mixin.
      selectedSha: "",
      showNsfw: this.globalShowNsfw(),
      nsfwDisplayMode: this.globalNsfwDisplayMode(),
      webmThumbnailsEnabled: this.globalWebmThumbnailsEnabled(),
      webmThumbnailAutoplayEnabled: this.globalWebmThumbnailAutoplayEnabled(),
      listThumbs: truthyPropertyValue(node.properties?.[PROP_LIST_THUMBS]),
      slotBadgeRow: node.properties?.[PROP_SLOT_BADGE_ROW] !== false, // default on
      loras: [],
      aliases: {},
      metadataSnapshots: new Map(),
      metadataBaselines: new Map(),
      presets: kit.presetCache || [],
      isLoadingLibrary: false,
      draggedSha: "",
      pinned: [],
      stacks: { [STACK_ID]: parseJsonArray(kit.widgetValue(node, STACK_WIDGET), []) },
      root: createPanelRoot(kit),
      missingLoras: [],
      headerState: {},
      _started: false,
    });
    registerProviderPanel(this);
    if (!deferInit) this.start();
  }

  // ---- widgets -----------------------------------------------------------------------

  getWidget(name) {
    return this.kit.widgetValue(this.node, name);
  }

  setWidget(name, value) {
    return this.kit.setWidgetValue(this.node, name, value);
  }

  // ---- lifecycle ---------------------------------------------------------------------

  start() {
    if (this._started || this._destroyed) return;
    this._started = true;
    const hasCachedLibrary = this.applyCachedLibrary();
    this.restoreActivePresetBaseline();
    const willLoad = !hasCachedLibrary || this._libraryFromStaleSnapshot;
    this.render();
    this.installMetadataSyncListener?.();
    this.loadPresets();
    if (willLoad) this.loadLibrary(); // no cache, or a stale snapshot: refresh in the background
    // Presets are global; when a sibling node of this kit writes, adopt the cached list.
    this.unsubscribePresetsChanged = subscribeKrcSync(PRESETS_CHANGED_EVENT, (event) => {
      if (event?.detail?.kit !== this.kit.id || isOwnSyncEvent(event, this.node?.id)) return;
      // A group renamed / ungrouped / deleted elsewhere: a filter on it follows.
      const filter = this.getWidget("preset_prefix_filter");
      const followed = followGroupChange(filter, event);
      if (followed !== filter) this.setWidget("preset_prefix_filter", followed);
      if (event?.detail?.refetch) {
        this.loadPresets().then(() => this.adoptNewerActivePreset());
        return;
      }
      this.presets = this.kit.presetCache || [];
      this.restoreActivePresetBaseline();
      this.refreshPresetPanel();
      // Clean but behind the newer save: load it instead of showing Stale.
      this.adoptNewerActivePreset();
    });
    this.globalNsfwHandler = () => {
      this.showNsfw = this.globalShowNsfw();
      this.nsfwDisplayMode = this.globalNsfwDisplayMode();
      this.refreshStacks();
    };
    window.addEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
    this.webmThumbnailsHandler = () => {
      this.webmThumbnailsEnabled = this.globalWebmThumbnailsEnabled();
      this.webmThumbnailAutoplayEnabled = this.globalWebmThumbnailAutoplayEnabled();
      this.refreshStacks();
    };
    window.addEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
    window.addEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
  }

  // What rehydrate reads from the node, as the panel holds it now.
  rehydrateState() {
    return JSON.stringify([this.nsfwDisplayMode, this.showNsfw, this.listThumbs, this.slotBadgeRow, this.stacks]);
  }

  rehydrateFromNode() {
    const before = this._started ? this.rehydrateState() : "";
    const lorasBefore = this.loras;
    this.nsfwDisplayMode = this.globalNsfwDisplayMode();
    this.showNsfw = this.globalShowNsfw();
    this.listThumbs = truthyPropertyValue(this.node.properties?.[PROP_LIST_THUMBS]);
    this.slotBadgeRow = this.node.properties?.[PROP_SLOT_BADGE_ROW] !== false;
    this.stacks = { [STACK_ID]: parseJsonArray(this.getWidget(STACK_WIDGET), []) };
    if (!this._started) return;
    this.syncStackFromState(STACK_ID);
    this.applyCachedLibrary();
    // Rehydrate runs on every re-attach / onConfigure: rebuild (and refetch the presets,
    // otherwise kept live by their subscription) only when the node holds something new.
    if (this.rehydrateState() === before && this.loras === lorasBefore && this.root.firstChild) return;
    this.render();
    this.loadPresets();
  }

  globalShowNsfw() {
    return !!getGlobalSetting(SHOW_NSFW_SETTING_ID, SHOW_NSFW_DEFAULT);
  }

  globalNsfwDisplayMode() {
    return getGlobalSetting(NSFW_DISPLAY_MODE_SETTING_ID, NSFW_DISPLAY_MODE_DEFAULT) === "blur" ? "blur" : "hide";
  }

  globalWebmThumbnailsEnabled() {
    return !!getGlobalSetting(ENABLE_WEBM_THUMBNAILS_SETTING_ID, ENABLE_WEBM_THUMBNAILS_DEFAULT);
  }

  globalWebmThumbnailAutoplayEnabled() {
    return !!getGlobalSetting(WEBM_AUTOPLAY_SETTING_ID, WEBM_AUTOPLAY_DEFAULT);
  }

  shouldHideNsfw() {
    return false; // slots always show what was put in them; NSFW only blurs
  }

  shouldBlurNsfw(item) {
    return this.nsfwDisplayMode === "blur" && !!item?.nsfw && !this.showNsfw;
  }

  setSerializableProperty(name, value) {
    this.node.properties ||= {};
    if (typeof this.node.setProperty === "function") this.node.setProperty(name, value);
    else this.node.properties[name] = value;
    markDirty(this.node);
  }

  render() {
    this.closeFieldEditor(false);
    applyNodePalette(this.node, this.root); // restore saved per-node palette
    teardownMedia(this.root);
    this.root.innerHTML = "";
    const layout = document.createElement("div");
    layout.className = "krc-lora-mini-layout";
    layout.append(this.renderStacks());
    this.root.append(layout);
    revealWhenStyled(layout);
  }

  setListThumbs(value) {
    this.listThumbs = !!value;
    this.setSerializableProperty(PROP_LIST_THUMBS, this.listThumbs);
    this.refreshStacks();
  }

  setSlotBadgeRow(value) {
    this.slotBadgeRow = !!value;
    this.setSerializableProperty(PROP_SLOT_BADGE_ROW, this.slotBadgeRow);
    this.refreshStacks();
  }

  destroy() {
    this._destroyed = true;
    teardownMedia(this.root);
    unregisterProviderPanel(this);
    this.uninstallMetadataSyncListener?.();
    this.closeFieldEditor(false);
    this.unsubscribePresetsChanged?.();
    this.unsubscribePresetsChanged = null;
    if (this.globalNsfwHandler) {
      window.removeEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
      this.globalNsfwHandler = null;
    }
    if (this.webmThumbnailsHandler) {
      window.removeEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
      window.removeEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
      this.webmThumbnailsHandler = null;
    }
  }

  // ---- refresh levels ----------------------------------------------------------------

  refreshStacks() {
    const stacks = this.root.querySelector(".krc-stack-column");
    if (!stacks) {
      this.render();
      return;
    }
    stacks.replaceWith(this.renderStacks());
  }

  refreshStack(stackId) {
    const stack = this.root.querySelector(".krc-stack");
    if (!stack) {
      this.refreshStacks();
      return;
    }
    stack.replaceWith(this.renderStack(stackId));
  }

  refreshPresetPanel() {
    const panel = this.root.querySelector(".krc-preset-panel");
    if (!panel) {
      this.refreshStacks();
      return;
    }
    panel.replaceWith(this.renderPresetPanel());
  }

  // The shared metadata-sync mixin repaints browser/info surfaces this panel doesn't
  // have; on the mini surface they all collapse to the slots.
  refreshBrowser() {
    this.refreshStacks();
  }

  refreshInfo() {}

  refreshLoraCard(sha256) {
    this.refreshSlotCards(sha256);
  }

  invalidateVisibleLoras() {
    this._visibleLorasVersion = (this._visibleLorasVersion || 0) + 1;
  }

  // ---- ids ---------------------------------------------------------------------------

  keyOf(item) {
    return item.sha256;
  }

  canonicalId(value) {
    let current = String(value || "");
    const seen = new Set();
    while (current && this.aliases?.[current] && !seen.has(current)) {
      seen.add(current);
      current = String(this.aliases[current] || "");
    }
    return current || String(value || "");
  }

  canonicalizeRuntimeIds() {
    const remap = (value) => this.canonicalId(value);
    this.draggedSha = remap(this.draggedSha);
    this.stacks[STACK_ID] = this.stacks[STACK_ID].map((entry) => (
      entry?.sha256 && remap(entry.sha256) !== entry.sha256 ? { ...entry, sha256: remap(entry.sha256) } : entry
    ));
    this.persistStack(STACK_ID);
  }

  applyIdentityChange(identity = {}, { rememberAlias = true } = {}) {
    const oldId = identity.oldId || "";
    const newId = identity.newId || "";
    if (!oldId || !newId || oldId === newId) return false;

    const remap = (value) => (value === oldId ? newId : value);
    this.aliases = { ...(this.aliases || {}) };
    if (rememberAlias) {
      this.aliases[oldId] = newId;
    } else {
      delete this.aliases[oldId];
      Object.keys(this.aliases).forEach((key) => {
        if (this.aliases[key] === oldId) delete this.aliases[key];
      });
    }
    this.draggedSha = remap(this.draggedSha);
    this.stacks[STACK_ID] = this.stacks[STACK_ID].map((entry) => (
      entry?.sha256 === oldId ? { ...entry, sha256: newId } : entry
    ));
    this.persistStack(STACK_ID);

    if (this.metadataSnapshots.has(oldId) && !this.metadataSnapshots.has(newId)) {
      this.metadataSnapshots.set(newId, this.metadataSnapshots.get(oldId));
    }
    this.metadataSnapshots.delete(oldId);
    this.loras = this.loras.map((lora) => {
      if (!lora || lora.sha256 !== oldId) return lora;
      const next = { ...lora, sha256: newId, actualSha256: newId };
      if (!next.thumbnailSha || next.thumbnailSha === oldId) next.thumbnailSha = newId;
      return next;
    });
    this.invalidateVisibleLoras();
    this.updateLibraryCache({ loras: this.loras, aliases: this.aliases, metadataSnapshots: this.metadataSnapshots });
    this.shareMetadataSnapshots(this.metadataSnapshots);
    return true;
  }

  querySurface(selector) {
    return this.root.querySelector(selector);
  }

  querySurfaceAll(selector) {
    return Array.from(this.root.querySelectorAll(selector));
  }
}

const SHARED_MIXINS = [controlMethods, presetMethods, stackMethods, fieldStripMethods];

export class ModelKitPanel extends LoadoutKitPanelBase {}
export class PromptKitPanel extends LoadoutKitPanelBase {}

// Mixins go on each subclass's prototype (searched before the base class, as RefMod's
// Object.assign onto its class did). No mixin redefines a base-class method.
Object.assign(ModelKitPanel.prototype, ...SHARED_MIXINS, modelProviderMethods);
Object.assign(PromptKitPanel.prototype, ...SHARED_MIXINS, promptProviderMethods);

export function createKitPanel(node, kit, opts) {
  return kit.source.kind === "prompt" ? new PromptKitPanel(node, kit, opts) : new ModelKitPanel(node, kit, opts);
}
