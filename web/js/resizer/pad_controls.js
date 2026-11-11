import { centerSelectionInView, render } from "./render.js";
import {
    constrainSrcToPaddingMode,
    crToSrc,
    fitAspectInsideSource,
    quantizeSrc,
    srcToCr,
    updateOutputRes,
} from "./geometry.js";
import {
    syncWidgets,
    updatePadColorUI,
} from "./ui_state.js";

export function wirePadControls(st, dom, widgets, node) {
    updatePadColorUI(st, dom);
    for (const btn of dom.padColorBtns) {
        btn.addEventListener("click", () => {
            st.padColor = btn.dataset.padColor;
            st.customPadColor = btn.dataset.customPadColor;
            updatePadColorUI(st, dom);
            render(st, dom);
            syncWidgets(st, widgets, node);
        });
    }
    dom.paddingBtn.addEventListener("click", () => {
        st.paddingEnabled = !st.paddingEnabled;
        if (!st.paddingEnabled) {
            if (st.arLocked) {
                fitAspectInsideSource(st, st.cropAR);
            } else {
                let s = crToSrc(st.cr, st.sf, st.scale);
                s = constrainSrcToPaddingMode(quantizeSrc(s), st, null);
                st.cr = srcToCr(s, st.sf, st.scale);
                st.cropAR = s.w / s.h;
            }
            updateOutputRes(st);
            centerSelectionInView(st, dom);
        }
        render(st, dom);
        updatePadColorUI(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.customPadColorInput.addEventListener("change", () => {
        st.customPadColor = dom.customPadColorInput.value.trim();
        updatePadColorUI(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
}
