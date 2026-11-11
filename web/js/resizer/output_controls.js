import { GRID } from "./constants.js";
import { centerSelectionInView, render } from "./render.js";
import {
    applyMP,
    applyNoSelect,
    defaultOut,
    fitAspectInsideSource,
    updateOutputRes,
} from "./geometry.js";
import { setArLocked, syncWidgets, updateResUI } from "./ui_state.js";

function applyOutDim(st, dom, widgets, node, axis, rawVal) {
    if (st.resMode === "mp") return;   // W/H are computed from the MP target
    const g = st.divisor || GRID;
    const snapDim = (value) => {
        const v = parseInt(value, 10);
        if (isNaN(v) || v < g) return null;
        return Math.max(g, Math.round(v / g) * g);
    };
    const typed = snapDim(rawVal);
    const paired = snapDim(axis === "w" ? dom.outHInput.value : dom.outWInput.value);

    if (typed === null) {
        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
    } else {
        if (axis === "w") {
            st.outW = typed;
            st.outH = paired ?? Math.max(g, Math.round(typed / st.cropAR / g) * g);
        } else {
            st.outH = typed;
            st.outW = paired ?? Math.max(g, Math.round(typed * st.cropAR / g) * g);
        }
        if (st.outW >= g && st.outH >= g) {
            if (st.noSelect) {
                applyNoSelect(st);
            } else {
                const aspect = st.outW / st.outH;
                fitAspectInsideSource(st, aspect);
                setArLocked(st, dom, true);
                if (st.resLocked) st.resMode = "manual";
            }
        }
    }
    centerSelectionInView(st, dom);
    render(st, dom); syncWidgets(st, widgets, node);
}

function setTargetMP(st, value) {
    if (!(value > 0)) return;
    st.targetMP = Math.max(0.01, Math.round(value * 100) / 100);
    applyMP(st);
}

export function wireOutputControls(st, dom, widgets, node) {
    const { outWInput, outHInput } = dom;

    // Output W / H inputs
    outWInput.addEventListener("change", () => applyOutDim(st, dom, widgets, node, "w", outWInput.value));
    outHInput.addEventListener("change", () => applyOutDim(st, dom, widgets, node, "h", outHInput.value));

    // ── Output resolution mode (manual W×H / megapixels) ──
    dom.resModeButton.addEventListener("click", () => {
        st.resMode = st.resMode === "mp" ? "manual" : "mp";
        dom.resModeSelect.value = st.resMode;
        if (st.resMode === "mp") applyMP(st);   // compute W×H from the MP target now
        if (st.resMode === "mp") st.resLocked = false;
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    dom.resLockBtn.addEventListener("click", () => {
        const g = st.divisor || GRID;
        if (st.resMode === "mp" || st.passthrough || st.noSelect || st.outW < g || st.outH < g) return;
        st.resLocked = !st.resLocked;
        if (st.resLocked) {
            st.divisor = 1;
            dom.divSelect.value = "1";
            fitAspectInsideSource(st, st.outW / st.outH);
            setArLocked(st, dom, true);
            centerSelectionInView(st, dom);
        }
        updateResUI(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    // ── Output divisibility (round output W/H to a multiple of this) ──
    dom.divButton.addEventListener("click", () => {
        if (st.resLocked) {
            st.divisor = 1;
            dom.divSelect.value = "1";
            updateResUI(st, dom);
            return;
        }
        const options = [1, 2, 4, 8, 16, 32, 64];
        const current = st.divisor || GRID;
        const index = options.indexOf(current);
        st.divisor = options[(index + 1) % options.length];
        dom.divSelect.value = String(st.divisor);
        if (st.noSelect) applyNoSelect(st);
        else updateOutputRes(st);   // re-snap output to the new divisor
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.mpInput.addEventListener("change", () => {
        if (st.resMode !== "mp") return;
        setTargetMP(st, parseFloat(dom.mpInput.value));
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.mpPrevBtn.addEventListener("click", () => {
        if (st.resMode !== "mp") return;
        setTargetMP(st, st.targetMP - 0.1);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.mpNextBtn.addEventListener("click", () => {
        if (st.resMode !== "mp") return;
        setTargetMP(st, st.targetMP + 0.1);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
}
