import { GRID } from "./constants.js";
import {
    applyMP,
    applyNoSelect,
    defaultOut,
    fitAspectInsideSource,
    initLayout,
    restoreCropFromWidgets,
    resizeLayout,
    syncOutToAR,
} from "./geometry.js";
import { centerSelectionInView, render } from "./render.js";
import {
    restoreFrameSelFromWidgets,
    setArLocked,
    updateFrameSelUI,
    updatePadColorUI,
} from "./ui_state.js";

export function setupLayoutObserver(st, dom, widgets) {
    const ro = new ResizeObserver(() => {
        if (dom.wrap.clientHeight <= 0 || dom.wrap.clientWidth <= 0) return;

        if (!st.initialized) {
            // Deferred initialization: the node was offscreen when the double-rAF
            // fired, so complete the setup once the widget has real dimensions.
            if (!initLayout(st, dom.wrap)) return;
            if (st._fromWorkflow) {
                restoreCropFromWidgets(st, widgets, st._latchedCropState);
            }
            st._latchedCropState = undefined;
            if (st._latchedPadColor) {
                st.padColor = st._latchedPadColor;
                st._latchedPadColor = undefined;
            }
            if (st._latchedCustomPadColor) {
                st.customPadColor = st._latchedCustomPadColor;
                st._latchedCustomPadColor = undefined;
            }
            updatePadColorUI(st, dom);
            if (st._fromWorkflow) {
                restoreFrameSelFromWidgets(st, widgets);
            }
            setArLocked(st, dom, st.arLocked);
            if (st.resMode === "mp") {
                applyMP(st);
            } else if (st.outW < GRID || st.outH < GRID) {
                const d = defaultOut(st);
                st.outW = d.w;
                st.outH = d.h;
            } else if (st.resLocked && !st.noSelect) {
                fitAspectInsideSource(st, st.outW / st.outH);
                setArLocked(st, dom, true);
            } else {
                syncOutToAR(st);
            }
            if (st.noSelect) applyNoSelect(st);
            centerSelectionInView(st, dom);
            render(st, dom);
            updateFrameSelUI(st, dom);
            return;
        }

        // Workspace resizing changes projection only, never execution state.
        if (!resizeLayout(st, dom.wrap)) return;

        centerSelectionInView(st, dom);
        render(st, dom);
    });
    ro.observe(dom.wrap);
    return ro;
}
