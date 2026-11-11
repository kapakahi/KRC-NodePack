import { DEFAULT_FPS } from "./constants.js";

/** Frames the current selection will emit (before any LTX trim). */
export function selectedFrameCount(st) {
    if (st.frameMode === "single" || st.frameMode === "last") return 1;
    if (st.frameMode === "range") return Math.max(1, st.frameOut - st.frameIn + 1);
    return Math.max(1, st.frameCount);
}

export function fixedRangeFrameCount(st) {
    const fps = Number.isFinite(st.fixedRangeFps) ? st.fixedRangeFps : DEFAULT_FPS;
    const sec = Number.isFinite(st.fixedRangeSeconds) ? st.fixedRangeSeconds : 5;
    return Math.max(1, Math.round(fps * sec));
}

export function applyFixedRangeFromStart(st, startFrame = st.frameIn) {
    const total = Math.max(1, st.frameCount || 1);
    const maxF = total - 1;
    const len = Math.min(total, fixedRangeFrameCount(st));
    let frameIn = Math.max(0, Math.min(maxF, Math.round(startFrame || 0)));
    let frameOut = frameIn + len - 1;
    if (frameOut > maxF) {
        frameOut = maxF;
        frameIn = Math.max(0, frameOut - len + 1);
    }
    st.frameIn = frameIn;
    st.frameOut = frameOut;
}

export function applyFixedRangeFromEnd(st, endFrame = st.frameOut) {
    const total = Math.max(1, st.frameCount || 1);
    const maxF = total - 1;
    const len = Math.min(total, fixedRangeFrameCount(st));
    let frameOut = Math.max(0, Math.min(maxF, Math.round(endFrame || 0)));
    let frameIn = frameOut - len + 1;
    if (frameIn < 0) {
        frameIn = 0;
        frameOut = Math.min(maxF, len - 1);
    }
    st.frameIn = frameIn;
    st.frameOut = frameOut;
}

export function fixedRangePreviewFrame(st) {
    return st.fixedRangeActiveEdge === "out" ? st.frameOut : st.frameIn;
}

export function createState() {
    return {
        srcW: 1024, srcH: 1024,   // EFFECTIVE (post-rotation) source dims — all crop geometry uses these
        rawW: 1024, rawH: 1024,   // raw input dims before rotation
        rotate: 0,                // 0 | 90 | 180 | 270 (clockwise)
        fineRotate: 0,            // arbitrary single-frame angle offset, integer degrees
        flipX: false,             // horizontal mirror (left-right)
        flipY: false,             // vertical mirror (up-down)
        frameCount: 1,
        scale: 1,
        sf: { x: 0, y: 0, w: 0, h: 0 },
        cr: { x: 0, y: 0, w: 0, h: 0 },
        cropAR: 1,
        arLocked: false,
        initialized: false,
        hasFrameData: false,
        hasPreviewImage: false,
        mediaSig: 0,
        view: { zoom: 1.0, panX: 0, panY: 0 },
        outW: 0, outH: 0,
        padColor: "ltx",
        customPadColor: "115,115,115",
        paddingEnabled: true,
        frameMode: "single",   // "off" | "single" | "range" | "last"
        frameIn: 0, frameOut: 0,
        fixedRange: false,
        fixedRangeFps: DEFAULT_FPS,
        fixedRangeSeconds: 5,
        fixedRangeActiveEdge: "in",   // "in" | "out"; active fixed-range handle drives preview
        playbackLoop: true,
        passthrough: false,
        noSelect: false,    // no crop/pad window: resize the whole frame
        resMode: "mp",   // "manual" | "mp"
        resLocked: false, // manual W/H stays fixed and refits crop aspect on new inputs
        targetMP: 0.6,
        divisor: 32,     // output W/H must be a multiple of this (model-dependent); 32 is the safe universal default. 1 = OFF (exact res)
        viewFrame: 0,    // currently-previewed scrubber frame (persisted in crop_state, restored for the same input)
        maskMode: "both", // "both" | "input" | "empty"
        maskInvert: false,
        maskFeather: 0,
        maskGrow: 0,
        maskThreshold: 0,
    };
}
