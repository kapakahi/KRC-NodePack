import { clamp } from "./geometry.js";
import { syncWidgets, updateMaskUI } from "./ui_state.js";
import { modalPaletteIdForNode, openNumericPopover } from "./krc.js";

function clampMaskValue(value, lo, hi) {
    const n = Number(value);
    return Number.isFinite(n) ? clamp(n, lo, hi) : 0;
}

function applyMaskNumber(st, dom, widgets, node, { key, min, max, decimals = 0 }, value) {
    const factor = 10 ** decimals;
    st[key] = Math.round(clampMaskValue(value, min, max) * factor) / factor;
    updateMaskUI(st, dom);
    syncWidgets(st, widgets, node);
}

function wireMaskNumberControl(st, dom, widgets, node, { input, button, key, min, max, step, decimals = 0, label }) {
    const cfg = { key, min, max, decimals };
    const formatValue = (value) => decimals > 0
        ? String(Math.round(value * (10 ** decimals)) / (10 ** decimals))
        : String(Math.round(value));
    const sanitizeInput = (value) => {
        let text = String(value ?? "").replace(decimals > 0 ? /[^\d.-]/g : /[^\d-]/g, "");
        const negative = min < 0 && text.startsWith("-");
        text = text.replace(/-/g, "");
        if (decimals > 0) {
            const firstDot = text.indexOf(".");
            if (firstDot >= 0) text = text.slice(0, firstDot + 1) + text.slice(firstDot + 1).replace(/\./g, "");
        } else {
            text = text.replace(/\./g, "");
        }
        return `${negative ? "-" : ""}${text}`;
    };

    input.addEventListener("change", () => applyMaskNumber(st, dom, widgets, node, cfg, input.value));
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        const initial = st[key] || 0;
        openNumericPopover({
            root: dom.root,
            anchor: button,
            initialValue: initial,
            classes: {
                popover: "krc-angle-popover",
                title: "krc-numeric-popover-title",
                input: "krc-angle-value-input",
                slider: "krc-angle-slider",
                nudge: "krc-angle-nudge",
                sliderRow: "krc-angle-slider-row",
            },
            ariaLabel: `Edit ${label}`,
            title: label.charAt(0).toUpperCase() + label.slice(1),
            inputMode: decimals > 0 ? "decimal" : "numeric",
            inputAriaLabel: label,
            slider: {
                min,
                max,
                step,
                value: (value) => value,
                ariaLabel: `${label} slider`,
            },
            nudge: {
                step,
                downTitle: `Decrease ${label}`,
                upTitle: `Increase ${label}`,
            },
            themeId: modalPaletteIdForNode(node),
            formatValue,
            sanitizeInput,
            isPartialInput: (value) => !value || (min < 0 && value === "-") || value === "." || value === "-.",
            normalizeValue: (value) => clampMaskValue(value, min, max),
            formatChangedInput: false,
            onDraft: (value) => applyMaskNumber(st, dom, widgets, node, cfg, value),
            onCommit: (value) => applyMaskNumber(st, dom, widgets, node, cfg, value),
            onCancel: () => applyMaskNumber(st, dom, widgets, node, cfg, initial),
        });
    });
}

export function wireMaskControls(st, dom, widgets, node) {
    for (const [btn, mode] of [
        [dom.maskInputBtn, "input"],
        [dom.maskEmptyBtn, "empty"],
    ]) {
        btn.addEventListener("click", () => {
            st.maskMode = st.maskMode === mode ? "both" : mode;
            updateMaskUI(st, dom);
            syncWidgets(st, widgets, node);
        });
    }

    dom.maskInvertBtn.addEventListener("click", () => {
        st.maskInvert = !st.maskInvert;
        updateMaskUI(st, dom);
        syncWidgets(st, widgets, node);
    });

    wireMaskNumberControl(st, dom, widgets, node, {
        input: dom.featherInput,
        button: dom.featherMenuBtn,
        key: "maskFeather",
        min: 0,
        max: 99,
        step: 1,
        label: "feather",
    });
    wireMaskNumberControl(st, dom, widgets, node, {
        input: dom.growInput,
        button: dom.growMenuBtn,
        key: "maskGrow",
        min: -99,
        max: 99,
        step: 1,
        label: "grow",
    });
    wireMaskNumberControl(st, dom, widgets, node, {
        input: dom.thresholdInput,
        button: dom.thresholdMenuBtn,
        key: "maskThreshold",
        min: 0,
        max: 1,
        step: 0.01,
        decimals: 2,
        label: "threshold",
    });
}
