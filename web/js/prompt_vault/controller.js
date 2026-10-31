/*
 * KRC Prompt Vault — controller.
 * The Prompt Vault controller class: constructor + core data / search /
 * selection / draft / render-orchestration. Responsibility-grouped method sets
 * (browser, info + preset fields / preset sync / prompt boxes / options menu,
 * persistence, thumbnails, display prefs, prompt detail, record
 * status, edit history, node state) are mixed onto the prototype via Object.assign.
 * Methods there call each other through `this`, so the split is by topic only.
 */
import { app } from "../../../scripts/app.js";
import { LOCAL_STATUS } from "../shared/local_status.js";
import { refreshBrowserCard, teardownMedia } from "../shared/browser_cards.js";
import { readPromptSnapshot, writePromptSnapshot, writeCountHint } from "../shared/library_snapshot.js";
import { markKrcBootSettled } from "../shared/boot_state.js";
import { applyCardColorStyle, normalizeCardColorId } from "../shared/card_colors.js";
import { copyText } from "../shared/clipboard.js";
import { dateMs } from "../shared/dates.js";
import { cancelFrame, debounce, queryDataAttr, scheduleFrame, scrollNearest } from "../shared/dom.js";
import { revealWhenStyled } from "../shared/stylesheets.js";
import { cachedFilterResult, filterAndSortItems, parseSearchToken, searchFilters } from "../shared/search.js";
import { showToast } from "../shared/toast.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, isOwnSyncEvent, normalizeSyncLane, publishKrcSync, subscribeKrcSync } from "../shared/sync_bus.js";
import { findWidget, markDirty } from "../shared/widgets.js";
import { ALIASES, DRAFT_KEY, EMPTY_PRESET_DISPLAY, EMPTY_PRESET_LINK, UNASSIGNED_CATEGORY, categoryLabel } from "./constants.js";
import { el } from "./dom.js";
import { profileMethods, watchProfiles, loadProfiles } from "./profiles.js";
import { profileCopyMethods } from "./profile_copy.js";
import { apiGet, fetchPromptLibraryJson, libraryProfileId } from "./api.js";
import { applyNodePalette } from "../shared/node_palette.js";
import { installPromptVaultStatsHook } from "./memory_stats.js";
import { PROMPT_TEXT_FIELD, promptFieldText } from "./search_fields.js";
import { browserMethods } from "./browser_view.js";
import { infoMethods } from "./info_view.js";
import { optionsMenuMethods } from "./options_menu.js";
import { presetFieldMethods } from "./preset_fields.js";
import { presetSyncMethods } from "./preset_sync.js";
import { promptBoxMethods } from "./prompt_boxes.js";
import { persistMethods } from "./persistence.js";
import { thumbnailMethods } from "./thumbnails.js";
import { browserSortValue, browserViewValue, colorFilterValue, displayMethods } from "./display_prefs.js";
import { editHistoryMethods } from "./edit_history.js";
import { nodeStateMethods } from "./node_state.js";
import { detailMethods, promptSummaryItem } from "./prompt_detail.js";
import { statusMethods } from "./record_status.js";
import { reconcilePromptBulk, reconcilePromptBulkRefresh } from "./bulk_operations.js";

const mountedPromptVaults = new Set();
let promptLibraryCache = null;
const promptLibraries = new Map();
const promptLibraryPromises = new Map();

// Live usage counts from the server's per-run counter (krc-prompt-usage event):
// {"Category/Name": {count, lastUsedMs}} new totals. Display-only — patches every
// copy of the record in place (shared library, each mounted vault's items, detail
// cache, saved baseline, open draft) and repaints only the open Info Panel's
// "Used N times" line. No list rebuild, no re-sort (the order catches up on the
// next refresh), no publish; useCount sits outside normalizedRecord, so it never
// reads as Modified/Stale.
export function applyPromptUsage(usage, profileId = "default") {
  if (!usage || typeof usage !== "object") return;
  const patch = (record, key) => {
    if (record?.profileId && record.profileId !== profileId) return false;
    const stats = record && typeof record === "object" && usage[key];
    if (!stats) return false;
    record.useCount = Math.max(0, Number(stats.count) || 0);
    record.lastUsedMs = Math.max(0, Number(stats.lastUsedMs) || 0);
    return true;
  };
  const libraries = new Set([promptLibraries.get(profileId), ...[...mountedPromptVaults].filter(ctrl => ctrl.effectiveProfileId() === profileId).map((ctrl) => ctrl.data)]);
  for (const data of libraries) {
    for (const [category, bucket] of Object.entries(data || {})) {
      if (!bucket || typeof bucket !== "object") continue;
      for (const [name, record] of Object.entries(bucket)) {
        if (name !== "__meta__") patch(record, `${category}/${name}`);
      }
    }
  }
  for (const ctrl of mountedPromptVaults) {
    if (ctrl._destroyed || ctrl.effectiveProfileId() !== profileId) continue;
    const usageKey = (record) => `${record?.category}/${record?.name}`;
    for (const item of ctrl.items || []) patch(item, usageKey(item));
    for (const detail of ctrl._promptDetailCache?.values?.() || []) patch(detail, usageKey(detail));
    patch(ctrl._savedPromptDetail, usageKey(ctrl._savedPromptDetail));
    if (ctrl.orig && patch(ctrl.draft, usageKey(ctrl.orig))) ctrl.refreshDateMeta();
  }
}

async function fetchPromptLibrary({ force = false, profileId = "default" } = {}) {
  if (!force && promptLibraries.has(profileId)) return promptLibraries.get(profileId);
  if (promptLibraryPromises.has(profileId)) return promptLibraryPromises.get(profileId);
  const promise = fetchPromptLibraryJson(profileId).then(data => {
    if (data) promptLibraries.set(profileId, data);
    if (profileId === "default" && data) promptLibraryCache = data;
    return data || {};
  }).finally(() => promptLibraryPromises.delete(profileId));
  promptLibraryPromises.set(profileId, promise);
  return promise;
}

const PROMPT_SNAPSHOT_SOURCE = "prompts";

export class PMRedesign {
  constructor(node, root, { surface = "full" } = {}) {
    this.node = node;
    this.root = root;
    this.surface = surface; // "full" (node) or "detached" (library modal)
    this._profileId = this.effectiveProfileId();
    this._dataProfileId = this._profileId;
    this.data = {};            // {category: {name: record}}
    this.items = [];           // flattened [{category, name, ...record}]
    this.query = "";
    this.activeCategory = "__all__";
    this.view = browserViewValue(node.properties?.pmBrowserView);
    this.sort = browserSortValue(node.properties?.pmBrowserSort);
    this.favOnly = !!node.properties?.pmFavOnly;
    this.colorFilter = colorFilterValue(node.properties?.pmColorFilter);
    this.listThumbs = !!node.properties?.pmListThumbs;
    this.showNSFW = this.resolveShowNSFW();   // NSFW prompts/categories are hidden by default; this reveals them
    this.nsfwDisplayMode = this.globalNsfwDisplayMode();
    this.webmThumbnailsEnabled = this.globalWebmThumbnailsEnabled();
    this.webmThumbnailAutoplayEnabled = this.globalWebmThumbnailAutoplayEnabled();
    this.pasteThumbMode = false;
    this.selKey = null;        // `${category}\u001f${name}` of selected
    this.draft = null;         // editable copy of the selected record
    this.orig = null;          // {category, name} of the loaded selection (for rename/move)
    this._promptDetailCache = new Map();
    this._savedPromptDetail = null;
    this._lastPromptSaveTextSource = null;
    this._lastPromptInputText = "";

    this.widgets = {
      category: findWidget(node, "category"),
      name: findWidget(node, "name"),
      text: findWidget(node, "text"),
      llPreset: findWidget(node, "ll_preset"),
      kitPresets: findWidget(node, "kit_presets"),
      promptB: findWidget(node, "prompt_b"),
      appendPromptB: findWidget(node, "append_prompt_b"),
      replaceFind: findWidget(node, "replace_find"),
      replaceWith: findWidget(node, "replace_with"),
      replacePromptB: findWidget(node, "replace_prompt_b"),
      clearLoraWhenMissing: findWidget(node, "clear_lora_when_missing"),
      promptInputEnabled: findWidget(node, "prompt_input_enabled"),
      promptInputTarget: findWidget(node, "prompt_input_target"),
      promptInputDisableOnSwap: findWidget(node, "prompt_input_disable_on_swap"),
      promptInputRejected: findWidget(node, "prompt_input_rejected"),
      promptInputRejectedTarget: findWidget(node, "prompt_input_rejected_target"),
      draftState: findWidget(node, "pm_draft"),
      // The saved prompt's record id, for API-format exports (see syncWidgetsFromDraft).
      promptId: findWidget(node, "prompt_id"),
    };
    this.setReplacePromptBEnabled(!!(node.properties?.pmReplacePromptB ?? this.widgets.replacePromptB?.value), { dirty: false });
    this.setClearLoraWhenMissing(!!(node.properties?.pmClearLoraWhenMissing ?? this.widgets.clearLoraWhenMissing?.value), { dirty: false });
    this.setPromptInputEnabled(!!(node.properties?.pmPromptInputEnabled ?? this.widgets.promptInputEnabled?.value), { dirty: false });
    this.setPromptInputTarget(node.properties?.pmPromptInputTarget ?? this.widgets.promptInputTarget?.value ?? "A", { dirty: false });
    this.setPromptInputDisableOnSwap(node.properties?.pmPromptInputDisableOnSwap ?? this.widgets.promptInputDisableOnSwap?.value ?? false, { dirty: false });
    this.setNewPromptEmptyPreset(!!node.properties?.pmNewPromptEmptyPreset, { dirty: false });
    // A load is always kicked right after construction (restoreSelection/reload),
    // so mark loading now — the first render then shows cold-start skeletons
    // instead of "No prompts." until data arrives.
    this._loadingLibrary = true;
    // Instant first paint: seed from the in-session cache, else a persisted
    // snapshot from a prior session. Never published as authoritative (share:false)
    // — the forced reload that follows is the source of truth and re-persists.
    const seed = promptLibraries.get(this._profileId) || (this._profileId === "default" ? readPromptSnapshot(PROMPT_SNAPSHOT_SOURCE) : null);
    if (seed) {
      this.setPromptLibrary(seed, { share: false });
    }
    mountedPromptVaults.add(this);
    this._profileOff = watchProfiles(() => {
      if (!this._destroyed) this.updateProfile().catch(() => {});
    });
    loadProfiles();
    installPromptVaultStatsHook({
      mountedPromptVaults,
      getPromptLibraryCache: () => promptLibraryCache,
    });
    this.globalNsfwHandler = () => {
      const next = this.resolveShowNSFW();
      this.showNSFW = next;
      this.nsfwDisplayMode = this.globalNsfwDisplayMode();
      if (this.shouldHideNSFW() && this.activeCategory !== "__all__" && this.categoryIsNsfw(this.activeCategory)) {
        this.activeCategory = "__all__";
        this.node.properties ||= {};
        this.node.properties.pmActiveCategory = "__all__";
      }
      this.refreshCategoryBrowser({ list: true, header: true, info: true });
    };
    window.addEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
    this.webmThumbnailsHandler = () => {
      this.webmThumbnailsEnabled = this.globalWebmThumbnailsEnabled();
      this.webmThumbnailAutoplayEnabled = this.globalWebmThumbnailAutoplayEnabled();
      this.refreshPromptMutation({
        list: true,
        replaceCard: false,
      });
    };
    window.addEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
    window.addEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
    // Out-of-band prompt-store changes (a bulk import on another instance, and
    // later a workflow write-node / the KRC Editor) arrive here. Same-page saves
    // already sync via publishPromptLibrary, so ignore our own echo and take a
    // targeted refetch+refresh — never a full teardown, never run-coupled.
    this._pvSyncSource = `pv:${node?.id ?? Math.random().toString(36).slice(2)}`;
    this.promptsChangedHandler = (event) => {
      if (isOwnSyncEvent(event, this._pvSyncSource)) return;
      this._pvBulkSyncPending ||= Boolean(event?.detail?.bulk);
      clearTimeout(this._pvPromptsChangedTimer);
      this._pvPromptsChangedTimer = setTimeout(() => {
        this._pvPromptsChangedTimer = null;
        const bulk = this._pvBulkSyncPending;
        this._pvBulkSyncPending = false;
        this.reloadFromSync({ bulk });
      }, 150);
    };
    this.promptsChangedUnsub = subscribeKrcSync(KRC_SYNC_EVENTS.PROMPTS_CHANGED, this.promptsChangedHandler);
  }

  // Targeted response to an out-of-band store change: refetch the library, drop a
  // vanished selection, and refresh the list + status only. Deliberately does NOT
  // rebuild the whole panel or clobber an in-progress draft (Stale/SYNC surfaces
  // via the badge, matching the content-lane sibling behavior in publishPromptLibrary).
  async reloadFromSync({ bulk = false } = {}) {
    const selectedId = bulk && !this.profileMismatch() && this.orig ? this.findByKey(this.selKey)?.id || this.draft?.id : null;
    await this.loadPromptLibrary({ force: true });
    if (bulk && !this.profileMismatch() && !this.profileMissing()) reconcilePromptBulkRefresh(this, selectedId);
    if (this.selKey && !this.findByKey(this.selKey)) this.selKey = null;
    // An import (Portal or a sibling's Options) can add or remove categories: follow a
    // vanished active category back to All, else rebuild just the chips (not while an
    // inline category edit is open), as the node's own import did via reload().
    if (this.activeCategory !== "__all__" && !this.categories().includes(this.activeCategory)) {
      this.activeCategory = "__all__";
      if (this.node.properties) this.node.properties.pmActiveCategory = "__all__";
      this.refreshBrowserPanel();
    } else {
      if (!this.categoryEditor) this.renderChipsOnly();
      this.refreshPromptList();
    }
    this.updateModifiedBadge?.();
    await this.adoptNewerSelectedFromSync();
    if (bulk && selectedId) this.refreshInfoPanel();
  }

  // The selected record was saved elsewhere and this node has no unsaved edit (Stale is
  // only ever that state; an edit reads Modified): load it, as clicking the Stale badge
  // does. Live sync only — a workflow reopened later keeps its copy and shows Stale.
  adoptNewerRecord() {
    if (this.profileMismatch() || this.profileMissing()) return false;
    if (this._destroyed || this.isDraftActive() || this.classifyRecord() !== LOCAL_STATUS.STALE) return false;
    this.discardDraft();
    return true;
  }

  // Out-of-band changes (the Card API's savePrompt, an import) arrive as a list refetch
  // whose text is deferred, so the saved copy this node compares against is still the old
  // one. When the selected record's saved date moved past the loaded baseline, fetch its
  // full record first, then adopt it like a sibling save (or just update the badge).
  async adoptNewerSelectedFromSync() {
    if (this._destroyed || this.isDraftActive() || !this.orig || !this.draft) return;
    const item = this.savedForDraft();
    const baseline = this.recordBaseline();
    if (!item || !baseline) return;
    if (this.dateMs(item.dateModified || item.dateAdded) <= baseline.modifiedAt) return;
    const key = this.selKey;
    const detail = await this.ensurePromptDetail(item, { refresh: true });
    if (this._destroyed || this.selKey !== key) return;
    this.setSavedPromptDetail(item, detail);
    if (!this.adoptNewerRecord()) this.updateModifiedBadge?.();
  }

  // — data —
  setPromptLibrary(data, { share = true, profileId = this.effectiveProfileId() } = {}) {
    if (share) {
      promptLibraries.set(profileId, data || {});
      if (profileId === "default") promptLibraryCache = data || {};
    }
    this._dataProfileId = profileId;
    this._sharedPromptLibraryVersion = share ? data : null;
    this.data = data || {};
    this.flatten();
    this._promptDetailCache?.clear();
    return this.data;
  }

  async loadPromptLibrary({ force = false } = {}) {
    const profileId = this.effectiveProfileId();
    const generation = this._profileLoadGeneration = (this._profileLoadGeneration || 0) + 1;
    this._loadingLibrary = true;
    try {
      const data = await fetchPromptLibrary({ force, profileId });
      if (this._destroyed || generation !== this._profileLoadGeneration || profileId !== this.effectiveProfileId()) return this.data;
      if (this.profileMissing()) { this.setPromptLibrary({}, { share: false }); return this.data; }
      this.setPromptLibrary(data, { share: true });
      // Persist the fresh light payload + count hint for the next hard refresh
      // (Perceived Loading gameplan, Stages 2/3).
      if (profileId === "default") {
        writePromptSnapshot(PROMPT_SNAPSHOT_SOURCE, this.data);
        writeCountHint(PROMPT_SNAPSHOT_SOURCE, this.items.length);
      }
      this.announcePromptLibrary();   // fresh from the server: other consumers catch up too
      markKrcBootSettled();   // a source library is up — release CS refresh gating
      return this.data;
    } finally {
      if (generation === this._profileLoadGeneration) this._loadingLibrary = false;
    }
  }

  publishPromptLibrary(data, { lane = KRC_SYNC_LANES.STRUCTURE, detail = null, attributePatch = null, structurePatch = null } = {}) {
    const profileId = libraryProfileId(data) || this._dataProfileId || this.effectiveProfileId();
    promptLibraries.set(profileId, data || {});
    if (profileId === "default") promptLibraryCache = data || {};
    lane = normalizeSyncLane(lane);
    const detailKey = detail?.category && detail?.name ? this.keyOf(detail.category, detail.name) : "";
    const metadataLane = lane === KRC_SYNC_LANES.METADATA;
    for (const ctrl of mountedPromptVaults) {
      if (ctrl._destroyed || ctrl.effectiveProfileId() !== profileId) continue;
      const previousSelectedId = structurePatch ? (ctrl.findByKey(ctrl.selKey)?.id || ctrl.draft?.id) : null;
      ctrl.setPromptLibrary(data || {}, { share: true, profileId });
      if (structurePatch && !ctrl.profileMismatch()) reconcilePromptBulk(ctrl, previousSelectedId, structurePatch);
      const selectedKey = ctrl.orig ? ctrl.keyOf(ctrl.orig.category, ctrl.orig.name) : "";
      const selectedItem = selectedKey && !ctrl.profileMismatch() ? ctrl.findByKey(selectedKey) : null;
      if (attributePatch && selectedItem && attributePatch.ids.includes(selectedItem.id)) {
        // Bulk metadata never adopts or saves the user's in-progress content draft.
        if (ctrl.draft) ctrl.draft[attributePatch.field] = attributePatch.value;
        if (ctrl._savedPromptDetail) ctrl._savedPromptDetail[attributePatch.field] = attributePatch.value;
      }
      if (ctrl !== this && detailKey && selectedKey === detailKey && selectedItem) {
        // On the metadata lane the broadcast detail is affordance-scoped and may carry
        // no prompt text (a flag/badge save doesn't load the full record). Rebuilding
        // the saved baseline from it would zero the sibling's TEXT baseline, mark a
        // clean sibling Modified, and make a discard wipe the visible prompt until
        // reselect. Content travels on the content lane, never here — so keep the
        // sibling's own saved text and let only the affordances come from the cache item.
        const textSource = metadataLane ? (ctrl.savedDetailForDraft?.() || detail) : detail;
        ctrl.setSavedPromptDetail(selectedItem, textSource);
        if (metadataLane && ctrl.draft) {
          for (const key of ["cardColor", "customBadge", "favorite", "rating", "pinned", "nsfw", "hasThumb", "thumbType", "thumbHasPoster", "thumbnailVersion", "id", "dateAdded", "dateModified"]) {
            if (key in detail) ctrl.draft[key] = detail[key];
          }
        }
      }
      ctrl.preserveSelectedPromptText();
      if (structurePatch) {
        ctrl.refreshCategoryBrowser?.({ list: true, header: true, info: true });
        continue;
      }
      if (ctrl !== this) {
        if (metadataLane) {
          if (detailKey) {
            ctrl.refreshPromptMutation?.({
              list: true,
              replaceCard: "nsfw" in (detail || {}) || "hasThumb" in (detail || {}) || "thumbType" in (detail || {}),
            });
          } else {
            ctrl.refreshCategoryBrowser?.({ list: true, header: true, info: true });
          }
        } else if (!ctrl.adoptNewerRecord?.()) {
          // A sibling now holds an older content copy of this record. With a local edit
          // it keeps its draft; refresh status so the badge surfaces live.
          ctrl.updateModifiedBadge?.();
        }
      }
    }
    if (profileId === this.effectiveProfileId()) this.announcePromptLibrary(lane);
    return this.data;
  }

  // Tell consumers outside Prompt Vault (Config Switcher prompt cards) about the library.
  announcePromptLibrary(lane = KRC_SYNC_LANES.METADATA) {
    // Legacy consumers treat this as the complete Default library. Foreign changes
    // still travel through the server's ID-based card notifications.
    if (this.effectiveProfileId() !== "default") return;
    publishKrcSync(KRC_SYNC_EVENTS.PROMPT_LIBRARY_UPDATED, {
      source: this._pvSyncSource,
      lane,
      prompts: promptLibraryCache,
    });
  }

  async reload(keepSelection = true, { preserveActiveFocus = false } = {}) {
    const hadFocus = preserveActiveFocus && this.hasActiveFocus();
    await this.loadPromptLibrary({ force: true });
    if (keepSelection && this.selKey && !this.findByKey(this.selKey)) this.selKey = null;
    // Refresh only the open draft's thumbnail state without clobbering in-progress field edits.
    if (this.draft && this.selKey) {
      const it = this.findByKey(this.selKey);
      if (it) {
        this.preservePromptText(it, this.draft);
        this.draft.hasThumb = it.hasThumb;
        this.draft.thumbType = it.thumbType;
        this.draft.thumbHasPoster = it.thumbHasPoster;
        this.draft.thumbnailVersion = it.thumbnailVersion;
        this.draft.id = it.id || this.draft.id;
        this.draft.dateAdded = it.dateAdded || this.draft.dateAdded;
        this.draft.dateModified = it.dateModified || this.draft.dateModified;
      }
    }
    const keepFocusedUi = preserveActiveFocus && (hadFocus || this.hasActiveFocus());
    await this.refreshLlPresetCache?.({ patchPicker: keepFocusedUi });
    if (keepFocusedUi) {
      this.refreshPromptList();
      this.updateModifiedBadge();
      return;
    }
    this.refreshAll({ preserveScroll: true });
  }
  hasActiveFocus() {
    const active = document.activeElement;
    return !!active && active !== document.body && this.root.contains(active);
  }
  flatten() {
    const items = [];
    for (const [cat, bucket] of Object.entries(this.data)) {
      if (!bucket || typeof bucket !== "object") continue;
      for (const [name, rec] of Object.entries(bucket)) {
        if (name === "__meta__" || !rec || typeof rec !== "object") continue;
        items.push({ ...promptSummaryItem(cat, name, rec), profileId: this._dataProfileId });
      }
    }
    this.items = items;
    // Bump so the filtered() memo (keyed partly on this) recomputes after any
    // data change. Draft-flag toggles mutate item copies in place, so callers
    // that need the memo invalidated on such edits bump this too.
    this._itemsVersion = (this._itemsVersion || 0) + 1;
  }
  keyOf(cat, name) { return `${cat}\u001f${name}`; }
  findByKey(key) { return this.items.find(it => this.keyOf(it.category, it.name) === key) || null; }
  // Identity for browser items: the synthetic draft item keys to DRAFT_KEY, every
  // real record to its category/name key.
  itemKey(it) { return it?.__draft ? DRAFT_KEY : this.keyOf(it.category, it.name); }
  attrKey(key) { return encodeURIComponent(key || ""); }
  cardForKey(key) {
    return queryDataAttr(this.root, ".krc-lora-card", "data-pm-key", this.attrKey(key));
  }

  categories() {
    const cats = [...new Set([UNASSIGNED_CATEGORY, ...this.items.map(it => it.category)])];
    return cats.sort((a, b) => {
      if (a === UNASSIGNED_CATEGORY) return -1;
      if (b === UNASSIGNED_CATEGORY) return 1;
      const ap = this.categoryIsPinned(a);
      const bp = this.categoryIsPinned(b);
      if (ap !== bp) return ap ? -1 : 1;
      return a.localeCompare(b);
    });
  }
  categoryMeta(category) {
    const meta = this.data?.[category]?.__meta__;
    return meta && typeof meta === "object" ? meta : {};
  }
  categoryIsNsfw(category) {
    if (category === UNASSIGNED_CATEGORY) return false;
    return !!this.categoryMeta(category).nsfw;
  }
  categoryColor(category) {
    if (category === UNASSIGNED_CATEGORY) return "";
    return normalizeCardColorId(this.categoryMeta(category).cardColor);
  }
  categoryIsPinned(category) {
    if (category === UNASSIGNED_CATEGORY) return false;
    return !!this.categoryMeta(category).pinned;
  }
  visibleCategories() {
    return this.categories().filter(category => !this.shouldHideNSFW() || !this.categoryIsNsfw(category));
  }
  pinnedItems() {
    return this.items.filter(it => it.pinned);
  }
  dateMs(value) {
    return dateMs(value);
  }
  formatDateTimeAmPm(value) {
    const ms = dateMs(value);
    if (!ms) return "";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    const hours = d.getHours();
    const suffix = hours >= 12 ? "PM" : "AM";
    const hour12 = hours % 12 || 12;
    return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} - ${hour12}:${p(d.getMinutes())} ${suffix}`;
  }
  formatDateModified(item) {
    const dt = this.formatDateTimeAmPm(item?.dateModified || item?.dateAdded);
    return dt ? `Date Modified: ${dt}` : "";
  }
  updateDateMetaEl(el, item) {
    if (!el) return;
    const count = Number(item?.useCount || 0);
    const usage = document.createElement("span");
    usage.textContent = `Used ${Number.isFinite(count) ? Math.max(0, count) : 0} times`;
    const date = document.createElement("span");
    date.textContent = this.formatDateModified(item);
    el.replaceChildren(usage, date);
  }
  refreshDateMeta() {
    const el = this.root?.querySelector(".krc-date-meta");
    if (el && this.draft) this.updateDateMetaEl(el, this.draft);
  }

  draftChanged({ sync = true, list = false } = {}) {
    if (sync) this.syncWidgetsFromDraft();
    this.updateModifiedBadge();
    if (list) this.refreshPromptList();
    this.scheduleEditSnapshot();
  }

  fillBadgeRow(row, item, modified) {
    row.innerHTML = "";
    let count = 0;
    if (item?.__draft) {
      // The draft card carries only a small teal Draft badge, matching the card's
      // other badges (is-nsfw / is-json); the larger status badge lives in the editor.
      row.append(el("span", "krc-card-badge is-draft", { textContent: "Draft" }));
      return 1;
    }
    if (item?.favorite) row.append(el("span", "krc-card-fav is-on", { textContent: "★", title: "Favorite" }));
    if (item?.favorite) count++;
    if (item?.nsfw) { row.append(el("span", "krc-card-badge is-nsfw", { textContent: "NSFW" })); count++; }
    if (item?.customBadge) { row.append(el("span", "krc-card-badge is-json", { textContent: item.customBadge })); count++; }
    if (modified) { row.append(el("span", "krc-card-badge is-modified", { textContent: "Modified" })); count++; }
    return count;
  }
  refreshSelectedPromptCard(opts = {}) {
    if (this.isDraftActive()) {
      // Rebuild the draft card so its title tracks the name field (replace forces a
      // rebuild; the draft item's signature keys on the name).
      this.refreshPromptCard(DRAFT_KEY, this.draftItem(), false, { ...opts, replace: true });
      return;
    }
    if (!this.selKey || !this.draft) return;
    this.refreshPromptCard(this.selKey, this.draft, this.isModified(), opts);
  }
  refreshPromptCard(key, item = null, modified = false, { replace = false } = {}) {
    const card = this.cardForKey(key);
    const virtualList = replace ? card?.closest?.(".krc-lora-list.is-virtualized") : null;
    if (virtualList) {
      this._cardCache?.delete?.(key);
      this.updateVirtualPromptList(virtualList);
      return;
    }
    refreshBrowserCard({
      key,
      replace,
      cache: this._cardCache,
      findCard: (cardKey) => card || this.cardForKey(cardKey),
      findItem: (cardKey) => item || this.findByKey(cardKey),
      renderCard: (nextItem) => this.renderCard(nextItem),
      updateCard: (card, nextItem) => this.updateCardMeta(card, nextItem, modified),
    });
  }
  removePromptCard(key) {
    this._cardCache?.delete(key);
    this.refreshPromptList();
  }
  updateSelectedCardMeta() {
    this.refreshSelectedPromptCard();
  }
  updateCardMeta(card, item, modified = false, selected = card.classList.contains("is-selected")) {
    applyCardColorStyle(card, item?.cardColor || "", { selected });
    const meta = card.querySelector(".krc-card-meta");
    const sub = meta?.querySelector(".krc-lora-sub");
    meta?.querySelector(".krc-badge-row")?.remove();
    const row = el("div", "krc-badge-row krc-browser-badges");
    const count = this.fillBadgeRow(row, item, modified);
    if (count && meta) meta.insertBefore(row, sub || null);
    if (sub) sub.textContent = [categoryLabel(item.category), item.model].filter(Boolean).join(" · ");
  }

  // — search (LoRA Loadout key:value helpers, adapted to Prompt Vault fields;
  // ALIASES in constants.js) —
  parseToken(token) {
    return parseSearchToken(token, ALIASES);
  }
  fieldText(item, field) {
    return promptFieldText(item, field);
  }
  // — prompt: search. Prompt A / B are held back from the list, so the server says which
  // saved prompts match every prompt: value (GET /search-text); the field then answers from
  // that. Asked once typing pauses; the last answer stays on screen until the next arrives.
  promptTextTerms() {
    return searchFilters(this.query, ALIASES).filter((f) => f.field === PROMPT_TEXT_FIELD).map((f) => f.value);
  }
  requestPromptTextMatches(terms) {
    if (this._destroyed) return;
    const key = `${this._itemsVersion || 0}|${JSON.stringify(terms)}`;
    if (key === this._promptTextKey || key === this._promptTextWanted) return;
    this._promptTextWanted = key;
    clearTimeout(this._promptTextTimer);
    this._promptTextTimer = setTimeout(async () => {
      this._promptTextTimer = null;
      if (this._destroyed) return;
      // Quotes keep each term whole (terms never contain a quote: the parser removed them).
      const q = terms.map((term) => `prompt:"${term}"`).join(" ");
      const payload = await apiGet.call(this, `/search-text?q=${encodeURIComponent(q)}`);
      if (this._destroyed || this._promptTextWanted !== key) return;   // a newer query took over
      this._promptTextWanted = "";
      this._promptTextKey = key;
      this._promptTextFailed = !Array.isArray(payload?.matches);
      this._promptTextMatches = new Set((payload?.matches || []).map(([category, name]) => this.keyOf(category, name)));
      this._promptTextVersion = (this._promptTextVersion || 0) + 1;
      this.refreshCategoryBrowser({ list: true });
    }, 200);
  }
  promptTextFieldText(item, terms) {
    return this._promptTextMatches?.has(this.keyOf(item.category, item.name)) ? terms.join("\n") : "";
  }
  promptTextSearchPending() {
    return !!this._promptTextWanted;
  }
  filtered() {
    const promptTerms = this.promptTextTerms();
    if (promptTerms.length) {
      this.requestPromptTextMatches(promptTerms);
    } else if (this._promptTextWanted) {
      clearTimeout(this._promptTextTimer);   // prompt: was removed before its answer came
      this._promptTextWanted = "";
    }
    // Memoize: filtering + sorting the whole list runs 2–3× per render pass
    // (list, footer, cycle-enabled check). Recompute only when an input changes.
    const sig = `${this._itemsVersion || 0}|${this.query}|${this.activeCategory}|${this.favOnly ? 1 : 0}|${this.colorFilter || ""}|${this.showNSFW ? 1 : 0}|${this.nsfwDisplayMode || "hide"}|${this.sort}|${this._promptTextVersion || 0}`;
    return cachedFilterResult(this, sig, () => {
      const nameSort = (a, b) => a.name.localeCompare(b.name);
      return filterAndSortItems(this.items, {
        query: this.query,
        aliases: ALIASES,
        fieldText: (it, field) => (field === PROMPT_TEXT_FIELD
          ? this.promptTextFieldText(it, promptTerms)
          : this.fieldText(it, field)),
        predicate: (it) => {
          if (this.favOnly && !it.favorite) return false;
          const color = normalizeCardColorId(it.cardColor || "");
          if (this.colorFilter === "__none__" && color) return false;
          if (this.colorFilter && this.colorFilter !== "__none__" && color !== normalizeCardColorId(this.colorFilter)) return false;
          if (this.shouldHideNSFW() && this.itemIsNsfw(it)) return false;
          return this.facet().matches(it);
        },
        compare: (a, b) => {
          switch (this.sort) {
            case "za": return b.name.localeCompare(a.name);
            case "added_new": return this.dateMs(b.dateAdded) - this.dateMs(a.dateAdded) || nameSort(a, b);
            case "added_old": return this.dateMs(a.dateAdded) - this.dateMs(b.dateAdded) || nameSort(a, b);
            case "modified_new": return this.dateMs(b.dateModified || b.dateAdded) - this.dateMs(a.dateModified || a.dateAdded) || nameSort(a, b);
            case "modified_old": return this.dateMs(a.dateModified || a.dateAdded) - this.dateMs(b.dateModified || b.dateAdded) || nameSort(a, b);
            // Usage sorts (silent per-emit ledger, joined in as useCount/lastUsedMs); ties → name.
            case "used_most": return (Number(b.useCount || 0) - Number(a.useCount || 0)) || nameSort(a, b);
            case "used_recent": return (Number(b.lastUsedMs || 0) - Number(a.lastUsedMs || 0)) || nameSort(a, b);
            default: return nameSort(a, b);
          }
        },
        isPinned: (it) => !!it.pinned,
      });
    });
  }

  // — selection / draft —
  async select(item, { scroll = false } = {}) {
    const requestedKey = item ? this.keyOf(item.category, item.name) : "";
    this._selectRequestKey = requestedKey;
    item = await this.ensurePromptDetail(item);
    if (this._selectRequestKey !== requestedKey) return;
    const oldKey = this.selKey;
    this.disarmDelete();
    this.disarmThumbRemove();
    this.selKey = item.profileId && item.profileId !== this.effectiveProfileId() ? null : this.keyOf(item.category, item.name);
    if (!this.selKey) this._selectRequestKey = null;
    this.orig = { category: item.category, name: item.name, profileId: item.profileId || this.effectiveProfileId() };
    this._savedPromptDetail = { ...item };
    this.draft = { ...item };
    this.syncWidgetsFromDraft();
    this.captureRecordBaseline();   // snapshot the record's global state at load
    this.resetEditHistory();
    if (this.selectInPlace(oldKey, this.selKey, { scroll })) return;
    this.refreshAll({ preserveScroll: true });
  }
  selectInPlace(oldKey, newKey, { scroll = false } = {}) {
    const info = this.root.querySelector(".krc-info-panel");
    const list = this.root.querySelector(".krc-lora-list");
    if (!info || !list) return false;

    if (scroll) this.scrollVirtualPromptIntoView?.(newKey);
    const nextCard = this.cardForKey(newKey);
    if (!nextCard) return false;

    // Deselect a card and DROP its cache entry. The manual patch below mutates the
    // live node's is-selected without changing its cache signature, so a later
    // virtual re-render could otherwise serve a cached node with stale selection
    // (the draft card, whose signature can match across a mutation, made this
    // visible as lingering multi-highlight). Deleting forces a correct rebuild.
    const deselect = (key) => {
      if (!key || key === newKey) return;
      const card = this.cardForKey(key);
      if (card) {
        const item = key === DRAFT_KEY ? this.draftItem() : this.findByKey(key);
        if (item) this.updateCardMeta(card, item, false, false);
        else card.classList.remove("is-selected");
      }
      this._cardCache?.delete(key);
    };
    deselect(oldKey);
    // The draft card can be left highlighted by an earlier state even when it
    // wasn't the immediate previous selection — always reconcile it here (this
    // path only ever selects a real record; the draft is selected via selectDraft).
    if (this.hasPvDraft() && !this.isDraftActive()) deselect(DRAFT_KEY);

    if (this.draft) this.updateCardMeta(nextCard, this.draft, this.isModified(), true);
    this._cardCache?.delete(newKey);
    teardownMedia(info);
    info.replaceWith(this.renderInfo());
    if (scroll) scrollNearest(nextCard);
    return true;
  }
  discardDraft() {
    if (this.profileMismatch()) { this.discardOtherPrompt(); return; }
    if (!this.orig) return;
    const saved = this.savedForDraft();
    if (!saved) return;
    this.disarmDelete();
    this.disarmThumbRemove();
    const savedDetail = this.savedDetailForDraft() || saved;
    if (this.promptInputEnabled() && this.isPromptInputTargetModified(savedDetail)) {
      this.rejectCurrentPromptInput();
    }
    this.draft = { ...savedDetail };
    this.selKey = this.keyOf(saved.category, saved.name);
    this.syncWidgetsFromDraft();
    this.captureRecordBaseline();   // discarding syncs to the current global -> clean
    this.resetEditHistory();
    const selectedCard = this.cardForKey(this.selKey);
    if (selectedCard) this.updateCardMeta(selectedCard, saved, false);
    const info = this.root.querySelector(".krc-info-panel");
    if (info) {
      teardownMedia(info);
      info.replaceWith(this.renderInfo());
    } else this.refreshAll({ preserveScroll: true });
  }
  // Escape hatch (Options ▸ Troubleshooting): drop the in-memory draft and wipe the
  // persisted pm_draft so a stuck "modified" prompt clears. Discards the current
  // unsaved edit — confirm-guarded at the call site.
  resetPromptEditState() {
    this.disarmDelete?.();
    this.disarmThumbRemove?.();
    this.clearPersistedDraft();
    this.writePvDraft(null);   // also drop the node-local draft prompt, if any
    this.setSerializableProperty("pmDraftSelected", false);
    this.draft = null;
    this.orig = null;
    this.selKey = null;
    this.resetEditHistory?.();
    this.refreshAll({ preserveScroll: true });
    this.toast?.("Cleared unsaved prompt edits");
  }
  blankDraft(cat = UNASSIGNED_CATEGORY) {
    return { category: cat, name: "", prompt: "", promptB: "", llPreset: "", llPresetLabel: "", kitPresets: {}, model: "", notes: "", appendPromptB: false, replaceFind: "", replaceWith: "", favorite: false, rating: 0, nsfw: false, customBadge: "", pinned: false };
  }
  newPromptDraft(cat = UNASSIGNED_CATEGORY) {
    const draft = this.blankDraft(cat);
    if (this.newPromptEmptyPresetEnabled?.()) {
      draft.llPreset = EMPTY_PRESET_LINK;
      draft.llPresetLabel = EMPTY_PRESET_DISPLAY;
    }
    return draft;
  }
  // ── node-local draft prompt (pvDraftPrompt) ──────────────────────────────────
  // Exactly one draft per PV node, stored separately from the saved-record edit
  // buffer (pmDraft) so it survives navigating to other prompts and workflow
  // reload. A draft has no global record yet, so it is Draft — never Modified or
  // Stale — until the user saves it (see LOCAL_STATUS_AND_DRAFT_GAMEPLAN.md §5).
  pvDraft() {
    const d = this.node?.properties?.pvDraftPrompt;
    return d && typeof d === "object" ? d : null;
  }
  hasPvDraft() {
    return !!this.pvDraft();
  }
  isDraftActive() {
    return this.selKey === DRAFT_KEY;
  }
  writePvDraft(record) {
    this.setSerializableProperty("pvDraftPrompt", record || null);
    this.node.serialize_widgets = true;
    this.markCanvasDirty();
  }
  // Enter the draft as the active editing target (its edits persist to
  // pvDraftPrompt via syncWidgetsFromDraft's draft branch).
  selectDraft() {
    const d = this.pvDraft();
    if (!d) return;
    this.disarmDelete();
    this.disarmThumbRemove();
    this.selKey = DRAFT_KEY;
    this.orig = null;
    this.draft = { ...this.blankDraft(d.category || UNASSIGNED_CATEGORY), ...d };
    this.resetEditHistory();
    this.syncWidgetsFromDraft();
    // Drop any stale draft-card cache entry so it rebuilds selected (a prior manual
    // deselect can leave a cached node whose signature still matches).
    this._cardCache?.delete(DRAFT_KEY);
    this.refreshAll({ preserveScroll: true });
  }
  discardPvDraft() {
    const wasActive = this.isDraftActive();
    this.writePvDraft(null);
    if (wasActive) {
      this.selKey = null;
      this.orig = null;
      this.draft = null;
      this.setSerializableProperty("pmDraftSelected", false);
    }
    this.resetEditHistory?.();
    this.refreshAll({ preserveScroll: true });
  }
  newPrompt() {
    this.disarmDelete();
    this.disarmThumbRemove();
    // New with an existing draft focuses it rather than replacing the work; only
    // mint a fresh blank draft when none exists yet.
    if (this.hasPvDraft()) {
      this.selectDraft();
      return;
    }
    const cat = this.activeCategory !== "__all__" ? this.activeCategory : UNASSIGNED_CATEGORY;
    this.writePvDraft(this.newPromptDraft(cat));
    this.selectDraft();
  }
  cycleSelection(delta) {
    const rows = this.filtered();
    if (!rows.length) return;
    let idx = this.selKey ? rows.findIndex(it => this.keyOf(it.category, it.name) === this.selKey) : -1;
    if (idx < 0) idx = delta > 0 ? -1 : 0;
    const next = (idx + delta + rows.length) % rows.length;
    this.select(rows[next], { scroll: true });
  }
  // Persist the active category chip so it survives workflow reloads / restarts.
  // Stored in node.properties (a plain serialized bag) alongside the backing
  // widget mirrors written by syncWidgetsFromDraft.
  setActiveCategory(value) {
    this.activeCategory = value;
    this._browserSelectionUI?.refresh();
    this.node.properties ||= {};
    this.node.properties.pmActiveCategory = value;
    if (!this.updateActiveCategoryChips?.()) this.renderChipsOnly();
    this.refreshPromptList();
  }

  // When the SELECTED prompt moves to another category, follow the browser filter so
  // its card stays visible + in focus. Only switches when filtered to a specific
  // category that isn't already the target ("__all__" already shows it, and a
  // same-category rename needs no switch). Persists the active category like a chip
  // click; the CALLER repaints chips + list. Returns whether it switched.
  followSelectionCategory(newCategory) {
    const target = String(newCategory || "").trim();
    if (!target || this.activeCategory === "__all__" || this.activeCategory === target) return false;
    this.activeCategory = target;
    this.node.properties ||= {};
    this.node.properties.pmActiveCategory = target;
    return true;
  }
  // Reload data then restore the browser's UI state (active category chip +
  // selected prompt) after a workflow load / ComfyUI restart. Scrolls the
  // restored card into view so the selection is visibly focused.
  async restoreSelection(cat, name, activeCategory, serializedDraft = null, hasStoredDraft = false) {
    if (activeCategory) this.activeCategory = activeCategory === "Default" ? UNASSIGNED_CATEGORY : activeCategory;
    this._profileId = this.effectiveProfileId();
    await this.reload(false);
    // The node-local draft was the active selection: bring it back as the editing
    // target. (Its card is rendered from pvDraftPrompt by any refresh regardless.)
    if (this.node?.properties?.pmDraftSelected && this.hasPvDraft()) {
      this.selectDraft();
      return;
    }
    const restoredCat = cat === "Default" ? UNASSIGNED_CATEGORY : cat;
    if (restoredCat && name) {
      const recordId = serializedDraft?.id || this.widgets.promptId?.value;
      let it = recordId ? this.items.find(item => item.id === recordId) : this.findByKey(this.keyOf(restoredCat, name));
      if (!it && recordId) {
        const foreign = await apiGet(`/prompt-detail?id=${encodeURIComponent(recordId)}`);
        if (foreign?.id === recordId) it = foreign;
      }
      if (it) {
        const full = await this.ensurePromptDetail(it);
        this.selKey = (it.profileId || this.effectiveProfileId()) === this.effectiveProfileId() ? this.keyOf(it.category, it.name) : null;
        this.orig = { category: it.category, name: it.name, profileId: it.profileId || this.effectiveProfileId() };
        this._savedPromptDetail = { ...full };
        this.draft = serializedDraft ? this.draftFromSerialized(full, serializedDraft) : { ...full };
        this.syncWidgetsFromDraft();
        this.resetEditHistory();
        this.refreshAll({ preserveScroll: true });
        this.scrollSelectionIntoView();
        return;
      }
    }
    // No saved record matched. If a real draft was persisted — a New/unsaved
    // prompt, or edits whose saved record no longer exists — restore it as an
    // unsaved editing buffer (selKey/orig stay null) rather than falling back to
    // the empty "Select a prompt" state. The draft is what the node is already
    // emitting to the graph, so the UI must reflect it across reloads.
    if (hasStoredDraft && serializedDraft) {
      this.selKey = null;
      this.orig = serializedDraft.id ? { category: restoredCat || serializedDraft.category,
        name: name || serializedDraft.name, profileId: serializedDraft.profileId || "default" } : null;
      this._savedPromptDetail = null;
      this.draft = this.draftFromSerialized(
        this.blankDraft(serializedDraft.category || UNASSIGNED_CATEGORY),
        serializedDraft,
      );
      this.syncWidgetsFromDraft();
      this.resetEditHistory();
      this.refreshAll();
      return;
    }
    this.refreshAll();
  }

  // Scroll the currently selected card (this.selKey) into view on the next frame.
  // Used after list-reordering operations that keep the selection but can push its
  // card off-screen — restore-on-load, and duplicate (the new "X copy" card lands
  // wherever the active sort places it, which is rarely next to the source).
  scrollSelectionIntoView() {
    scheduleFrame(this, "_restoreSelectionFrame", () => {
      this.scrollVirtualPromptIntoView?.(this.selKey);
      scrollNearest(this.cardForKey(this.selKey));
    });
  }

  markCanvasDirty() {
    if (this._dirtyFrame) return;
    markDirty(this.node);
    scheduleFrame(this, "_dirtyFrame", () => {
      app.graph?.setDirtyCanvas(true, true);
    });
  }

  destroy() {
    this._profileOff?.();
    this._browserSelectionUI?.destroy();
    this._destroyed = true;
    clearTimeout(this._promptTextTimer);
    this._promptTextTimer = null;
    this._promptTextWanted = "";
    this._pmSplitObserver?.disconnect();
    this._pmSplitObserver = null;
    teardownMedia(this.root);
    mountedPromptVaults.delete(this);
    cancelFrame(this, "_dirtyFrame");
    cancelFrame(this, "_categoryEditorFocusFrame");
    cancelFrame(this, "_restoreSelectionFrame");
    cancelFrame(this, "_promptVirtualViewportFrame");
    this._promptVirtualViewportDebounce?.cancel?.();
    clearTimeout(this._categoryDeleteTimer);
    clearTimeout(this._categoryPurgeTimer);
    this._categoryDeleteTimer = null;
    this._categoryPurgeTimer = null;
    this._promptDetailCache?.clear();
    this._promptDetailPromises?.clear();
    this._savedPromptDetail = null;
    this._lastPromptSaveTextSource = null;
    if (this.globalNsfwHandler) {
      window.removeEventListener("krc-global-nsfw-default-changed", this.globalNsfwHandler);
      this.globalNsfwHandler = null;
    }
    if (this.webmThumbnailsHandler) {
      window.removeEventListener("krc-webm-thumbnails-changed", this.webmThumbnailsHandler);
      window.removeEventListener("krc-webm-thumbnail-autoplay-changed", this.webmThumbnailsHandler);
      this.webmThumbnailsHandler = null;
    }
    if (this.promptsChangedUnsub) {
      this.promptsChangedUnsub();
      this.promptsChangedUnsub = null;
      this.promptsChangedHandler = null;
    }
    clearTimeout(this._pvPromptsChangedTimer);
    this._pvPromptsChangedTimer = null;
  }

  sortUsesModifiedDate() {
    return this.sort === "modified_new" || this.sort === "modified_old";
  }

  refreshPromptMutation({ list = false, info = true, card = true, replaceCard = false } = {}) {
    if (list) this.refreshPromptList();
    else if (card) this.refreshSelectedPromptCard({ replace: replaceCard });
    if (info) this.refreshInfoPanel();
  }

  scheduleVirtualPromptViewportUpdate() {
    scheduleFrame(this, "_promptVirtualViewportFrame", () => {
      const list = this.root.querySelector(".krc-lora-list.is-virtualized");
      if (list) this.updateVirtualPromptList?.(list);
    });
  }

  scheduleVirtualPromptViewportUpdateAfterResize() {
    if (!this._promptVirtualViewportDebounce) {
      this._promptVirtualViewportDebounce = debounce(() => this.scheduleVirtualPromptViewportUpdate(), 140);
    }
    this._promptVirtualViewportDebounce();
  }

  copyText(value) {
    return copyText(value);
  }
  toast(msg) {
    return showToast(msg);
  }

  // Build the save-prompt payload from the current draft.

  // Persist the draft in place (no rename/move) — used for instant star / NSFW
  // toggles on an already-saved prompt. New/unsaved drafts persist on full Save.

  // — render —
  // Render levels, from broadest to narrowest:
  // 1. refreshAll/render: rebuild the whole Prompt Vault UI.
  // 2. refreshBrowserPanel: rebuild browser header/chips/list/footer only.
  // 3. refreshPromptList: rebuild the card list/footer only, preserving search focus.
  // 4. refreshInfoPanel: rebuild the right editor panel only.
  // 5. refreshPromptCard/refreshSelectedPromptCard: patch one card in place.
  refreshAll(opts = {}) {
    this.render(opts);
  }
  render(opts = {}) {
    const scroll = opts.preserveScroll ? (this.root.querySelector(".krc-lora-list")?.scrollTop ?? 0) : 0;
    applyNodePalette(this.node, this.root); // restore saved per-node palette
    teardownMedia(this.root);
    this.root.innerHTML = "";
    const grid = el("div", "krc-pm-grid");
    grid.append(this.renderBrowser(), this.renderInfo());
    this.root.append(grid);
    // Hide the grid until its layout CSS is actually applied to this element, so a
    // fresh boot never flashes the browser column full-width over the info panel
    // while the @imported layout sheet is still landing. No-op once styled. Same
    // guard as ML/LL — see revealWhenStyled.
    revealWhenStyled(grid);
    const list = this.root.querySelector(".krc-lora-list");
    if (list && opts.preserveScroll) {
      list.scrollTop = scroll;
      this.updateVirtualPromptList?.(list);
    }
  }

  // Implementation aliases for the named refresh levels below. New call sites
  // should prefer refreshInfoPanel/refreshBrowserPanel/refreshPromptList so the
  // intended repaint scope is obvious at the call site.
  renderInfoOnly() {
    const info = this.root.querySelector(".krc-info-panel");
    if (!info) return this.refreshAll({ preserveScroll: true });
    teardownMedia(info);
    info.replaceWith(this.renderInfo());
  }
  refreshInfoPanel() {
    this.renderInfoOnly();
  }
  renderBrowserOnly({ keepChips = false } = {}) {
    const panel = this.root.querySelector(".krc-browser-panel");
    if (!panel) return this.refreshAll({ preserveScroll: true });
    // keepChips reuses the live category-chip node so favorite/color/view toggles
    // don't rebuild it (the chip set is unchanged by them); NSFW / category edits
    // omit it so the chips rebuild.
    const chipShell = keepChips ? panel.querySelector(".krc-chip-list-shell, .krc-chip-list") : null;
    panel.replaceWith(this.renderBrowser(chipShell ? { chipShell } : undefined));
  }
  refreshBrowserPanel(opts = {}) {
    this.renderBrowserOnly(opts);
  }
  refreshPromptList() {
    this.renderListOnly();
  }

  // Browser-view methods (renderBrowser/Chips/List/ListOnly/Card/Footer)
  // are mixed in from ./browser_view.js (see Object.assign below).

  // — Info panel —
  // Info-view methods (renderInfo, field, textBox, switches, config menu)
  // are mixed in from ./prompt_vault/info_view.js (see Object.assign below).

  // — thumbnails —

  // — export / import (reuse the shared archive endpoints) —

}

// Mix responsibility-grouped method modules onto the controller prototype
// (LoRA Loadout's panel.js pattern). Methods still bind `this` to the instance.
Object.assign(
  PMRedesign.prototype,
  profileMethods,
  profileCopyMethods,
  browserMethods,
  infoMethods,
  presetFieldMethods,
  presetSyncMethods,
  promptBoxMethods,
  optionsMenuMethods,
  persistMethods,
  thumbnailMethods,
  displayMethods,
  detailMethods,
  statusMethods,
  editHistoryMethods,
  nodeStateMethods,
);
