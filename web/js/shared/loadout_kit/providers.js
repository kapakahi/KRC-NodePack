// Loadout Kit card providers: where a kit's cards come from and how they stay live.
// Panels hold library items in `this.loras` (LL heritage: `sha256` is the card id).
//
// - model:  Model Library's list filtered to the kit's folder, with the shared metadata
//           sync (colours, names, thumbnails, stabilized ids, heals) — RefMod Loadout's
//           data layer made generic over the folder.
// - prompt: Prompt Vault cards through the Card API (fetchCards / subscribeCards).
import { getSharedJson as getLibraryJson, libraryListPath, libraryThumbnailUrl } from "../../model_library/api.js";
import { readLibrarySnapshot, writeCountHint, writeLibrarySnapshot } from "../library_snapshot.js";
import { markKrcBootSettled } from "../boot_state.js";
import { queueLibraryLoad, runQueuedLibraryLoad } from "../library_wait.js";
import { buildNormalizedMetadata, MODEL_SNAPSHOT_FIELDS } from "../metadata_fields.js";
import { metadataStateMethods } from "../metadata_state.js";
import { fetchCards, openCardInfo, promptCardsFrom, subscribeCards } from "../card_api.js";
import { KRC_SYNC_EVENTS, subscribeKrcSync } from "../sync_bus.js";
import { openLibraryModal } from "../library_modal.js";

// ---- shared per-source state -------------------------------------------------------

// sourceKey -> { cache, panels }
const sources = new Map();

function sourceKey(source) {
  return source.kind === "prompt" ? `prompt:${source.category || ""}` : `model:${source.folder || ""}`;
}

function sourceState(panel) {
  const key = sourceKey(panel.kit.source);
  if (!sources.has(key)) sources.set(key, { cache: null, panels: new Set() });
  return sources.get(key);
}

export function registerProviderPanel(panel) {
  sourceState(panel).panels.add(panel);
}

export function unregisterProviderPanel(panel) {
  sourceState(panel).panels.delete(panel);
}

function metadataSnapshotStore(value) {
  if (!value) return null;
  return value instanceof Map ? value : new Map(value);
}

function shareMetadataSnapshots(panel, store) {
  if (!store) return;
  for (const other of sourceState(panel).panels) {
    if (!other._destroyed) other.metadataSnapshots = store;
  }
}

// ---- model provider ----------------------------------------------------------------

const modelDataMethods = {
  // Which libraries' heal pushes reload this surface (LoRAs heal in LoRA Loadout's lineage;
  // an unscoped kit lists both, like Model Library).
  healLineages() {
    const folder = this.kit.source.folder;
    if (!folder) return ["models", "loras"];
    return folder === "lora" ? ["loras"] : ["models"];
  },

  libraryItems(payload) {
    const items = Array.isArray(payload?.items) ? payload.items : [];
    const folder = this.kit.source.folder;
    return folder ? items.filter((item) => item?.modelType === folder) : items;
  },

  snapshotSource() {
    return `kit-model-${this.kit.source.folder || "all"}`;
  },

  applyCachedLibrary() {
    const state = sourceState(this);
    if (!state.cache) {
      // No in-session cache: paint a persisted snapshot from a prior session, tagged
      // stale so start() still kicks a background refresh.
      const snapshot = readLibrarySnapshot(this.snapshotSource());
      if (!snapshot) return false;
      state.cache = { loras: snapshot.loras, aliases: {}, stale: true, metadataSnapshots: new Map() };
    }
    const cache = state.cache;
    this._libraryFromStaleSnapshot = Boolean(cache.stale);
    this.loras = cache.loras;
    this.aliases = cache.aliases || {};
    this.canonicalizeRuntimeIds();
    if (cache.metadataSnapshots) {
      this.metadataSnapshots = metadataSnapshotStore(cache.metadataSnapshots);
      cache.metadataSnapshots = this.metadataSnapshots;
    } else {
      this.captureMetadataSnapshots();
      cache.metadataSnapshots = this.metadataSnapshots;
    }
    shareMetadataSnapshots(this, this.metadataSnapshots);
    this.invalidateVisibleLoras();
    return true;
  },

  // force: rescan the disk. changed: the server already updated one record, so reload
  // without a rescan but still tell sibling surfaces.
  async loadLibrary(options = {}) {
    const { force = false, changed = false, fromSync = false } = options;
    if (this.isLoadingLibrary) {
      queueLibraryLoad(this, options);
      return;
    }
    this.isLoadingLibrary = true;
    try {
      // Same URL as Model Library's own load, so concurrent nodes share one request.
      const { ok, data: payload, token } = await getLibraryJson(libraryListPath(force));
      if (!ok || !payload || typeof payload !== "object") {
        this.isLoadingLibrary = false;
        return;
      }
      this.loras = this.libraryItems(payload);
      this.aliases = payload.aliases && typeof payload.aliases === "object" ? payload.aliases : {};
      this.canonicalizeRuntimeIds();
      this.captureMetadataSnapshots();
      this.libraryScanIds = payload.scanIds && typeof payload.scanIds === "object" ? payload.scanIds : {};
      this.invalidateVisibleLoras();
      sourceState(this).cache = { loras: this.loras, aliases: this.aliases, metadataSnapshots: this.metadataSnapshots };
      writeLibrarySnapshot(this.snapshotSource(), { loras: this.loras, folders: [], scan: {} }, { token });
      writeCountHint(this.snapshotSource(), this.loras.length);
      markKrcBootSettled();
      shareMetadataSnapshots(this, this.metadataSnapshots);
      this.isLoadingLibrary = false;
      this.render();
      if ((force || changed) && !fromSync) this.broadcastLibraryChanged?.();
    } catch {
      this.isLoadingLibrary = false;
    } finally {
      runQueuedLibraryLoad(this);
    }
  },

  updateLibraryCache(patch = {}) {
    const state = sourceState(this);
    if (!state.cache) return null;
    state.cache = { ...state.cache, ...patch };
    return state.cache;
  },

  updateCachedMetadataSnapshots() {
    const state = sourceState(this);
    if (state.cache) {
      state.cache.metadataSnapshots = this.metadataSnapshots;
      shareMetadataSnapshots(this, this.metadataSnapshots);
    }
  },

  shareMetadataSnapshots(store) {
    shareMetadataSnapshots(this, store);
  },

  // The shared metadata-sync mixin snapshots records with this (model field set).
  normalizedMetadata(record = {}) {
    return buildNormalizedMetadata(record, MODEL_SNAPSHOT_FIELDS);
  },

  // Model Library's thumbnail route, versioned per item.
  thumbnailUrl(item, kind = "") {
    return libraryThumbnailUrl(item?.thumbnailSha || item?.sha256 || "", {
      version: Number(item?.thumbnailVersion) || 0,
      kind,
    });
  },

  openLibraryBrowser() {
    openLibraryModal({ provider: "models", scope: this.kit.source.folder || "all" });
  },

  openCardInfoFor(item) {
    openLibraryModal({ provider: "models", scope: this.kit.source.folder || "all", select: item, infoOpen: true });
  },

  cardInfoTitle() {
    return "Open in Model Library";
  },

  // The drag payload a slot card carries to other KRC drop targets.
  dragPayloadFor(item, id) {
    const folder = this.kit.source.folder || item?.modelType || "";
    return {
      kind: folder === "lora" ? "lora" : "model",
      id,
      modelType: folder,
      path: item?.path || "",
      relativePath: item?.relativePath || "",
      file: item?.filename || "",
      title: item?.display_name || item?.filename || id,
      cardColor: this.effectiveLoraCardColor?.(item) || item?.cardColor || "",
      favorite: Boolean(item?.favorite),
    };
  },
};

export const modelProviderMethods = { ...metadataStateMethods, ...modelDataMethods };

// ---- prompt provider ---------------------------------------------------------------

function promptItem(ref) {
  return {
    sha256: ref.id,
    display_name: ref.title,
    category: ref.category,
    cardColor: ref.cardColor,
    favorite: ref.favorite,
    nsfw: ref.nsfw,
    customBadge: ref.customBadge,
    // Prompt thumbnails come as ready URLs (the slot card source reads this first).
    __thumbUrl: ref.thumbnailUrl,
    __previewVideoUrl: ref.previewVideoUrl,
  };
}

export const promptProviderMethods = {
  healLineages() {
    return [];
  },

  applyCachedLibrary() {
    const cache = sourceState(this).cache;
    if (!cache) return false;
    this.loras = cache.loras;
    this.invalidateVisibleLoras();
    return true;
  },

  // `prompts`: a library already in hand (no fetch). A call while a load runs is kept (the
  // latest one) and run after it.
  async loadLibrary({ prompts = null } = {}) {
    if (this.isLoadingLibrary) {
      this._queuedPromptLoad = { prompts };
      return;
    }
    this.isLoadingLibrary = true;
    try {
      const refs = prompts ? promptCardsFrom(prompts, this.kit.source) : await fetchCards(this.kit.source);
      this.loras = refs.map(promptItem);
      sourceState(this).cache = { loras: this.loras };
      this.invalidateVisibleLoras();
      markKrcBootSettled();
    } finally {
      this.isLoadingLibrary = false;
    }
    if (!this._destroyed) this.render();
    const queued = this._queuedPromptLoad;
    this._queuedPromptLoad = null;
    if (queued && !this._destroyed) this.loadLibrary(queued);
  },

  // Live: a prompt save / rename / colour anywhere updates the cards. Prompt Vault's saves
  // publish the whole library (PROMPT_LIBRARY_UPDATED), so the cards come from it; only an
  // out-of-band change (an import: PROMPTS_CHANGED with refetch), or a change that came
  // without the library, refetches.
  installMetadataSyncListener() {
    this._publishedPrompts = null;
    this._unsubscribePublishedPrompts = [
      subscribeKrcSync(KRC_SYNC_EVENTS.PROMPT_LIBRARY_UPDATED, (event) => {
        const prompts = event?.detail?.prompts;
        this._publishedPrompts = prompts && typeof prompts === "object" ? prompts : null;
      }),
      subscribeKrcSync(KRC_SYNC_EVENTS.PROMPTS_CHANGED, (event) => {
        if (event?.detail?.refetch) this._publishedPrompts = null;
      }),
    ];
    this._unsubscribeCards = subscribeCards(this.kit.source, () => {
      const prompts = this._publishedPrompts;
      this._publishedPrompts = null;
      if (!this._destroyed) this.loadLibrary({ prompts });
    });
  },

  uninstallMetadataSyncListener() {
    this._unsubscribeCards?.();
    this._unsubscribeCards = null;
    this._unsubscribePublishedPrompts?.forEach((off) => off());
    this._unsubscribePublishedPrompts = null;
  },

  captureMetadataSnapshots() {},
  updateLibraryCache() {
    return null;
  },
  updateCachedMetadataSnapshots() {},
  shareMetadataSnapshots() {},

  effectiveLoraCardColor(item) {
    return item?.cardColor || "";
  },

  thumbnailUrl() {
    return "";
  },

  openLibraryBrowser() {
    openLibraryModal({ provider: "prompts" });
  },

  openCardInfoFor(item) {
    openCardInfo({ kind: "prompt", id: item.sha256, category: item.category, title: item.display_name });
  },

  cardInfoTitle() {
    return "Open in Prompt Vault";
  },

  dragPayloadFor(item, id) {
    return {
      kind: "prompt",
      id,
      category: item?.category || "",
      title: item?.display_name || id,
      thumbnailUrl: item?.__thumbUrl || "",
      previewVideoUrl: item?.__previewVideoUrl || "",
      cardColor: item?.cardColor || "",
      favorite: Boolean(item?.favorite),
    };
  },
};
