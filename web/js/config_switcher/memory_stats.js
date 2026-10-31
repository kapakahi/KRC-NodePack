import { app } from "../../../scripts/app.js";
import { domSummary, installKrcStatsAggregator, roughJsonBytes } from "../shared/memory_stats.js";

const mountedConfigSwitchers = new Set();
const mountedConfigSwitcherLinks = new Set();

function widgetValue(node, name) {
    return node?.widgets?.find((widget) => widget.name === name)?.value;
}

function connectedNodes(set, isConnected) {
    const nodes = Array.from(set).filter(isConnected);
    for (const node of set) {
        if (!isConnected(node)) set.delete(node);
    }
    return nodes;
}

function registerOnce(node, set) {
    if (!node) return;
    set.add(node);
    if (node.__krcConfigStatsCleanup) return;
    const prevOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        mountedConfigSwitchers.delete(node);
        mountedConfigSwitcherLinks.delete(node);
        node.__krcConfigStatsCleanup = null;
        return prevOnRemoved ? prevOnRemoved.apply(this, arguments) : undefined;
    };
    node.__krcConfigStatsCleanup = true;
}

function mainDetail(node) {
    const dataRaw = String(widgetValue(node, "config_data") || "");
    return {
        nodeId: node.id,
        kind: "config",
        fields: node._fields?.length || 0,
        configs: Object.keys(node._configs || {}).length,
        outputs: node.outputs?.length || 0,
        dataWidgetBytes: roughJsonBytes(dataRaw),
        fieldsBytes: roughJsonBytes(node._fields || []),
        configsBytes: roughJsonBytes(node._configs || {}),
        activeConfig: String(widgetValue(node, "active_config") || ""),
        editMode: !!node._configEditMode,
        presetId: node._configPresetId || "",
        presetSignatureBytes: roughJsonBytes(node._configPresetGlobalSignature || ""),
        dom: domSummary(node._ddp?.wrap),
    };
}

function linkDetail(node) {
    const dataRaw = String(widgetValue(node, "link_data") || "");
    return {
        nodeId: node.id,
        kind: "link",
        outputs: node.outputs?.length || 0,
        dataWidgetBytes: roughJsonBytes(dataRaw),
        dom: null,
    };
}

export function registerConfigSwitcherNode(node) {
    registerOnce(node, mountedConfigSwitchers);
}

export function registerConfigSwitcherLinkNode(node) {
    registerOnce(node, mountedConfigSwitcherLinks);
}

export function installConfigSwitcherStatsHook() {
    if (typeof window === "undefined" || window.krcConfigSwitcherMemoryStats) return;
    window.krcConfigSwitcherMemoryStats = () => {
        const main = connectedNodes(mountedConfigSwitchers, (node) => node?._ddp?.wrap?.isConnected);
        const link = connectedNodes(mountedConfigSwitcherLinks, (node) => app.graph?._nodes?.includes(node));
        const detail = [...main.map(mainDetail), ...link.map(linkDetail)];
        return {
            nodes: detail.length,
            mainNodes: main.length,
            linkNodes: link.length,
            totals: {
                fields: detail.reduce((sum, item) => sum + (item.fields || 0), 0),
                configs: detail.reduce((sum, item) => sum + (item.configs || 0), 0),
                dataWidgetBytes: detail.reduce((sum, item) => sum + (item.dataWidgetBytes || 0), 0),
                fieldsBytes: detail.reduce((sum, item) => sum + (item.fieldsBytes || 0), 0),
                configsBytes: detail.reduce((sum, item) => sum + (item.configsBytes || 0), 0),
                domElements: detail.reduce((sum, item) => sum + (item.dom?.elements || 0), 0),
            },
            dom: {
                mainNodes: document.querySelectorAll(".ddp-wrap").length,
                inputs: document.querySelectorAll(".ddp-wrap input").length,
            },
            detail,
        };
    };
    installKrcStatsAggregator();
}
