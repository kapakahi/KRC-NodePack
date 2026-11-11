import { applyNoSelect, applyTransformDims, fitFullFrame, initLayout, updateOutputRes } from "./geometry.js";
import { centerSelectionInView, render } from "./render.js";
import { syncWidgets } from "./ui_state.js";
import { modalPaletteIdForNode, openNumericPopover } from "./krc.js";

const ANGLE_MIN = -180;
const ANGLE_MAX = 180;
const FINE_STEP = 5;

function normalizeAngle(angle) {
    const normalized = ((((Math.round(angle) + 180) % 360) + 360) % 360) - 180;
    return normalized === -180 ? 180 : normalized;
}

function clampAngle(angle) {
    return Math.max(ANGLE_MIN, Math.min(ANGLE_MAX, normalizeAngle(angle)));
}

function applySingleFineAngle(st, dom, widgets, node, angle) {
    const nextAngle = clampAngle(angle);
    const changedCoarse = st.rotate !== 0;
    st.rotate = 0;
    st.fineRotate = nextAngle;
    if (changedCoarse) {
        applyTransformDims(st);
        if (initLayout(st, dom.wrap)) {
            fitFullFrame(st);
            updateOutputRes(st);
            if (st.noSelect) applyNoSelect(st);
            centerSelectionInView(st, dom);
        }
    }
    render(st, dom);
    syncWidgets(st, widgets, node);
}

function openAngleEditor(st, dom, widgets, node, anchor) {
    st._angleEditor?.close(true);
    const initialRotate = st.rotate || 0;
    const initialFineRotate = st.fineRotate || 0;
    const initialAngle = clampAngle(initialRotate + initialFineRotate);
    const sanitizeAngleInput = (value) => {
        let text = String(value ?? "").replace(/[^\d-]/g, "");
        const negative = text.startsWith("-");
        text = text.replace(/-/g, "");
        return `${negative ? "-" : ""}${text}`;
    };
    const editor = openNumericPopover({
        root: dom.root,
        anchor,
        initialValue: initialAngle,
        classes: {
            popover: "krc-angle-popover",
            title: "krc-numeric-popover-title",
            input: "krc-angle-value-input",
            slider: "krc-angle-slider",
            nudge: "krc-angle-nudge",
            sliderRow: "krc-angle-slider-row",
        },
        ariaLabel: "Edit rotation angle",
        title: "Rotation",
        inputMode: "numeric",
        inputAriaLabel: "Rotation angle",
        slider: {
            min: ANGLE_MIN,
            max: ANGLE_MAX,
            step: 1,
            value: (value) => value,
            ariaLabel: "Rotation angle slider",
        },
        nudge: {
            step: 1,
            downTitle: "Decrease by 1°",
            upTitle: "Increase by 1°",
        },
        themeId: modalPaletteIdForNode(node),
        formatValue: (value) => String(value),
        sanitizeInput: sanitizeAngleInput,
        isPartialInput: (value) => !value || value === "-",
        normalizeValue: clampAngle,
        formatChangedInput: false,
        onDraft: (value) => applySingleFineAngle(st, dom, widgets, node, value),
        onCommit: (value) => applySingleFineAngle(st, dom, widgets, node, value),
        onCancel: () => {
            st.rotate = initialRotate;
            st.fineRotate = initialFineRotate;
            applyTransformDims(st);
            if (initialRotate !== 0 && initLayout(st, dom.wrap)) {
                fitFullFrame(st);
                updateOutputRes(st);
                if (st.noSelect) applyNoSelect(st);
                centerSelectionInView(st, dom);
            }
            render(st, dom);
            syncWidgets(st, widgets, node);
        },
        onClose: ({ popover }) => {
            if (st._angleEditor?.popover === popover) st._angleEditor = null;
        },
    });
    st._angleEditor = editor;
}

export function wireTransformControls(st, dom, widgets, node, { stopPlayback }) {
    dom.flipHBtn.addEventListener("click", () => {
        if (st.passthrough) return;
        st.flipX = !st.flipX;
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.flipVBtn.addEventListener("click", () => {
        if (st.passthrough) return;
        st.flipY = !st.flipY;
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.rotatePrevBtn.addEventListener("click", () => {
        if (st.passthrough) return;
        stopPlayback();
        st._angleEditor?.close(true);
        applySingleFineAngle(st, dom, widgets, node, (st.rotate || 0) + (st.fineRotate || 0) - FINE_STEP);
    });
    dom.rotateNextBtn.addEventListener("click", () => {
        if (st.passthrough) return;
        stopPlayback();
        st._angleEditor?.close(true);
        applySingleFineAngle(st, dom, widgets, node, (st.rotate || 0) + (st.fineRotate || 0) + FINE_STEP);
    });
    dom.rotateAngleBtn.addEventListener("click", (event) => {
        if (st.passthrough) return;
        event.stopPropagation();
        stopPlayback();
        openAngleEditor(st, dom, widgets, node, dom.rotateAngleBtn);
    });
}
