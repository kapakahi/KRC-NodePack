import {
  deferredFieldStats,
  fieldByteBreakdown,
  imageStatsFromElements,
  imageStatsInCache,
  installKrcStatsAggregator,
  roughJsonBytes,
} from "../shared/memory_stats.js";


function metadataSnapshotCount(value) {
  if (!value) return 0;
  return value instanceof Map ? value.size : value.length || 0;
}


function deferredTextStats(loras = []) {
  return deferredFieldStats(loras, [
    { deferredKey: "descriptionDeferred", lengthKey: "descriptionLength", countKey: "descriptions", charKey: "descriptionChars" },
    { deferredKey: "examplePromptsDeferred", lengthKey: "examplePromptsLength", countKey: "examplePrompts", charKey: "examplePromptChars" },
    { deferredKey: "detailFieldsDeferred", countKey: "detailFields" },
  ]);
}


export function installLoraLoadoutStatsHook({ mountedPanels, getLibraryCache, getPresetCache }) {
  if (typeof window === "undefined" || window.krcLoraMemoryStats) return;
  window.krcLoraMemoryStats = ({ heavy = true } = {}) => {
    const panels = Array.from(mountedPanels || []).filter((panel) => !panel._destroyed);
    const libraryCache = getLibraryCache?.() || null;
    const presetCache = getPresetCache?.() || null;
    const panelStats = panels.map((panel) => {
      const root = panel.root;
      const visibleCards = root?.querySelectorAll?.(".krc-lora-card")?.length || 0;
      const visibleImageStats = imageStatsFromElements(root?.querySelectorAll?.(".krc-lora-card img, .krc-info-thumb img") || []);
      const cacheImageStats = imageStatsInCache(panel._loraCardCache, { entryElement: (entry) => entry?.card || entry });
      return {
        nodeId: panel.node?.id,
        surface: panel.surface,
        started: !!panel._started,
        loras: panel.loras?.length || 0,
        folders: panel.folders?.length || 0,
        metadataSnapshots: panel.metadataSnapshots?.size || 0,
        metadataSnapshotsShared: !!libraryCache?.metadataSnapshots && panel.metadataSnapshots === libraryCache.metadataSnapshots,
        metadataBaselines: panel.metadataBaselines?.size || 0,
        cardCache: panel._loraCardCache?.size || 0,
        cardCacheImages: cacheImageStats.images,
        cardCacheImageUrls: cacheImageStats.uniqueUrls,
        visibleCards,
        visibleImages: visibleImageStats.images,
        visibleImageUrls: visibleImageStats.uniqueUrls,
        view: panel.view,
        folder: panel.folder,
        selected: panel.selectedSha || "",
      };
    });
    return {
      panels: panelStats.length,
      libraryCache: libraryCache ? {
        loras: libraryCache.loras?.length || 0,
        folders: libraryCache.folders?.length || 0,
        metadataSnapshots: metadataSnapshotCount(libraryCache.metadataSnapshots),
        roughBytes: heavy ? roughJsonBytes(libraryCache) : null,
        deferredText: heavy ? deferredTextStats(libraryCache.loras) : null,
        fieldBytesTop: heavy ? fieldByteBreakdown(libraryCache.loras, { limit: 20 }) : null,
      } : null,
      presetCache: presetCache ? {
        presets: presetCache.length,
        roughBytes: heavy ? roughJsonBytes(presetCache) : null,
      } : null,
      dom: {
        loraCards: document.querySelectorAll(".krc-lora-card").length,
        loraImages: document.querySelectorAll(".krc-lora-card img, .krc-info-thumb img").length,
        loraNodes: document.querySelectorAll(".krc-lora-stacker").length,
      },
      panelsDetail: panelStats,
    };
  };
  installKrcStatsAggregator();
}
