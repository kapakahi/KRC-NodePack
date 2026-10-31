import { app } from "../../../scripts/app.js";
import { getWidget, applyNodeColors, hideWidget } from "./helpers.js";
import * as memoryStats from "./memory_stats.js";
import { captureTargets, dynamicComboTargets, planCapture, targetInputOptions, targetLabel } from "./target_options.js";
import { showToast } from "../shared/toast.js";
import {
    findParentSubgraphNode as findParentSubgraphNodeIn,
    getGraphLink,
    getGraphNodeById,
    graphNodes,
    linkIdsForOutput,
    nodeClassName,
} from "../shared/graph_walk.js";

const NODE_NAME = "KRC Config Switcher Link";
const NODE_NAMES = new Set([NODE_NAME]);
const SWITCHER_NODE_NAMES = new Set(["KRC Config Switcher"]);
const DATA_WIDGET = "link_data";
const SWITCHER_DATA_WIDGET = "config_data";
const UPDATE_WIDGET = "Update links";
const MAX_OUTPUTS = 30;
const MIN_W = 280;
// "combo" is the saved option picker (legacy token "string"); "string" is the new
// raw-text type. Both recognized here (the Link node has no add-field menu).
const FIELD_TYPES = ["combo", "string", "number", "boolean", "model", "prompt", "seed", "dynamic_combo", "note", "section"];
// A NOTE is a notes box: never a Link output.
// NOTES and SECTION/DIVIDER rows output nothing.
const isOutputField = (field) => field.id && field.type !== "note" && field.type !== "section";
const NUMBER_OUTPUT_FORMATS = new Set(["auto", "integer", "float"]);

// Mirror of config.js migrateFieldType: legacy "string" with options is a Combo;
// a bare "string" is the new raw STRING type.
function migrateFieldType(rawType, hasOptions) {
    if (rawType === "string") return hasOptions ? "combo" : "string";
    return FIELD_TYPES.includes(rawType) ? rawType : "combo";
}

function normalizeField(field) {
    const hasOptions = Array.isArray(field?.options) && field.options.some((item) => String(item).trim());
    const type = migrateFieldType(field?.type, hasOptions);
    const numberOutput = NUMBER_OUTPUT_FORMATS.has(field?.numberOutput) ? field.numberOutput : "auto";
    return {
        id: String(field?.id || ""),
        name: String(field?.name || ""),
        type,
        options: type === "combo" && Array.isArray(field?.options) ? field.options.map(String) : [],
        numberOutput: type === "number" ? numberOutput : "",
        modelType: type === "model" ? String(field?.modelType || "") : "",
        modelOptions: type === "model" && Array.isArray(field?.modelOptions) ? field.modelOptions : [],
        promptOptions: type === "prompt" && Array.isArray(field?.promptOptions) ? field.promptOptions : [],
    };
}

// Keep every dynamic Link output wildcard. The Python node still emits disciplined
// typed values via coerce_typed_value, but the graph socket stays permissive so
// LiteGraph does not reject or half-preserve links during output rebuilds.
function socketTypeForField() {
    return "*";
}

// The canvas renders an output slot's label from `label` / `localized_name`, not `name`
// — and ComfyUI fills those from the backend RETURN_NAMES (out_0, out_1, …) on load. So
// set all three to the Config Switcher parameter name; otherwise the correct `name` is
// stored but out_# still shows after a reload (the label was never overwritten).
function setOutputLabel(output, field, index) {
    if (!output) return;
    const label = field.name || `out_${index}`;
    output.name = label;
    output.label = label;
    output.localized_name = label;
}

function decodeFields(raw) {
    if (Array.isArray(raw)) return raw.map(normalizeField).filter(isOutputField);
    try {
        const decoded = JSON.parse(raw || "[]");
        return Array.isArray(decoded) ? decoded.map(normalizeField).filter(isOutputField) : [];
    } catch (e) {
        return [];
    }
}

function readLinkFields(node) {
    return decodeFields(getWidget(node, DATA_WIDGET)?.value);
}

function writeLinkFields(node, fields) {
    const widget = getWidget(node, DATA_WIDGET);
    if (widget) widget.value = JSON.stringify(fields.slice(0, MAX_OUTPUTS).map(normalizeField));
    node.setDirtyCanvas(true, true);
}

function removeInputLinkId(input, linkId) {
    if (!input || linkId == null) return false;
    const sameId = (a, b) => a === b || String(a) === String(b);
    let changed = false;
    if (sameId(input.link, linkId)) {
        input.link = null;
        changed = true;
    }
    if (Array.isArray(input.linkIds) && input.linkIds.some((id) => sameId(id, linkId))) {
        input.linkIds = input.linkIds.filter((id) => !sameId(id, linkId));
        changed = true;
    }
    return changed;
}

function scrubMissingInputLinks(graph, node = null, slot = null) {
    if (!graph) return false;
    const nodes = node ? [node] : graphNodes(graph);
    let changed = false;
    for (const candidate of nodes) {
        const inputs = candidate?.inputs || [];
        inputs.forEach((input, index) => {
            if (slot != null && index !== slot) return;
            if (input?.link != null && !getGraphLink(graph, input.link)) {
                input.link = null;
                changed = true;
            }
            if (Array.isArray(input?.linkIds)) {
                const kept = input.linkIds.filter((id) => getGraphLink(graph, id));
                if (kept.length !== input.linkIds.length) {
                    input.linkIds = kept;
                    changed = true;
                }
            }
        });
    }
    return changed;
}

function clearInputForGraphLink(graph, linkId) {
    if (!graph || linkId == null) return false;
    let changed = false;
    const link = getGraphLink(graph, linkId);
    const target = link ? getGraphNodeById(graph, link.target_id) : null;
    if (target?.inputs?.[link.target_slot]) {
        changed = removeInputLinkId(target.inputs[link.target_slot], linkId) || changed;
    }
    for (const graphNode of graphNodes(graph)) {
        for (const input of graphNode?.inputs || []) {
            changed = removeInputLinkId(input, linkId) || changed;
        }
    }
    return changed;
}

function disconnectOutputForRebuild(node, index) {
    const graph = nodeGraph(node);
    const linkIds = linkIdsForOutput(node.outputs?.[index]);
    for (const linkId of linkIds) clearInputForGraphLink(graph, linkId);
    try {
        node.disconnectOutput?.(index);
    } catch (e) {
        console.warn("[KRC Config Switcher Link] Could not disconnect output before rebuild", e);
    }
    for (const linkId of linkIds) clearInputForGraphLink(graph, linkId);
}

function nodeGraph(node) {
    return node?.graph || app.canvas?.graph || app.graph;
}

// The subgraph instance node that owns `graph` (shared/graph_walk.js), in this workflow.
function findParentSubgraphNode(graph) {
    return findParentSubgraphNodeIn(graph, app.graph);
}

function isSwitcherNode(node) {
    return SWITCHER_NODE_NAMES.has(nodeClassName(node));
}

function inputSlotByName(node, name) {
    return node?.inputs?.findIndex((input) => input.name === name) ?? -1;
}

// Resolve a Config Switcher feeding this Link from OUTSIDE the subgraph: the link
// enters through a subgraph boundary input, so trace it out to the instance node's
// matching input and follow that link to its origin (recursing for nested subgraphs).
// Robust to the boundary sentinel: matches the boundary input by link id, not by a
// hard-coded origin_id like "-10".
function connectedSwitcherThroughSubgraphInput(graph, graphLink) {
    if (!graphLink) return null;
    const inputs = graph?.inputs || graph?._inputs || [];
    const boundaryIndex = inputs.findIndex((input) =>
        input?.linkIds?.includes?.(graphLink.id) || input?.link === graphLink.id);
    if (boundaryIndex < 0) return null;
    const boundaryInput = inputs[boundaryIndex];

    const parentNode = findParentSubgraphNode(graph);
    if (!parentNode) return null;

    let parentSlot = parentNode.inputs?.findIndex((input) => input?.name === boundaryInput?.name) ?? -1;
    if (parentSlot < 0) parentSlot = boundaryIndex;
    const parentInput = parentNode.inputs?.[parentSlot];
    const parentGraph = nodeGraph(parentNode);
    const parentLink = parentInput?.link != null ? getGraphLink(parentGraph, parentInput.link) : null;
    if (!parentLink) return null;

    const origin = getGraphNodeById(parentGraph, parentLink.origin_id);
    if (isSwitcherNode(origin)) return origin;
    // Nested subgraphs: the parent link may itself originate from a boundary input.
    if (!origin) return connectedSwitcherThroughSubgraphInput(parentGraph, parentLink);
    return null;
}

function connectedSwitcherNode(node) {
    const graph = nodeGraph(node);
    const inputIndex = inputSlotByName(node, "config");
    if (inputIndex < 0) return null;
    const linkId = node.inputs?.[inputIndex]?.link;
    const graphLink = linkId != null ? getGraphLink(graph, linkId) : null;
    const origin = graphLink ? getGraphNodeById(graph, graphLink.origin_id) : null;
    if (isSwitcherNode(origin)) return origin;
    return connectedSwitcherThroughSubgraphInput(graph, graphLink);
}

function fieldsFromSwitcher(node) {
    const widget = getWidget(node, SWITCHER_DATA_WIDGET);
    if (!widget) return [];
    try {
        const data = JSON.parse(widget.value || "{}");
        const fields = Array.isArray(data.fields) ? data.fields : [];
        return fields.slice(0, MAX_OUTPUTS).map(normalizeField).filter(isOutputField);
    } catch (e) {
        return [];
    }
}

function captureLinksByFieldId(node) {
    const graph = nodeGraph(node);
    const fields = readLinkFields(node);
    const linksById = new Map();
    fields.forEach((field, index) => {
        const links = node.outputs?.[index]?.links || [];
        const targets = links
            .map((linkId) => getGraphLink(graph, linkId))
            .filter(Boolean)
            .map((link) => ({
                node: getGraphNodeById(graph, link.target_id),
                slot: link.target_slot,
            }))
            .filter((target) => target.node && target.slot != null);
        if (targets.length) linksById.set(`${field.id}:${field.type}`, targets);
    });
    return linksById;
}

function reconnectLinks(node, linksById, fields) {
    const graph = nodeGraph(node);
    fields.forEach((field, index) => {
        const targets = linksById.get(`${field.id}:${field.type}`) || [];
        for (const target of targets) {
            try {
                scrubMissingInputLinks(graph, target.node, target.slot);
                node.connect(index, target.node, target.slot);
            } catch (e) {
                console.warn("[KRC Config Switcher Link] Could not restore graph link", e);
            }
        }
    });
}

function outputHasLinks(output) {
    return linkIdsForOutput(output).length > 0;
}

function canPatchOutputsInPlace(node, fields) {
    if (!Array.isArray(node.outputs) || node.outputs.length < fields.length) return false;
    if (node.outputs.slice(fields.length).some(outputHasLinks)) return false;
    return fields.every((field, index) => {
        const output = node.outputs[index];
        if (!output) return false;
        const savedFieldId = output.krcFieldId || output._krcFieldId || "";
        const expectedName = field.name || `out_${index}`;
        return !savedFieldId || savedFieldId === field.id || output.name === expectedName;
    });
}

function patchOutputsInPlace(node, fields) {
    fields.forEach((field, index) => {
        const output = node.outputs?.[index];
        if (!output) return;
        setOutputLabel(output, field, index);
        output.type = socketTypeForField(field);
        output.krcFieldId = field.id;
    });
    while ((node.outputs?.length || 0) > fields.length && !outputHasLinks(node.outputs[node.outputs.length - 1])) {
        node.removeOutput(node.outputs.length - 1);
    }
    writeLinkFields(node, fields);
    node.setDirtyCanvas(true, true);
}

function syncOutputs(node, fields, { preserveLinks = false } = {}) {
    fields = fields.slice(0, MAX_OUTPUTS).map(normalizeField).filter(isOutputField);
    if (!fields.length && preserveLinks && (node.outputs || []).some(outputHasLinks)) {
        console.warn("[KRC Config Switcher Link] Refusing to remove linked outputs while link_data is empty; reload/configure may still be in progress.");
        return;
    }
    if (canPatchOutputsInPlace(node, fields)) {
        patchOutputsInPlace(node, fields);
        return;
    }
    const linksById = preserveLinks ? captureLinksByFieldId(node) : null;

    while (node.outputs?.length) {
        disconnectOutputForRebuild(node, node.outputs.length - 1);
        node.removeOutput(node.outputs.length - 1);
    }
    fields.forEach((field, index) => {
        node.addOutput(field.name || `out_${index}`, socketTypeForField(field));
        const output = node.outputs[index];
        output.krcFieldId = field.id;
        setOutputLabel(output, field, index);
    });
    writeLinkFields(node, fields);
    if (linksById) reconnectLinks(node, linksById, fields);
    scrubMissingInputLinks(nodeGraph(node));
}

function fitNativeNode(node) {
    requestAnimationFrame(() => {
        const width = Math.max(node.size?.[0] ?? MIN_W, MIN_W);
        const computed = node.computeSize?.();
        const height = Math.max(computed?.[1] ?? node.size?.[1] ?? 80, 80);
        node.min_size = [MIN_W, height];
        node.setSize([width, height]);
        node.setDirtyCanvas(true, true);
    });
}

// One-line console breadcrumb when "Update links" can't resolve a Config Switcher
// (the silent no-op was the trap behind the copy-paste-a-dupe workaround).
function warnNoSwitcher(node) {
    const idx = inputSlotByName(node, "config");
    const hasLink = idx >= 0 && node.inputs?.[idx]?.link != null;
    const label = `#${node.id}${node.title ? ` "${node.title}"` : ""}`;
    console.warn(hasLink
        ? `[KRC Config Switcher Link] ${label}: "Update links" couldn't resolve the connected Config Switcher`
        : `[KRC Config Switcher Link] ${label}: No Config Switcher connected to the "config" input`);
}

// What a Capture would do to `field` of `switcherNode` (CS_COMBO_CAPTURE_GAMEPLAN.md, and
// converting to / from a DYNAMIC COMBO: CS_DYNAMIC_COMBO_GAMEPLAN.md): the inputs it feeds
// through this workflow's CS Links, read and planned (planCapture). -> the plan, plus
// `targets` (how many inputs were found).
export function planFieldCapture(switcherNode, field, cap) {
    const targets = captureTargets(switcherNode, field.id, { root: app.graph, switcherOf: connectedSwitcherNode });
    const results = targets.map((target) => ({ label: targetLabel(target), ...targetInputOptions(target) }));
    return { ...planCapture(field, results, { cap }), targets: targets.length };
}

// A DynamicCombo input (e.g. Model Sparse Attention's method) needs an option plus its
// settings, which only a DYNAMIC COMBO parameter sends: point the user at Capture
// (CS_DYNAMIC_COMBO_GAMEPLAN.md D13). The toast's button opens the parameter's Saved
// Values popover (its + in edit mode), where Capture converts it. Nothing converts on its own.
function warnDynamicComboTargets(node, index) {
    const labels = dynamicComboTargets(node, index, { root: app.graph });
    if (!labels.length) return;
    const fieldId = readLinkFields(node)[index]?.id;
    const switcher = connectedSwitcherNode(node);
    const field = switcher?._fields?.find((item) => item.id === fieldId);
    if (field?.type === "dynamic_combo") return;
    const message = `${labels.join(", ")} needs its settings`;
    console.warn(`[KRC Config Switcher Link] ${message.replace(/\u203a/g, ">")}; capture it on the Config Switcher`);
    showToast(`${message}. Capture it on the Config Switcher`, {
        duration: 8000,
        action: field && {
            label: "Capture",
            onClick: () => {
                const button = [...(switcher._ddp?.fields?.querySelectorAll(".ddp-string-add[data-field-id]") || [])]
                    .find((item) => item.dataset.fieldId === String(field.id));
                if (button && !button.disabled) button.click();
                else showToast("Turn on the Config Switcher's edit mode, then press + and Capture", { duration: 5000 });
            },
        },
    });
}

function updateLinks(node) {
    const source = connectedSwitcherNode(node);
    if (!source) {
        warnNoSwitcher(node);
        fitNativeNode(node);
        return;
    }
    syncOutputs(node, fieldsFromSwitcher(source), { preserveLinks: true });
    fitNativeNode(node);
}

function ensureUpdateWidget(node) {
    if (getWidget(node, UPDATE_WIDGET)) return;
    const widget = node.addWidget("button", UPDATE_WIDGET, null, () => updateLinks(node), {
        serialize: false,
    });
    widget.serialize = false;
    widget.tooltip = "Match outputs to the connected Config Switcher parameters";
}

app.registerExtension({
    name: "KRC.ConfigSwitcher.Link",
    setup() {
        memoryStats.installConfigSwitcherStatsHook?.();
    },
    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name)) return;

        const init = function () {
            applyNodeColors(this);
            hideWidget(getWidget(this, DATA_WIDGET));
            ensureUpdateWidget(this);
        };

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._krcLinkConfigured = false;
            init.call(this);
            memoryStats.registerConfigSwitcherLinkNode?.(this);
            requestAnimationFrame(() => {
                if (this._krcLinkConfigured) return;
                syncOutputs(this, readLinkFields(this), { preserveLinks: true });
                fitNativeNode(this);
            });
            fitNativeNode(this);
        };

        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            this._krcLinkConfigured = true;
            init.call(this);
            syncOutputs(this, readLinkFields(this), { preserveLinks: true });
            // Re-apply names on the next frame. During a graph load ComfyUI relabels the
            // node's dynamic outputs back to the backend RETURN_NAMES (out_0, out_1, …)
            // AFTER onConfigure, clobbering the field names we just set. The deferred pass
            // patches them in place from the persisted link_data (link-safe, idempotent) so
            // the real names win. Without it, outputs revert to out_# on every reload.
            requestAnimationFrame(() => {
                syncOutputs(this, readLinkFields(this), { preserveLinks: true });
                fitNativeNode(this);
            });
            fitNativeNode(this);
        };

        const onConnectionsChange = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function (type, index, connected) {
            onConnectionsChange?.apply(this, arguments);
            fitNativeNode(this);
            // 2 = LiteGraph.OUTPUT. A new output link only (not a workflow load).
            if (type === 2 && connected && !app.configuringGraph) warnDynamicComboTargets(this, index);
        };

        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            size[0] = Math.max(size[0], MIN_W);
            size[1] = Math.max(size[1], 80);
            return onResize?.apply(this, arguments);
        };
    },
});
