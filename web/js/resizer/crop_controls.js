import { GRID } from "./constants.js";
import { centerSelectionInView, render } from "./render.js";
import {
    applyCanvasCr,
    applyMP,
    applyNoSelect,
    applyTransformDims,
    constrainSrcToPaddingMode,
    crToSrc,
    fitAspectInsideSource,
    fitFullFrame,
    initLayout,
    quantizeSrc,
    rotatedSourceBounds,
    srcToCr,
    syncOutToAR,
    toWorld,
    updateOutputRes,
} from "./geometry.js";
import {
    setArLocked,
    syncWidgets,
} from "./ui_state.js";

function applyCropDim(st, dom, widgets, node, axis, rawVal) {
    const isW = axis === "w";
    const r = Math.max(GRID, Math.round(parseInt(rawVal, 10) / GRID) * GRID) || GRID;
    let s = crToSrc(st.cr, st.sf, st.scale);
    const cx = s.x + s.w / 2, cy = s.y + s.h / 2;
    if (isW) { s.w = r; if (st.arLocked) s.h = Math.max(GRID, Math.round(r / st.cropAR / GRID) * GRID); }
    else     { s.h = r; if (st.arLocked) s.w = Math.max(GRID, Math.round(r * st.cropAR / GRID) * GRID); }
    s.x = Math.round((cx - s.w / 2) / GRID) * GRID;
    s.y = Math.round((cy - s.h / 2) / GRID) * GRID;
    s = constrainSrcToPaddingMode(quantizeSrc(s), st, st.arLocked ? st.cropAR : null);
    st.cr = srcToCr(s, st.sf, st.scale);
    if (!st.arLocked) st.cropAR = s.w / s.h;
    updateOutputRes(st);
    centerSelectionInView(st, dom); render(st, dom); syncWidgets(st, widgets, node);
}

export function wireCropControls(st, dom, widgets, node) {
    const { wrap, arBtn, snapBtns, wInput, hInput, resetBtn, chipBtns } = dom;

    // AR lock toggle
    arBtn.addEventListener("click", () => setArLocked(st, dom, !st.arLocked));

    // W / H inputs
    wInput.addEventListener("change", () => applyCropDim(st, dom, widgets, node, "w", wInput.value));
    hInput.addEventListener("change", () => applyCropDim(st, dom, widgets, node, "h", hInput.value));

    // Reset button
    resetBtn.addEventListener("click", () => {
        // Reset only geometry/transform to defaults: crop -> full frame,
        // rotation -> 0, flips off, aspect lock off. Deliberately leaves output
        // size, res mode, targetMP, divisor, padding, pad color, frame
        // selection/range, and the viewed frame untouched.
        st.rotate = 0;
        st.fineRotate = 0;
        st.flipX = false;
        st.flipY = false;
        applyTransformDims(st);
        setArLocked(st, dom, false);
        if (initLayout(st, dom.wrap)) {
            fitFullFrame(st);
            if (st.noSelect) applyNoSelect(st);
            // MP mode re-derives output from the new full crop (targetMP kept);
            // manual output size is left exactly as the user set it.
            if (st.resMode === "mp") applyMP(st);
        }
        centerSelectionInView(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.fullBtn.addEventListener("click", () => {
        fitFullFrame(st);
        if (st.resMode === "mp") applyMP(st);
        else updateOutputRes(st);
        centerSelectionInView(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    // Preset chips
    for (const btn of chipBtns) {
        btn.addEventListener("click", () => {
            const rw = parseInt(btn.dataset.chipW, 10), rh = parseInt(btn.dataset.chipH, 10);
            const chipAR = rw / rh;
            if (st.arLocked && Math.abs(st.cropAR - chipAR) < 0.005) {
                setArLocked(st, dom, false);
                render(st, dom);
                syncWidgets(st, widgets, node);
                return;
            }
            setArLocked(st, dom, true); st.cropAR = chipAR;
            fitAspectInsideSource(st, chipAR);
            if (st.resMode === "mp") applyMP(st);
            else if (st.outW < GRID || st.outH < GRID) { st.outW = rw; st.outH = rh; }
            else syncOutToAR(st, true);
            centerSelectionInView(st, dom); render(st, dom); syncWidgets(st, widgets, node);
        });
    }

    // Snap buttons
    for (const btn of snapBtns) {
        btn.addEventListener("click", () => {
            const mode = btn.dataset.snap;
            let s = crToSrc(st.cr, st.sf, st.scale);
            const { srcW, srcH } = st;
            if (mode === "center") {
                s.x = Math.round((srcW - s.w) / 2 / GRID) * GRID;
                s.y = Math.round((srcH - s.h) / 2 / GRID) * GRID;
            } else if (mode === "top") {
                s.y = rotatedSourceBounds(st).y;
            } else if (mode === "bottom") {
                const bounds = rotatedSourceBounds(st);
                s.y = bounds.y + bounds.h - s.h;
            } else if (mode === "fitW") {
                const bounds = rotatedSourceBounds(st);
                s.w = bounds.w;
                if (st.arLocked) s.h = Math.round(s.w / st.cropAR / GRID) * GRID;
                s.x = bounds.x;
                s.y = Math.round((srcH - s.h) / 2 / GRID) * GRID;
            } else if (mode === "fitH") {
                const bounds = rotatedSourceBounds(st);
                s.h = bounds.h;
                if (st.arLocked) s.w = Math.round(s.h * st.cropAR / GRID) * GRID;
                s.y = bounds.y;
                s.x = Math.round((srcW - s.w) / 2 / GRID) * GRID;
            } else if (mode === "left") {
                s.x = rotatedSourceBounds(st).x;
            } else if (mode === "right") {
                const bounds = rotatedSourceBounds(st);
                s.x = bounds.x + bounds.w - s.w;
            }
            s = constrainSrcToPaddingMode(quantizeSrc(s), st, st.arLocked ? st.cropAR : null);
            st.cr = srcToCr(s, st.sf, st.scale);
            if (!st.arLocked) st.cropAR = s.w / s.h;
            updateOutputRes(st);
            centerSelectionInView(st, dom);
            render(st, dom);
            syncWidgets(st, widgets, node);
        });
    }

    // ── Pointer drag/resize ──
    let drag = null;
    const MIN_DRAG_PX = GRID;

    wrap.addEventListener("pointerdown", e => {
        const handle    = e.target.closest("[data-dir]");
        const inCropBox = dom.cropBox.contains(e.target);
        const wc        = toWorld(e, wrap, st.view);

        if (handle) {
            drag = { type: "resize", dir: handle.dataset.dir, sx: wc.x, sy: wc.y, sb: { ...st.cr }, ar: st.arLocked ? st.cropAR : null };
            e.preventDefault();
        } else if (inCropBox) {
            drag = { type: "move", sx: wc.x, sy: wc.y, sb: { ...st.cr } };
            e.preventDefault();
        }
        if (drag) wrap.setPointerCapture(e.pointerId);
    });

    wrap.addEventListener("pointermove", e => {
        if (!drag) return;

        const wc   = toWorld(e, wrap, st.view);
        const dx   = wc.x - drag.sx;
        const dy   = wc.y - drag.sy;
        const minPx = MIN_DRAG_PX * st.scale;

        if (drag.type === "move") {
            applyCanvasCr({ ...drag.sb, x: drag.sb.x + dx, y: drag.sb.y + dy }, st);
            render(st, dom);
            return;
        }

        let { x, y, w, h } = drag.sb;
        const { dir, ar } = drag;

        if (dir === "br") {
            w = Math.max(minPx, w + dx);
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "bl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            h = ar ? Math.round(w / ar) : Math.max(minPx, h + dy);
        } else if (dir === "tr") {
            w = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "tl") {
            const nw = Math.max(minPx, w - dx); x += w - nw; w = nw;
            const nh = ar ? Math.round(w / ar) : Math.max(minPx, h - dy);
            y += h - nh; h = nh;
        } else if (dir === "t") {
            const nh = Math.max(minPx, h - dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            y += h - nh; h = nh; w = nw;
        } else if (dir === "b") {
            const nh = Math.max(minPx, h + dy);
            const nw = ar ? Math.round(nh * ar) : w;
            if (ar) x += Math.round((w - nw) / 2);
            h = nh; w = nw;
        } else if (dir === "l") {
            const nw = Math.max(minPx, w - dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            x += w - nw; w = nw; h = nh;
        } else if (dir === "r") {
            const nw = Math.max(minPx, w + dx);
            const nh = ar ? Math.round(nw / ar) : h;
            if (ar) y += Math.round((h - nh) / 2);
            w = nw; h = nh;
        }

        applyCanvasCr({ x, y, w, h }, st);
        render(st, dom);
    });

    wrap.addEventListener("pointerup", () => {
        if (drag) {
            const type = drag.type;
            drag = null;
            if (type === "resize" && st.arLocked) {
                // Re-derive h from w so the final dimensions honour the exact locked AR,
                // undoing any divergence introduced by independent GRID rounding.
                let s = crToSrc(st.cr, st.sf, st.scale);
                s = quantizeSrc(s);
                s.h = Math.max(GRID, Math.round(s.w / st.cropAR / GRID) * GRID);
                s = constrainSrcToPaddingMode(s, st, st.cropAR);
                st.cr = srcToCr(s, st.sf, st.scale);
            }
            if (type === "resize") {
                if (!st.arLocked) {
                    const s = crToSrc(st.cr, st.sf, st.scale);
                    st.cropAR = s.w / s.h;
                }
                updateOutputRes(st);
            }
            if (type === "resize" || type === "move") centerSelectionInView(st, dom);
            render(st, dom);
            syncWidgets(st, widgets, node);
        }
    });
    wrap.addEventListener("pointercancel", () => { drag = null; });
}
