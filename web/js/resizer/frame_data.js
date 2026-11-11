import { GRID } from "./constants.js";
import { clearFramePreview, fetchFrame, setFramePreviewBase64 } from "./api.js";
import { centerSelectionInView, render } from "./render.js";
import {
    applyMP,
    applyNoSelect,
    applyTransformDims,
    clamp,
    clampToValid,
    crToSrc,
    defaultOut,
    fitAspectInsideSource,
    fitFullFrame,
    initLayout,
    isFullSourceRect,
    quantizeSrc,
    restoreConfigModes,
    restoreCropFromWidgets,
    srcToCr,
} from "./geometry.js";
import {
    clampFrameSel,
    restoreFrameSelFromWidgets,
    setArLocked,
    syncWidgets,
    updateFrameSelUI,
    updatePadColorUI,
    updateResUI,
} from "./ui_state.js";
import {
    applyFixedRangeFromStart,
    fixedRangePreviewFrame,
} from "./state.js";

function cropStateMatchesInput(val, data) {
    const parts = val.split(",").map(Number);
    if (parts.length < 20 || parts.some(isNaN)) return false;
    return parts[15] === data.width
        && parts[16] === data.height
        && parts[18] === data.frame_count
        && parts[19] === (data.media_sig || 0);
}

export function applyFrameData(data, preserveCrop, st, dom, widgets, node, nodeId) {
    const val = widgets.cropState?.value ?? "";
    const hadCrop = preserveCrop && val !== "" && !val.split(",").some(isNaN);
    const prevSrc = (hadCrop && st.initialized) ? crToSrc(st.cr, st.sf, st.scale) : null;

    // Detect a new/changed input via a lightweight signature (dims +
    // frame count + a fingerprint of frame 0). Auto-fit the crop to the
    // full source frame on any new/unknown input, including workflow reloads
    // whose saved crop cannot be proven to belong to the current media.
    const sig = `${data.width}x${data.height}x${data.frame_count}:${data.media_sig || 0}`;
    const firstLoad = st._inputSig === undefined;
    const inputChanged = !firstLoad && st._inputSig !== sig;
    st._inputSig = sig;
    const restoreSaved = firstLoad && st._fromWorkflow && hadCrop && cropStateMatchesInput(val, data);
    const fitFull = inputChanged || (firstLoad && !restoreSaved);

    st.rawW = data.width;
    st.rawH = data.height;
    st.mediaSig = data.media_sig || 0;
    st.hasFrameData = true;
    if (fitFull) {
        st._angleEditor?.close(false);
        st.rotate = 0;
        st.fineRotate = 0;
    }
    applyTransformDims(st);   // effective (rotated) dims drive all geometry
    st.frameCount = data.frame_count;
    initLayout(st, dom.wrap);

    // On workflow load, restore input-independent config modes before geometry.
    // Aspect lock is reset below whenever the media is new/changed; a selected
    // ratio is only meaningful when the saved crop belongs to this same input.
    const restoreModes = firstLoad && st._fromWorkflow && hadCrop;
    if (restoreModes) restoreConfigModes(st, widgets);

    if (fitFull) {
        if (st.resLocked && st.resMode === "manual" && !st.noSelect && st.outW >= GRID && st.outH >= GRID) {
            fitAspectInsideSource(st, st.outW / st.outH);
            setArLocked(st, dom, true);
        } else {
            fitFullFrame(st);
            setArLocked(st, dom, false);
        }
    } else if (prevSrc) {
        const s = isFullSourceRect(prevSrc, st)
            ? { x: 0, y: 0, w: st.srcW, h: st.srcH }
            : clampToValid(quantizeSrc(prevSrc), st.srcW, st.srcH);
        st.cr = srcToCr(s, st.sf, st.scale);
        st.cropAR = s.w / s.h;
    } else if (hadCrop) {
        restoreCropFromWidgets(st, widgets);
    }
    // Recompute MP-mode resolution against the (possibly new) crop AR;
    // otherwise only set a default if the user hasn't configured one.
    if (st.resMode === "mp") {
        applyMP(st);
    } else if (st.outW < GRID || st.outH < GRID) {
        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
    }
    if (fitFull && st.resLocked && st.resMode === "manual" && !st.noSelect && st.outW >= GRID && st.outH >= GRID) {
        fitAspectInsideSource(st, st.outW / st.outH);
        setArLocked(st, dom, true);
    }
    // No-Selection: re-pin the crop to the (possibly new) full frame and
    // lock output to the source AR.
    if (st.noSelect) applyNoSelect(st);
    // Re-read pad color from the hidden widget (onConfigure may not have
    // run yet, or the rAF may have written stale state via syncWidgets).
    if (widgets.padColor)   st.padColor   = widgets.padColor.value;
    if (widgets.customPadColor) st.customPadColor = widgets.customPadColor.value;
    // Re-read frame-select / passthrough. Frame mode is user/workflow intent:
    // never auto-promote a multi-frame input to Range, because downstream image
    // workflows may expect exactly one frame.
    restoreFrameSelFromWidgets(st, widgets);
    if (fitFull && st.frameMode === "range") {
        st.frameIn = 0;
        st.frameOut = Math.max(0, st.frameCount - 1);
    } else if (fitFull && st.frameMode === "single") {
        st.frameIn = st.frameOut = 0;
    }
    clampFrameSel(st);

    if (st.frameMode === "range" && st.fixedRange && fitFull) {
        st.fixedRangeActiveEdge = "in";
        applyFixedRangeFromStart(st, 0);
    }

    // ── Viewed frame (scrubber) ──────────────────────────────────────────
    // Single mode: the preview follows the (persisted) selection. Range/off:
    // the scrub position is independent of the selection, so restore it from
    // st.viewFrame (saved in crop_state) — !fitFull already proves it belongs to
    // the SAME input. In-session re-run: keep the current slider for the same
    // input, reset to 0 on a new one.
    const maxF = Math.max(0, data.frame_count - 1);
    let viewFrame;
    if (firstLoad && st._fromWorkflow) {
        if (st.frameMode === "range" && st.fixedRange) {
            viewFrame = fitFull ? st.frameIn : fixedRangePreviewFrame(st);
        } else if (st.frameMode === "single") {
            viewFrame = clamp(st.frameIn, 0, maxF);
        } else if (!fitFull) {
            viewFrame = clamp(st.viewFrame || 0, 0, maxF);
        } else {
            viewFrame = 0;
        }
    } else {
        viewFrame = (st.frameMode === "range" && st.fixedRange)
            ? (fitFull ? st.frameIn : fixedRangePreviewFrame(st))
            : fitFull ? 0 : clamp(parseInt(dom.scrubber.value) || 0, 0, maxF);
    }
    st.viewFrame = viewFrame;
    dom.scrubber.max = maxF;
    dom.scrubber.value = viewFrame;
    dom.singleInput.value = viewFrame;
    dom.scrubIdx.textContent = viewFrame + " / " + maxF;
    const hasInlineFrame = viewFrame === 0 && typeof data.frame === "string" && data.frame.trim().length > 0;
    if (hasInlineFrame) {
        // Frame 0 ships inline in the info payload. Keep it out of img.src as a
        // long-lived base64 string so Safari can release the backing bytes when
        // the preview is replaced or cleared.
        setFramePreviewBase64(dom, data.frame, st);
    } else if (viewFrame === 0) {
        clearFramePreview(st, dom);
    } else {
        clearFramePreview(st, dom);
        fetchFrame(nodeId, viewFrame, dom, st).then((loaded) => {
            if (loaded) render(st, dom);
        });
    }

    centerSelectionInView(st, dom);
    render(st, dom);
    updateFrameSelUI(st, dom);
    updateResUI(st, dom);
    updatePadColorUI(st, dom);
    syncWidgets(st, widgets, node);
}
