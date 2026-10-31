// KRC Word Bank — memory stats hook for mounted WordBank DOM nodes.

import { domSummary, installKrcStatsAggregator, roughJsonBytes } from "../shared/memory_stats.js";
import { loadState } from "./state.js";

const mountedWordBanks = new Set();

function connectedWordBanks() {
  const nodes = Array.from(mountedWordBanks).filter((node) => node?.__wbWrap?.isConnected);
  for (const node of mountedWordBanks) {
    if (!node?.__wbWrap?.isConnected) mountedWordBanks.delete(node);
  }
  return nodes;
}

export function registerWordBankNode(node) {
  mountedWordBanks.add(node);
}

export function unregisterWordBankNode(node) {
  mountedWordBanks.delete(node);
}

export function installWordBankStatsHook() {
  if (typeof window === "undefined" || window.krcWordBankMemoryStats) return;
  window.krcWordBankMemoryStats = () => {
    const nodes = connectedWordBanks();
    const detail = nodes.map((node) => {
      const state = loadState(node);
      const stats = node.__wbStats || {};
      const banks = typeof stats.banks === "function" ? stats.banks() : [];
      const presets = Array.isArray(stats.presetCache) ? stats.presetCache : [];
      const rows = typeof stats.rowsFromDOM === "function" ? stats.rowsFromDOM() : state.rows || [];
      return {
        nodeId: node.id,
        rows: rows.length,
        stateRows: state.rows?.length || 0,
        banks: banks.length,
        presets: presets.length,
        stateBytes: roughJsonBytes(state),
        rowBytes: roughJsonBytes(rows),
        bankNamesBytes: roughJsonBytes(banks),
        presetCacheBytes: roughJsonBytes(presets),
        activePreset: state.activePreset || "",
        autoSeed: !!state.autoSeed,
        dom: {
          ...domSummary(node.__wbWrap),
          renderedRows: node.__wbWrap?.querySelectorAll?.(".wb-row")?.length || 0,
        },
      };
    });
    return {
      nodes: detail.length,
      totals: {
        rows: detail.reduce((sum, item) => sum + item.rows, 0),
        banks: detail.reduce((sum, item) => sum + item.banks, 0),
        presets: detail.reduce((sum, item) => sum + item.presets, 0),
        stateBytes: detail.reduce((sum, item) => sum + (item.stateBytes || 0), 0),
        rowBytes: detail.reduce((sum, item) => sum + (item.rowBytes || 0), 0),
        bankNamesBytes: detail.reduce((sum, item) => sum + (item.bankNamesBytes || 0), 0),
        presetCacheBytes: detail.reduce((sum, item) => sum + (item.presetCacheBytes || 0), 0),
        domElements: detail.reduce((sum, item) => sum + (item.dom?.elements || 0), 0),
      },
      dom: {
        wordBankNodes: document.querySelectorAll(".wb-wrap").length,
        wordBankRows: document.querySelectorAll(".wb-wrap .wb-row").length,
      },
      detail,
    };
  };
  installKrcStatsAggregator();
}
