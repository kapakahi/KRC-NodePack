import {
  deferredFieldStats,
  imageStatsFromElements,
  imageStatsInCache,
  installKrcStatsAggregator,
  roughJsonBytes,
} from "../shared/memory_stats.js";

const HEAVY_PROMPT_TEXT_KEYS = ["prompt", "promptB", "notes"];

function deferredPromptTextStats(items = []) {
  return deferredFieldStats(items, [
    { deferredKey: "textDeferred", lengthKey: "textLength", countKey: "prompts", charKey: "chars" },
  ]);
}

function retainedPromptTextStats(items = []) {
  let records = 0;
  let chars = 0;
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    let itemChars = 0;
    for (const key of HEAVY_PROMPT_TEXT_KEYS) {
      itemChars += String(item[key] || "").length;
    }
    if (itemChars) {
      records += 1;
      chars += itemChars;
    }
  }
  return { records, chars };
}

export function installPromptVaultStatsHook({ mountedPromptVaults, getPromptLibraryCache }) {
  if (typeof window === "undefined" || window.krcPromptVaultMemoryStats) return;
  window.krcPromptVaultMemoryStats = ({ heavy = true } = {}) => {
    const controllers = Array.from(mountedPromptVaults || []);
    const promptLibraryCache = getPromptLibraryCache?.() || null;
    const detail = controllers.map((ctrl) => {
      const cacheImageStats = imageStatsInCache(ctrl._cardCache);
      const visibleImageStats = imageStatsFromElements(ctrl.root?.querySelectorAll?.(".krc-lora-card img, .krc-info-thumb img") || []);
      return {
        nodeId: ctrl.node?.id,
        categories: Object.keys(ctrl.data || {}).length,
        items: ctrl.items?.length || 0,
        dataBytes: heavy ? roughJsonBytes(ctrl.data) : null,
        itemsBytes: heavy ? roughJsonBytes(ctrl.items) : null,
        dataShared: ctrl.data === promptLibraryCache,
        cardCache: ctrl._cardCache?.size || 0,
        cardCacheImages: cacheImageStats.images,
        cardCacheImageUrls: cacheImageStats.uniqueUrls,
        detailCache: ctrl._promptDetailCache?.size || 0,
        detailCacheText: heavy ? retainedPromptTextStats(ctrl._promptDetailCache?.values?.() || []) : null,
        visibleCards: ctrl.root?.querySelectorAll?.(".krc-lora-card")?.length || 0,
        visibleImages: visibleImageStats.images,
        visibleImageUrls: visibleImageStats.uniqueUrls,
        view: ctrl.view,
        activeCategory: ctrl.activeCategory,
        selected: ctrl.selKey || "",
      };
    });
    const uniquePromptKeys = new Set();
    for (const ctrl of controllers) {
      for (const item of ctrl.items || []) {
        uniquePromptKeys.add(`${item.category || ""}\u001f${item.name || ""}`);
      }
    }
    const largestDataBytes = heavy ? detail.reduce((max, item) => Math.max(max, item.dataBytes || 0), 0) : null;
    const largestItemsBytes = heavy ? detail.reduce((max, item) => Math.max(max, item.itemsBytes || 0), 0) : null;
    const largest = heavy ? controllers.reduce((best, ctrl) => (
      (roughJsonBytes(ctrl.items) || 0) > (roughJsonBytes(best?.items) || 0) ? ctrl : best
    ), controllers[0] || null) : null;
    return {
      controllers: detail.length,
      uniqueLibrary: {
        prompts: uniquePromptKeys.size,
        dataBytesEstimate: largestDataBytes,
        itemsBytesEstimate: largestItemsBytes,
        sharedCacheBytesEstimate: heavy ? roughJsonBytes(promptLibraryCache) : null,
        sharedCacheActive: controllers.every((ctrl) => ctrl._sharedPromptLibraryVersion === promptLibraryCache),
        deferredText: heavy ? deferredPromptTextStats(largest?.items || []) : null,
        retainedItemText: heavy ? retainedPromptTextStats(largest?.items || []) : null,
      },
      totals: {
        mountedPromptCopies: detail.reduce((sum, item) => sum + item.items, 0),
        items: detail.reduce((sum, item) => sum + item.items, 0),
        dataBytes: detail.reduce((sum, item) => sum + (item.dataBytes || 0), 0),
        itemsBytes: detail.reduce((sum, item) => sum + (item.itemsBytes || 0), 0),
        cardCache: detail.reduce((sum, item) => sum + item.cardCache, 0),
        cardCacheImages: detail.reduce((sum, item) => sum + item.cardCacheImages, 0),
        visibleCards: detail.reduce((sum, item) => sum + item.visibleCards, 0),
        visibleImages: detail.reduce((sum, item) => sum + item.visibleImages, 0),
      },
      dom: {
        promptVaultNodes: document.querySelectorAll(".krc-pm").length,
        promptCards: document.querySelectorAll(".krc-pm .krc-lora-card").length,
        promptImages: document.querySelectorAll(".krc-pm .krc-lora-card img, .krc-pm .krc-info-thumb img").length,
      },
      detail,
    };
  };
  installKrcStatsAggregator();
}
