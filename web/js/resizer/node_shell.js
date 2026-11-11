import { bindNodeShellSizeClamp, classicNodeHeight } from "./krc.js";
import { FIXED_DOM_H, FIXED_DOM_W, FIXED_NODE_W, NODE2_CHROME_W, NODE2_CHROME_H, MAX_SIZE_FACTOR } from "./constants.js";

const MANAGED_WIDGET_NAMES = new Set([
    "crop_state",
    "pad_color",
    "custom_pad_color",
    "frame_select",
    "passthrough",
]);

export function getManagedWidgets(node) {
    return {
        cropState: node.widgets?.find(w => w.name === "crop_state"),
        padColor: node.widgets?.find(w => w.name === "pad_color"),
        customPadColor: node.widgets?.find(w => w.name === "custom_pad_color"),
        frameSelect: node.widgets?.find(w => w.name === "frame_select"),
        passthrough: node.widgets?.find(w => w.name === "passthrough"),
    };
}

export function removeManagedInputs(node) {
    if (!node.inputs) return;
    for (let i = node.inputs.length - 1; i >= 0; i--) {
        if (MANAGED_WIDGET_NAMES.has(node.inputs[i].name)) node.removeInput(i);
    }
}

export function hideManagedWidgets(node, domWidget) {
    if (!node.widgets) return;
    const toHide = node.widgets.filter(w => MANAGED_WIDGET_NAMES.has(w.name));
    node.widgets = [
        domWidget,
        ...node.widgets.filter(w => w !== domWidget && !MANAGED_WIDGET_NAMES.has(w.name)),
    ];
    for (const w of toHide) {
        node.widgets.push(w);
        w.computeSize = () => [0, -4];
        w.type = "hidden";
        w.hidden = true;
    }
}

// A detached DOM may not reveal its renderer until the next frame. Keep restored
// sizes within the generous pending bounds, then clamp to the actual renderer.
// The classic canvas height comes from NodePack's shared edge under a node's UI
// (classicNodeHeight, API 2.9): the frontend's own slot rows and widget margin, twice.
export function resizerSizeBounds(root, node) {
    const shell = root.closest?.(".lg-node");
    const node2 = Boolean(shell);
    const widget = node?.widgets?.find(entry => entry.element === root);
    const min = node2 ? [FIXED_DOM_W + NODE2_CHROME_W, FIXED_DOM_H + NODE2_CHROME_H]
        : [FIXED_NODE_W, classicNodeHeight(node, widget, FIXED_DOM_H)];
    const maxBase = !root.isConnected && !node2
        ? [FIXED_DOM_W + NODE2_CHROME_W, FIXED_DOM_H + NODE2_CHROME_H] : min;
    return { min, max: maxBase.map(value => value * MAX_SIZE_FACTOR), shell,
        chrome: node2 ? [NODE2_CHROME_W, NODE2_CHROME_H] : [FIXED_NODE_W - FIXED_DOM_W, min[1] - FIXED_DOM_H] };
}

export function clampResizerSize(size, root, node) {
    const { min, max } = resizerSizeBounds(root, node);
    return min.map((value, index) => Math.min(max[index], Math.max(value, Number.isFinite(size?.[index]) ? size[index] : value)));
}

function stampSize(node, dom, size) {
    const { min, max, chrome, shell } = resizerSizeBounds(dom.root, node);
    node.min_size = min;
    node.max_size = max;
    const values = {
        "--krc-rz-dom-w": `${Math.max(FIXED_DOM_W, size[0] - chrome[0])}px`,
        "--krc-rz-dom-h": `${Math.max(FIXED_DOM_H, size[1] - chrome[1])}px`,
        "--krc-rz-min-w": `${min[0]}px`, "--krc-rz-min-h": `${min[1]}px`,
        "--krc-rz-max-w": `${max[0]}px`, "--krc-rz-max-h": `${max[1]}px`,
    };
    for (const target of [dom.root, shell].filter(Boolean)) {
        for (const [key, value] of Object.entries(values)) {
            if (target.style.getPropertyValue(key) !== value) target.style.setProperty(key, value);
        }
    }
    if (shell && !node._resizerShellClamp) node._resizerShellClamp = bindNodeShellSizeClamp(dom.root, node, { maxSize: max });
}

export function createSizeEnforcer(node, dom) {
    return () => {
        const size = clampResizerSize(node.size, dom.root, node);
        stampSize(node, dom, size);
        if (node.size?.[0] !== size[0] || node.size?.[1] !== size[1]) node.setSize(size);
        node.size = size;
    };
}

export function configureResizableDomWidget(domWidget, node, dom) {
    // Report the content minimum, not its current height: otherwise each enlarged
    // size becomes the next minimum and the native resize handle cannot shrink.
    domWidget.computeSize = () => [FIXED_DOM_W, FIXED_DOM_H];
    domWidget.options ||= {};
    domWidget.options.getMinHeight = () => FIXED_DOM_H;
    domWidget.options.getMaxHeight = () => {
        const { max, chrome } = resizerSizeBounds(dom.root, node);
        return max[1] - chrome[1];
    };
    const original = node.onResize;
    node.onResize = function(size) {
        const result = original?.apply(this, arguments);
        const bounded = clampResizerSize(size, dom.root, this);
        size[0] = bounded[0]; size[1] = bounded[1];
        this.size = bounded;
        stampSize(this, dom, bounded);
        return result;
    };
}
