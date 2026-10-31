export function roughJsonBytes(value) {
  try {
    const text = JSON.stringify(value, (_key, item) => (
      item instanceof Map ? Array.from(item.entries()) : item
    ));
    return typeof Blob === "function" ? new Blob([text]).size : text.length;
  } catch {
    return null;
  }
}

export function domSummary(root, selector = "*") {
  if (!root?.querySelectorAll) {
    return { connected: false, elements: 0, inputs: 0, buttons: 0, selects: 0, textareas: 0 };
  }
  return {
    connected: !!root.isConnected,
    elements: root.querySelectorAll(selector).length,
    inputs: root.querySelectorAll("input").length,
    buttons: root.querySelectorAll("button").length,
    selects: root.querySelectorAll("select").length,
    textareas: root.querySelectorAll("textarea").length,
  };
}

export function imageStatsFromElements(elements = []) {
  const urls = new Set();
  let images = 0;
  let dataUrls = 0;
  let blobUrls = 0;
  let remoteUrls = 0;
  let srcChars = 0;
  let decodedBytesEstimate = 0;

  for (const img of elements) {
    if (typeof HTMLImageElement !== "undefined" && !(img instanceof HTMLImageElement)) continue;
    images += 1;
    const src = img.currentSrc || img.src || "";
    if (!src) continue;
    urls.add(src);
    srcChars += src.length;
    if (src.startsWith("data:")) {
      dataUrls += 1;
      const comma = src.indexOf(",");
      const payloadChars = comma >= 0 ? src.length - comma - 1 : src.length;
      decodedBytesEstimate += Math.round(payloadChars * 0.75);
    } else if (src.startsWith("blob:")) {
      blobUrls += 1;
    } else {
      remoteUrls += 1;
    }
  }

  return {
    images,
    uniqueUrls: urls.size,
    dataUrls,
    blobUrls,
    remoteUrls,
    srcChars,
    decodedBytesEstimate,
  };
}

export function imageStatsInCache(cache, { entryElement = (entry) => entry } = {}) {
  const elements = [];
  if (!cache) return imageStatsFromElements(elements);
  for (const entry of cache.values()) {
    const element = entryElement(entry);
    elements.push(...(element?.querySelectorAll?.("img") || []));
  }
  return imageStatsFromElements(elements);
}

export function fieldByteBreakdown(items = [], { limit = Infinity } = {}) {
  const fields = new Map();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const [key, value] of Object.entries(item)) {
      const current = fields.get(key) || { field: key, bytes: 0, present: 0 };
      current.bytes += roughJsonBytes(value) || 0;
      current.present += 1;
      fields.set(key, current);
    }
  }
  return Array.from(fields.values())
    .map((item) => ({
      ...item,
      avgBytes: item.present ? Math.round(item.bytes / item.present) : 0,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, limit);
}

export function deferredFieldStats(items = [], specs = []) {
  const out = {};
  for (const spec of specs) {
    out[spec.countKey] = 0;
    if (spec.charKey) out[spec.charKey] = 0;
  }
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    for (const spec of specs) {
      if (!item[spec.deferredKey]) continue;
      out[spec.countKey] += 1;
      if (spec.charKey) out[spec.charKey] += Number(item[spec.lengthKey]) || 0;
    }
  }
  return out;
}

function graphNodeSummary() {
  const nodes = window.app?.graph?._nodes || [];
  const byType = {};
  for (const node of nodes) {
    const type = node.comfyClass || node.type || "Unknown";
    byType[type] = (byType[type] || 0) + 1;
  }
  return {
    total: nodes.length,
    byType,
  };
}

function browserSummary() {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  return {
    userAgent: nav?.userAgent || "",
    platform: nav?.platform || "",
    language: nav?.language || "",
    hardwareConcurrency: nav?.hardwareConcurrency || null,
    deviceMemory: nav?.deviceMemory || null,
    viewport: typeof window !== "undefined" ? {
      width: window.innerWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio || 1,
    } : null,
  };
}

function summarizeLoraStats(stats) {
  const detail = stats?.panelsDetail || [];
  return {
    panels: stats?.panels || 0,
    surfaces: detail.reduce((out, item) => {
      const surface = item.surface || "unknown";
      out[surface] = (out[surface] || 0) + 1;
      return out;
    }, {}),
    library: stats?.libraryCache ? {
      loras: stats.libraryCache.loras || 0,
      folders: stats.libraryCache.folders || 0,
      metadataSnapshots: stats.libraryCache.metadataSnapshots || 0,
      roughBytes: stats.libraryCache.roughBytes || 0,
      deferredText: stats.libraryCache.deferredText || null,
      fieldBytesTop: stats.libraryCache.fieldBytesTop || null,
    } : null,
    presets: stats?.presetCache ? {
      presets: stats.presetCache.presets || 0,
      roughBytes: stats.presetCache.roughBytes || 0,
    } : null,
    dom: stats?.dom || null,
    panelCaches: {
      cardCache: detail.reduce((sum, item) => sum + (item.cardCache || 0), 0),
      cardCacheImages: detail.reduce((sum, item) => sum + (item.cardCacheImages || 0), 0),
      visibleCards: detail.reduce((sum, item) => sum + (item.visibleCards || 0), 0),
      visibleImages: detail.reduce((sum, item) => sum + (item.visibleImages || 0), 0),
    },
  };
}

function summarizePromptVaultStats(stats) {
  const detail = Array.isArray(stats?.detail) ? stats.detail : [];
  const largestCategoryCount = detail.reduce((max, item) => Math.max(max, item.categories || 0), 0);
  return {
    nodes: stats?.controllers || stats?.dom?.promptVaultNodes || 0,
    library: stats?.uniqueLibrary ? {
      categories: largestCategoryCount,
      prompts: stats.uniqueLibrary.prompts || 0,
      dataBytesEstimate: stats.uniqueLibrary.dataBytesEstimate || 0,
      itemsBytesEstimate: stats.uniqueLibrary.itemsBytesEstimate || 0,
      sharedCacheActive: !!stats.uniqueLibrary.sharedCacheActive,
      deferredText: stats.uniqueLibrary.deferredText || null,
      retainedItemText: stats.uniqueLibrary.retainedItemText || null,
    } : null,
    totals: stats?.totals || null,
    dom: stats?.dom || null,
    panelCaches: {
      detailCache: detail.reduce((sum, item) => sum + (item.detailCache || 0), 0),
      detailCacheTextRecords: detail.reduce((sum, item) => sum + (item.detailCacheText?.records || 0), 0),
      detailCacheTextChars: detail.reduce((sum, item) => sum + (item.detailCacheText?.chars || 0), 0),
    },
  };
}

function summarizeSimpleStats(stats) {
  if (!stats || typeof stats !== "object") return null;
  return {
    totals: stats.totals || null,
    dom: stats.dom || null,
    nodes: stats.nodes ?? stats.resizers ?? stats.mainNodes ?? null,
  };
}

const DEFAULT_SAMPLE_INTERVAL_MS = 60_000;
const DEFAULT_MAX_SAMPLES = 120;

let samplerTimer = null;
let samplerStartedAt = null;
let samplerSamples = [];

function performanceMemorySummary() {
  const memory = typeof performance !== "undefined" ? performance.memory : null;
  if (!memory) return null;
  return {
    usedJSHeapSize: memory.usedJSHeapSize ?? null,
    totalJSHeapSize: memory.totalJSHeapSize ?? null,
    jsHeapSizeLimit: memory.jsHeapSizeLimit ?? null,
  };
}

export function krcDiagnosticReport({ heavy = true } = {}) {
  installKrcStatsAggregator();
  const memoryStats = window.krcKrcMemoryStats?.({ heavy }) || {};
  return {
    schema: "krc-diagnostics/v1",
    generatedAt: new Date().toISOString(),
    browser: browserSummary(),
    performanceMemory: performanceMemorySummary(),
    graph: graphNodeSummary(),
    diagnostics: {
      loraLoadout: summarizeLoraStats(memoryStats.loraLoadout),
      promptVault: summarizePromptVaultStats(memoryStats.promptVault),
      resizer: summarizeSimpleStats(memoryStats.resizer),
      wordBank: summarizeSimpleStats(memoryStats.wordBank),
      configSwitcher: summarizeSimpleStats(memoryStats.configSwitcher),
    },
    dom: domSummary(document),
    notes: [
      "Privacy-safe summary: prompt bodies, LoRA text metadata bodies, and full local paths are excluded.",
      "Detailed console-only hooks remain available as krcKrcMemoryStats() for local debugging.",
    ],
  };
}

export function downloadKrcDiagnostics({ heavy = true, includeSamples = true } = {}) {
  const report = krcDiagnosticReport({ heavy });
  if (includeSamples && samplerSamples.length) {
    report.idleSamples = {
      startedAt: samplerStartedAt,
      samples: samplerSamples.slice(),
    };
  }
  const text = JSON.stringify(report, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `krc_diagnostics_${stamp}.json`;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 0);
  return report;
}

export function krcMemorySample() {
  const report = krcDiagnosticReport({ heavy: false });
  return {
    generatedAt: report.generatedAt,
    performanceMemory: report.performanceMemory,
    graph: report.graph,
    diagnostics: report.diagnostics,
    dom: report.dom,
  };
}

export function startKrcMemorySampler({ intervalMs = DEFAULT_SAMPLE_INTERVAL_MS, maxSamples = DEFAULT_MAX_SAMPLES } = {}) {
  if (typeof window === "undefined") return null;
  stopKrcMemorySampler();
  const safeInterval = Math.max(10_000, Number(intervalMs) || DEFAULT_SAMPLE_INTERVAL_MS);
  const safeMaxSamples = Math.max(2, Math.min(720, Number(maxSamples) || DEFAULT_MAX_SAMPLES));
  samplerStartedAt = new Date().toISOString();
  samplerSamples = [krcMemorySample()];
  samplerTimer = window.setInterval(() => {
    samplerSamples.push(krcMemorySample());
    if (samplerSamples.length > safeMaxSamples) {
      samplerSamples.splice(0, samplerSamples.length - safeMaxSamples);
    }
  }, safeInterval);
  return {
    startedAt: samplerStartedAt,
    intervalMs: safeInterval,
    maxSamples: safeMaxSamples,
    samples: samplerSamples.length,
  };
}

export function stopKrcMemorySampler() {
  if (typeof window !== "undefined" && samplerTimer) {
    window.clearInterval(samplerTimer);
  }
  samplerTimer = null;
  return {
    startedAt: samplerStartedAt,
    samples: samplerSamples.length,
  };
}

export function krcMemorySamplerStatus() {
  return {
    running: !!samplerTimer,
    startedAt: samplerStartedAt,
    samples: samplerSamples.length,
    latest: samplerSamples[samplerSamples.length - 1] || null,
  };
}

export function downloadKrcMemorySamples() {
  const payload = {
    schema: "krc-idle-memory-samples/v1",
    generatedAt: new Date().toISOString(),
    startedAt: samplerStartedAt,
    samples: samplerSamples.slice(),
  };
  const text = JSON.stringify(payload, null, 2);
  const blob = new Blob([text], { type: "application/json" });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `krc_idle_memory_samples_${stamp}.json`;
  document.body.append(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(link.href);
    link.remove();
  }, 0);
  return payload;
}

export function installKrcStatsAggregator() {
  if (typeof window === "undefined") return;
  window.krcKrcMemoryStats = (options = {}) => ({
    loraLoadout: window.krcLoraMemoryStats?.(options) || null,
    promptVault: window.krcPromptVaultMemoryStats?.(options) || null,
    resizer: window.krcResizerMemoryStats?.(options) || null,
    wordBank: window.krcWordBankMemoryStats?.(options) || null,
    configSwitcher: window.krcConfigSwitcherMemoryStats?.(options) || null,
  });
  window.krcDiagnosticReport = krcDiagnosticReport;
  window.krcExportDiagnostics = downloadKrcDiagnostics;
  window.krcMemorySample = krcMemorySample;
  window.krcStartMemorySampler = startKrcMemorySampler;
  window.krcStopMemorySampler = stopKrcMemorySampler;
  window.krcMemorySamplerStatus = krcMemorySamplerStatus;
  window.krcExportMemorySamples = downloadKrcMemorySamples;
}
