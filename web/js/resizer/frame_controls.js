import { fetchFrame } from "./api.js";
import { DEFAULT_FPS } from "./constants.js";
import { applyNoSelect, clamp } from "./geometry.js";
import { centerSelectionInView, render } from "./render.js";
import {
    applyFixedRangeFromEnd,
    applyFixedRangeFromStart,
    fixedRangePreviewFrame,
} from "./state.js";
import { syncWidgets, updateFrameSelUI, updateResUI } from "./ui_state.js";
import { debounce } from "./krc.js";

export function wireFrameControls(st, dom, widgets, node, nodeId) {
    let playbackTimer = null;
    let playbackMode = null;

    const setPlaybackActive = (mode) => {
        playbackMode = mode;
        dom.playAllBtn.classList.toggle("is-playing", mode === "all");
        dom.playRangeBtn.classList.toggle("is-playing", mode === "range");
        dom.playAllBtn.textContent = "Play All";
        dom.playRangeBtn.textContent = "Play";
        dom.loopBtn.classList.toggle("is-on", !!st.playbackLoop);
    };

    const stopPlayback = () => {
        if (playbackTimer) {
            clearInterval(playbackTimer);
            playbackTimer = null;
        }
        setPlaybackActive(null);
    };
    node._resizerStopPlayback = stopPlayback;

    // The live preview updates every tick, but widget writes are debounced so
    // scrub drags don't rebuild crop_state dozens of times per second.
    const persistScrub = debounce(() => syncWidgets(st, widgets, node), 150);
    dom.scrubber.addEventListener("input", () => {
        stopPlayback();
        const idx = parseInt(dom.scrubber.value);
        dom.scrubIdx.textContent = idx + " / " + Math.max(0, st.frameCount - 1);
        dom.singleInput.value = idx;
        fetchFrame(nodeId, idx, dom, st);
        st.viewFrame = idx;
        if (st.frameMode === "single") {
            st.frameIn = st.frameOut = idx;
        }
        if (st.frameMode === "single") updateFrameSelUI(st, dom);
        persistScrub();
    });
    dom.scrubber.addEventListener("change", () => persistScrub.flush());

    const previewFrame = (idx) => {
        const maxF = Math.max(0, st.frameCount - 1);
        const i = clamp(idx, 0, maxF);
        dom.scrubber.value = i;
        dom.singleInput.value = i;
        dom.scrubIdx.textContent = i + " / " + maxF;
        fetchFrame(nodeId, i, dom, st);
        st.viewFrame = i;
    };

    const previewFixedEdge = () => previewFrame(fixedRangePreviewFrame(st));
    const syncFixedRange = (persist = true) => {
        previewFixedEdge();
        updateFrameSelUI(st, dom);
        if (persist) syncWidgets(st, widgets, node);
    };
    const applyFixedRangeAnchored = () => {
        if (st.fixedRangeActiveEdge === "out") applyFixedRangeFromEnd(st, st.frameOut);
        else applyFixedRangeFromStart(st, st.frameIn);
    };
    const rangeActive = () => st.frameMode === "range";

    const setMode = (mode) => {
        stopPlayback();
        const maxF = Math.max(0, st.frameCount - 1);
        st.frameMode = (mode === "last" && st.frameMode === "last")
            ? "single"
            : mode;
        if (st.frameMode === "single") {
            st.frameIn = st.frameOut = clamp(parseInt(dom.scrubber.value) || 0, 0, maxF);
        } else if (st.frameMode === "range") {
            if (st.fixedRange) {
                st.fixedRangeActiveEdge = "in";
                applyFixedRangeFromStart(st, parseInt(dom.scrubber.value) || 0);
                previewFixedEdge();
            }
            else if (!(st.frameOut > st.frameIn)) { st.frameIn = 0; st.frameOut = maxF; }
        } else if (st.frameMode === "last") {
            previewFrame(maxF);
        }
        updateFrameSelUI(st, dom);
        syncWidgets(st, widgets, node);
    };
    dom.singleBtn.addEventListener("click", () => setMode("single"));
    dom.rangeBtn.addEventListener("click", () => setMode("range"));
    dom.lastFrameBtn.addEventListener("click", () => setMode("last"));
    dom.fixedRangeBtn.addEventListener("click", () => {
        stopPlayback();
        st.fixedRange = !st.fixedRange;
        if (st.fixedRange) {
            st.frameMode = "range";
            st.fixedRangeActiveEdge = "in";
            applyFixedRangeFromStart(st, parseInt(dom.scrubber.value) || st.viewFrame || 0);
            previewFixedEdge();
        }
        updateFrameSelUI(st, dom);
        syncWidgets(st, widgets, node);
    });

    dom.passBtn.addEventListener("click", () => {
        stopPlayback();
        st.passthrough = !st.passthrough;
        if (st.passthrough) {
            st.noSelect = false;
            st.resLocked = false;
        }
        updateFrameSelUI(st, dom);
        updateResUI(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    dom.noSelBtn.addEventListener("click", () => {
        stopPlayback();
        st.noSelect = !st.noSelect;
        if (st.noSelect) {
            st.passthrough = false;
            st.resLocked = false;
            applyNoSelect(st);
        }
        updateFrameSelUI(st, dom);
        updateResUI(st, dom);
        centerSelectionInView(st, dom);
        render(st, dom);
        syncWidgets(st, widgets, node);
    });

    dom.selResetBtn.addEventListener("click", () => {
        stopPlayback();
        if (st.fixedRange && st.frameMode === "range") {
            st.fixedRangeActiveEdge = "in";
            applyFixedRangeFromStart(st, 0);
            previewFixedEdge();
        } else {
            st.frameIn = 0;
            st.frameOut = Math.max(0, st.frameCount - 1);
            previewFrame(0);
        }
        updateFrameSelUI(st, dom);
        syncWidgets(st, widgets, node);
    });
    dom.fixedFpsInput.addEventListener("change", () => {
        stopPlayback();
        let fps = Math.round(parseFloat(dom.fixedFpsInput.value));
        if (!Number.isFinite(fps)) fps = DEFAULT_FPS;
        st.fixedRangeFps = Math.max(1, Math.min(99, fps));
        if (st.frameMode === "range" && st.fixedRange) {
            applyFixedRangeAnchored();
            syncFixedRange();
        } else {
            updateFrameSelUI(st, dom);
            syncWidgets(st, widgets, node);
        }
    });
    dom.fixedSecInput.addEventListener("change", () => {
        stopPlayback();
        const sec = Math.round(parseFloat(dom.fixedSecInput.value) * 10) / 10;
        st.fixedRangeSeconds = Math.max(0.1, Math.min(999, Number.isFinite(sec) ? sec : 5));
        if (st.frameMode === "range" && st.fixedRange) {
            applyFixedRangeAnchored();
            syncFixedRange();
        } else {
            updateFrameSelUI(st, dom);
            syncWidgets(st, widgets, node);
        }
    });

    const frameFromTimelineEvent = (e) => {
        const rect = dom.scrubWrap.getBoundingClientRect();
        const maxF = Math.max(0, st.frameCount - 1);
        if (rect.width <= 0 || maxF <= 0) return 0;
        const t = clamp((e.clientX - rect.left) / rect.width, 0, 1);
        return Math.round(t * maxF);
    };
    const setFixedRangeFromEdge = (edge, frame, persist = true) => {
        st.fixedRangeActiveEdge = edge === "out" ? "out" : "in";
        if (st.fixedRangeActiveEdge === "out") applyFixedRangeFromEnd(st, frame);
        else applyFixedRangeFromStart(st, frame);
        syncFixedRange(persist);
    };
    const syncRangeEdit = (persist = true) => {
        previewFrame(fixedRangePreviewFrame(st));
        updateFrameSelUI(st, dom);
        if (persist) syncWidgets(st, widgets, node);
    };
    const setRangeFromEdge = (edge, frame, persist = true) => {
        if (st.fixedRange) {
            setFixedRangeFromEdge(edge, frame, persist);
            return;
        }
        const maxF = Math.max(0, st.frameCount - 1);
        st.fixedRangeActiveEdge = edge === "out" ? "out" : "in";
        const f = clamp(Math.round(frame || 0), 0, maxF);
        if (st.fixedRangeActiveEdge === "out") {
            st.frameOut = Math.max(st.frameIn, f);
        } else {
            st.frameIn = Math.min(st.frameOut, f);
        }
        syncRangeEdit(persist);
    };
    const moveRangeBy = (deltaFrames, persist = true) => {
        if (st.fixedRange) {
            moveFixedRangeBy(deltaFrames, persist);
            return;
        }
        const maxF = Math.max(0, st.frameCount - 1);
        const len = Math.max(1, st.frameOut - st.frameIn + 1);
        let frameIn = clamp(st.frameIn + deltaFrames, 0, Math.max(0, maxF - len + 1));
        st.frameIn = frameIn;
        st.frameOut = Math.min(maxF, frameIn + len - 1);
        syncRangeEdit(persist);
    };
    const moveFixedRangeBy = (deltaFrames, persist = true) => {
        applyFixedRangeFromStart(st, st.frameIn + deltaFrames);
        syncFixedRange(persist);
    };
    let fixedDrag = null;
    const startFixedDrag = (e, type, edge = null) => {
        if (!rangeActive()) return;
        stopPlayback();
        e.preventDefault();
        e.stopPropagation();
        const startFrame = frameFromTimelineEvent(e);
        fixedDrag = {
            type,
            edge,
            pointerFrame: startFrame,
            frameIn: st.frameIn,
            frameOut: st.frameOut,
        };
        if (edge) {
            st.fixedRangeActiveEdge = edge === "out" ? "out" : "in";
            syncRangeEdit(false);
        }
        dom.scrubWrap.setPointerCapture?.(e.pointerId);
    };
    dom.fixedInHandle.addEventListener("pointerdown", e => startFixedDrag(e, "edge", "in"));
    dom.fixedOutHandle.addEventListener("pointerdown", e => startFixedDrag(e, "edge", "out"));
    dom.selSpan.addEventListener("pointerdown", e => startFixedDrag(e, "bar"));
    dom.scrubWrap.addEventListener("pointermove", e => {
        if (!fixedDrag) return;
        const frame = frameFromTimelineEvent(e);
        if (fixedDrag.type === "edge") {
            setRangeFromEdge(fixedDrag.edge, frame, false);
        } else {
            const delta = frame - fixedDrag.pointerFrame;
            st.frameIn = fixedDrag.frameIn;
            st.frameOut = fixedDrag.frameOut;
            moveRangeBy(delta, false);
        }
    });
    const endFixedDrag = e => {
        if (!fixedDrag) return;
        fixedDrag = null;
        try { dom.scrubWrap.releasePointerCapture?.(e.pointerId); } catch {}
        syncWidgets(st, widgets, node);
    };
    dom.scrubWrap.addEventListener("pointerup", endFixedDrag);
    dom.scrubWrap.addEventListener("pointercancel", endFixedDrag);

    dom.singleInput.addEventListener("change", () => {
        stopPlayback();
        const maxF = Math.max(0, st.frameCount - 1);
        const idx = clamp(parseInt(dom.singleInput.value) || 0, 0, maxF);
        if (rangeActive()) {
            setRangeFromEdge(st.fixedRangeActiveEdge, idx);
            return;
        } else if (st.frameMode === "single") {
            st.frameIn = st.frameOut = idx;
        }
        previewFrame(idx);
        updateFrameSelUI(st, dom);
        syncWidgets(st, widgets, node);
    });
    const stepSingleFrame = (delta) => {
        stopPlayback();
        const maxF = Math.max(0, st.frameCount - 1);
        const parsed = parseInt(dom.singleInput.value);
        const current = clamp(Number.isFinite(parsed) ? parsed : (st.frameIn || 0), 0, maxF);
        const idx = clamp(current + delta, 0, maxF);
        if (rangeActive()) {
            setRangeFromEdge(st.fixedRangeActiveEdge, idx);
            return;
        } else if (st.frameMode === "single") {
            st.frameIn = st.frameOut = idx;
        }
        previewFrame(idx);
        updateFrameSelUI(st, dom);
        syncWidgets(st, widgets, node);
    };
    dom.framePrevBtn.addEventListener("click", () => stepSingleFrame(-1));
    dom.frameNextBtn.addEventListener("click", () => stepSingleFrame(1));

    const startPlayback = (mode) => {
        if (playbackMode === mode) {
            stopPlayback();
            return;
        }
        stopPlayback();
        const maxF = Math.max(0, st.frameCount - 1);
        const start = mode === "range" ? clamp(st.frameIn, 0, maxF) : 0;
        const end = mode === "range" ? clamp(st.frameOut, start, maxF) : maxF;
        const maxPasses = 10;
        let completedPasses = 0;
        if (end <= start) {
            previewFrame(start);
            return;
        }
        let frame = clamp(parseInt(dom.scrubber.value) || start, start, end);
        previewFrame(frame);
        setPlaybackActive(mode);
        const playbackFps = Math.max(1, st.fixedRangeFps || DEFAULT_FPS);
        const delayMs = Math.round(1000 / playbackFps);
        playbackTimer = setInterval(() => {
            frame += 1;
            if (frame > end) {
                completedPasses += 1;
                if (st.playbackLoop && completedPasses < maxPasses) {
                    frame = start;
                } else {
                    stopPlayback();
                    return;
                }
            }
            if (st.frameMode === "single") st.frameIn = st.frameOut = frame;
            previewFrame(frame);
            updateFrameSelUI(st, dom);
            syncWidgets(st, widgets, node);
        }, delayMs);
    };

    dom.playAllBtn.addEventListener("click", () => startPlayback("all"));
    dom.playRangeBtn.addEventListener("click", () => startPlayback("range"));
    dom.loopBtn.addEventListener("click", () => {
        st.playbackLoop = !st.playbackLoop;
        setPlaybackActive(playbackMode);
    });

    return { stopPlayback };
}
