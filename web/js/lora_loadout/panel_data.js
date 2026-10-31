import { getSharedJson } from "./api.js";
import { patchItemUsage } from "../shared/library_usage.js";
import { setWidgetValue, widgetValue } from "./helpers.js";
import { installLoraLoadoutStatsHook } from "./memory_stats.js";
import { readLibrarySnapshot, writeLibrarySnapshot, writeCountHint } from "../shared/library_snapshot.js";
import { markKrcBootSettled } from "../shared/boot_state.js";
import { queueLibraryLoad, runQueuedLibraryLoad } from "../shared/library_wait.js";

const SNAPSHOT_SOURCE = "loras";


let libraryCache = null;
const mountedPanels = new Set();
// Presets are global (server-side, shared by every node). Cache them module-side
// like the library so a freshly created panel (workflow switch, node re-create)
// has them synchronously — otherwise the first stack edit before loadPresets'
// async fetch resolves can't find the active preset and misses the dirty badge.
let presetCache = null;


function metadataSnapshotStore(value) {
  if (!value) return null;
  return value instanceof Map ? value : new Map(value);
}


function shareMetadataSnapshots(store) {
  if (!store) return;
  for (const panel of mountedPanels) {
    if (!panel._destroyed) {
      panel.metadataSnapshots = store;
    }
  }
}


function installMemoryStatsHook() {
  installLoraLoadoutStatsHook({
    mountedPanels,
    getLibraryCache: () => libraryCache,
    getPresetCache: () => presetCache,
  });
}


export function getCachedPresets() {
  return presetCache || [];
}


// New usage totals from the per-run counter: patch the shared library list and every
// mounted panel's copy (LoRA Loadout). Display-only; no re-sort.
export function applyLibraryUsage(usage) {
  const lists = new Set([libraryCache?.loras, ...[...mountedPanels].map((panel) => panel.loras)]);
  for (const list of lists) patchItemUsage(list, usage);
}


export function registerMountedPanel(panel) {
  mountedPanels.add(panel);
  installMemoryStatsHook();
}


export function unregisterMountedPanel(panel) {
  mountedPanels.delete(panel);
}


export const panelDataMethods = {
  // Which libraries' heal pushes reload this surface (LoRA Loadout shows LoRAs only).
  healLineages() {
    return ["loras"];
  },

  applyCachedLibrary() {
    if (!libraryCache) {
      // No in-session cache: try a persisted snapshot from a prior session so a
      // hard refresh paints the last library instantly. Tagged stale so start()
      // still kicks a background refresh; metadataSnapshots left empty (the
      // refresh captures the authoritative baseline from full data).
      const snapshot = readLibrarySnapshot(SNAPSHOT_SOURCE);
      if (!snapshot) {
        return false;
      }
      libraryCache = {
        loras: snapshot.loras,
        aliases: {},
        folders: snapshot.folders,
        scan: snapshot.scan,
        status: "Refreshing library…",
        stale: true,
        metadataSnapshots: new Map(),
      };
    }
    this._libraryFromStaleSnapshot = Boolean(libraryCache.stale);

    this.loras = libraryCache.loras;
    this.folders = libraryCache.folders;
    this.aliases = libraryCache.aliases || {};
    this.scan = libraryCache.scan;
    this.status = libraryCache.status;
    this.canonicalizeRuntimeIds();
    if (libraryCache.metadataSnapshots) {
      this.metadataSnapshots = metadataSnapshotStore(libraryCache.metadataSnapshots);
      libraryCache.metadataSnapshots = this.metadataSnapshots;
    } else {
      this.captureMetadataSnapshots();
      libraryCache.metadataSnapshots = this.metadataSnapshots;
    }
    shareMetadataSnapshots(this.metadataSnapshots);
    this.applyMetadataDraft();   // restore unsaved edits on top of the saved baseline
    if (!this.folders.some((folder) => folder.name === this.folder)) {
      this.folder = "loras";
    }
    this.invalidateVisibleLoras();
    if (!this.selectedSha && this.loras.length) {
      this.selectedSha = this.loras[0].sha256;
      setWidgetValue(this.node, "selected_lora_sha256", this.selectedSha);
    }
    return true;
  },

  // force: rescan the disk. changed: the server already updated one record (its scan
  // cache is current), so reload without a rescan but still tell sibling surfaces.
  async loadLibrary(options = {}) {
    const { restoreScroll = false, focusSelection = false, focusFolder = true, force = false, changed = false, fromSync = false } = options;
    if (this.isLoadingLibrary) {
      queueLibraryLoad(this, options);
      return;
    }

    const previousSelection = this.selectedSha || widgetValue(this.node, "selected_lora_sha256") || "";
    const previousListScroll = restoreScroll ? this.browserListScrollTop() : 0;
    this.isLoadingLibrary = true;
    this.status = this.describeLoading();
    // Only the scan-note text and refresh button (both in the browser panel)
    // change here — refresh that panel rather than tearing down stacks + info.
    this.refreshBrowser();

    try {
      // Shared with every other node loading at the same time (one request, own copy).
      const { ok, status, data: payload, token } = await getSharedJson(`/library${force ? "?refresh=1" : ""}`);
      if (!ok) {
        this.status = `Library request failed: HTTP ${status}`;
        this.isLoadingLibrary = false;
        this.refreshBrowser();   // status/button-only change → browser panel
        return;
      }
      if (!payload || typeof payload !== "object") throw new Error("Invalid library payload");
      this.loras = Array.isArray(payload.loras) ? payload.loras : [];
      this.aliases = payload.aliases && typeof payload.aliases === "object" ? payload.aliases : {};
      this.canonicalizeRuntimeIds();
      this.captureMetadataSnapshots();
      this.applyMetadataDraft();   // restore unsaved edits on top of the saved baseline
      this.folders = Array.isArray(payload.folders) && payload.folders.length ? payload.folders : [{ name: "loras", count: 0 }];
      this.scan = payload.scan || this.scan;
      this.libraryScanIds = payload.scanIds && typeof payload.scanIds === "object" ? payload.scanIds : {};
      // Read the wanted folder now, not when the load started: an opener can set it
      // meanwhile (the Portal's first Browse scopes a fresh panel mid-load).
      const desiredFolder = this.node.properties?.llBrowserFolder || this.folder;
      this.folder = this.folders.some((folder) => folder.name === desiredFolder) ? desiredFolder : "loras";
      this.invalidateVisibleLoras();
      this.status = this.describeScan();
      libraryCache = {
        loras: this.loras,
        aliases: this.aliases,
        folders: this.folders,
        scan: this.scan,
        status: this.status,
        metadataSnapshots: this.metadataSnapshots,
      };
      // Persist the fresh light payload for the next hard refresh (Stage 2), plus
      // a tiny count hint that sizes cold-start skeletons (Stage 3).
      writeLibrarySnapshot(SNAPSHOT_SOURCE, {
        loras: this.loras,
        folders: this.folders,
        scan: this.scan,
      }, { token });
      writeCountHint(SNAPSHOT_SOURCE, this.loras.length);
      markKrcBootSettled();   // a source library is up — release CS refresh gating
      shareMetadataSnapshots(this.metadataSnapshots);
      if (this.loras.length) {
        const latestSelection = this.canonicalId(widgetValue(this.node, "selected_lora_sha256") || this.selectedSha || previousSelection);
        this.selectedSha = this.loras.some((lora) => lora.sha256 === latestSelection) ? latestSelection : this.loras[0].sha256;
        setWidgetValue(this.node, "selected_lora_sha256", this.selectedSha);
      } else {
        this.selectedSha = "";
        setWidgetValue(this.node, "selected_lora_sha256", "");
      }
      this.isLoadingLibrary = false;
      this.render();
      if (restoreScroll) {
        this.restoreBrowserListScroll(previousListScroll);
      }
      if (focusSelection) {
        this.focusSelectedLora();
      }
      if (focusFolder) {
        this.focusActiveFolder();
      }
      // Tell sibling library surfaces to reconverge (a forced scan may have found a
      // new/removed file, or one record changed). Only a user-initiated load broadcasts;
      // a sync-triggered reload stays silent so the two nodes don't ping-pong reloads.
      // (A rescan the server did because files moved outside KRC reaches every page as a
      // krc-library-healed push instead; see installMetadataSyncListener.)
      if ((force || changed) && !fromSync) {
        this.broadcastLibraryChanged?.();
      }
    } catch {
      this.status = this.loras.length
        ? "Library refresh failed. Showing cached LoRA list."
        : "Library route unavailable. Check the browser console and ComfyUI server log for /krc/lora-loadout/library.";
      this.isLoadingLibrary = false;
      this.refreshBrowser();   // status/button-only change → browser panel
    } finally {
      runQueuedLibraryLoad(this);
    }
  },

  async loadPresets({ broadcast = false } = {}) {
    try {
      const { ok, data: presets } = await getSharedJson("/presets");
      if (!ok) {
        return;
      }
      if (!presets || typeof presets !== "object") throw new Error("Invalid presets payload");
      this.presets = Array.isArray(presets.presets) ? presets.presets : [];
      presetCache = this.presets;
      this.reconcileActivePresetId();
      this.restoreActivePresetBaseline();
      this.refreshPresetPanel();
      if (broadcast) {
        this.broadcastPresetsChanged?.();
      }
    } catch {
      // A transient fetch failure must not wipe the known presets — that would
      // silently break dirty-badge detection until the next successful load.
      this.presets = presetCache || [];
    }
  },

  async refreshLibraryAndPresets() {
    await this.loadLibrary({ force: true, focusSelection: true });
    await this.loadPresets({ broadcast: true });
  },

  describeLoading() {
    // Honest in-flight label: if cards are already on screen we're refreshing
    // over them (stale-while-refresh), not scanning up from a blank panel.
    return this.loras.length ? "Refreshing library…" : "Scanning LoRA library…";
  },

  describeScan() {
    // Per-root found/missing detail stays in the footer tooltip (scanDetails);
    // the visible line reports scan health while the count row owns library
    // totals (visible / safetensors / total).
    const errorCount = this.scan?.errors?.length || 0;
    const errorNote = errorCount ? ` · ${errorCount} scan error${errorCount === 1 ? "" : "s"}` : "";
    return `Library scan complete${errorNote}`;
  },

  updateLibraryCache(patch = {}) {
    if (!libraryCache) {
      return null;
    }
    libraryCache = {
      ...libraryCache,
      ...patch,
    };
    return libraryCache;
  },

  updateLibraryLora(sha256, patch = {}) {
    if (!sha256) {
      return null;
    }
    let updated = null;
    this.loras = this.loras.map((lora) => {
      if (lora.sha256 !== sha256) {
        return lora;
      }
      updated = { ...lora, ...patch };
      return updated;
    });
    this.updateLibraryCache({ loras: this.loras });
    this.invalidateVisibleLoras();
    return updated;
  },

  updateCachedMetadataSnapshots() {
    if (libraryCache) {
      libraryCache.metadataSnapshots = this.metadataSnapshots;
      shareMetadataSnapshots(this.metadataSnapshots);
    }
  },

  shareMetadataSnapshots(store) {
    shareMetadataSnapshots(store);
  },
};
