import { el as baseEl, installCanvasDragSelectionGuard, stopCanvasWheel } from "../shared/dom.js";
import { applyNodeCanvasColors } from "../shared/node_palette.js";
import { ensureStylesheet } from "../shared/stylesheets.js";

const STYLE_ID = "krc-config-switcher-style";
const STYLE_VERSION = "1.0.99-section-tint-shared-1669";

// Inject the ConfigSwitcher stylesheet once and return a promise that resolves when
// it has actually loaded. Callers re-fit node height on resolve so the initial
// scrollHeight measurement isn't taken against unstyled (taller) content on a
// cold refresh, which would leave the node over-tall until manually resized.
let _stylesReady = null;
export function ensureConfigSwitcherStyles() {
    if (_stylesReady) return _stylesReady;
    installCanvasDragSelectionGuard();
    stopCanvasWheel();
    _stylesReady = ensureStylesheet(STYLE_ID, "../krc_config_switcher.css", import.meta.url, { version: STYLE_VERSION, ready: true });
    return _stylesReady;
}

export function h(tag, props = {}, children = []) {
    const element = baseEl(tag);
    for (const [key, value] of Object.entries(props)) {
        if (key === "class") element.className = value;
        else if (key === "text") element.textContent = value;
        else if (key.startsWith("on") && typeof value === "function") {
            element.addEventListener(key.slice(2).toLowerCase(), value);
        } else if (typeof value === "boolean") {
            if (value) element.setAttribute(key, "");
            else element.removeAttribute(key);
        } else {
            element.setAttribute(key, value);
        }
    }
    for (const child of [].concat(children)) {
        if (child) element.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
    return element;
}

export function getWidget(node, name) {
    return node.widgets?.find((widget) => widget.name === name);
}

// Paint the fixed dark LiteGraph node chrome (see shared/node_palette.js).
export function applyNodeColors(node) {
    applyNodeCanvasColors(node);
}

export function hideWidget(widget) {
    if (!widget) return;
    // Node 2.0 (Vue @comfyorg/litegraph): `hidden = true` alone does NOT stop a
    // widget rendering — reassigning `type = "hidden"` is what removes the drawn
    // field (and hiding the element handles DOM-backed multiline widgets). Mirror
    // the shared hideWidget (web/js/shared/widgets.js). `computeSize` [0,-4] keeps
    // the old canvas frontend collapsing the row. The widget stays in node.widgets
    // and still serialises as the hidden data carrier (config_data / true/false).
    widget.hidden = true;
    widget.type = "hidden";
    widget.computeSize = () => [0, -4];
    const domEl = widget.element || widget.inputEl;
    if (domEl?.style) domEl.style.display = "none";
}

export function promoteDomWidgetAfterVisible(node, domWidget) {
    if (!node?.widgets || !domWidget) return;
    const isHidden = (widget) => widget.hidden === true || widget.type === "hidden";
    const visible = node.widgets.filter((widget) => widget !== domWidget && !isHidden(widget));
    const hidden = node.widgets.filter((widget) => widget !== domWidget && isHidden(widget));
    node.widgets = [...visible, domWidget, ...hidden];
}
