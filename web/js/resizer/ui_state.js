import { DEFAULT_FPS, GRID } from "./constants.js";
import { setControlActive } from "./controls.js";
import { clamp, crToSrc, isFullSourceRect, quantizeSrc } from "./geometry.js";
import { fixedRangePreviewFrame, selectedFrameCount } from "./state.js";

// ── Widget sync ───────────────────────────────────────────────────────

function formatTargetMP(value) {
    const rounded = Math.round(value * 100) / 100;
    return Number.isInteger(rounded * 10) ? rounded.toFixed(1) : rounded.toFixed(2);
}

function updateOutputReadout(st, dom) {
    const actual = (st.outW * st.outH) / 1e6;
    if (st.outW >= GRID && st.outH >= GRID) {
        let frames = "";
        if (st.frameMode === "range") {
            const count = selectedFrameCount(st);
            const fps = Math.max(1, st.fixedRangeFps || DEFAULT_FPS);
            frames = ` ${count} FRAMES (${(count / fps).toFixed(1)} SEC)`;
        }
        dom.mpReadout.textContent = `${st.outW}x${st.outH} ${actual.toFixed(2)}MP${frames}`;
    } else {
        dom.mpReadout.textContent = "";
    }
}

function maskModeCode(st) {
    return st.maskMode === "input" ? 1 : st.maskMode === "empty" ? 2 : 0;
}

function frameModeCode(st) {
    return st.frameMode === "range" ? 2 : st.frameMode === "last" ? 3 : 1;
}

function frameModeFromCropState(widgets) {
    const val = widgets.cropState?.value ?? "";
    if (!val) return null;
    const parts = val.split(",").map(Number);
    if (parts.length < 33 || parts.some(isNaN)) return null;
    return parts[32] === 2 ? "range" : parts[32] === 3 ? "last" : parts[32] === 1 ? "single" : null;
}

function frameSelectLooksRange(value) {
    const parts = String(value || "").split(",").map(Number);
    return parts.length >= 2 && !parts.slice(0, 2).some(isNaN) && parts[0] !== parts[1];
}

function clampMaskNumber(value, lo, hi, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
}

export function syncWidgets(st, widgets, node) {
    // No-Selection: emit a crop that exactly covers the source frame, so the
    // backend resizes the whole image without adding padded regions. We bypass
    // the grid quantization here to use the full, true source extent.
    if (widgets.cropState) {
        if (st.hasFrameData) {
            const raw = crToSrc(st.cr, st.sf, st.scale);
            const s = (st.noSelect || isFullSourceRect(raw, st))
                ? { x: 0, y: 0, w: st.srcW, h: st.srcH }
                : quantizeSrc(raw);
            widgets.cropState.value =
                `${s.x},${s.y},${s.w},${s.h},${st.outW},${st.outH},${st.arLocked ? 1 : 0},` +
                `${st.resMode === "mp" ? 1 : 0},${Math.round(st.targetMP * 100)},${st.noSelect ? 1 : 0},${st.divisor || GRID},` +
                `${st.rotate || 0},${st.flipX ? 1 : 0},${st.flipY ? 1 : 0},0,` +   // field 14: retired output target, kept 0
                // Raw input dims this crop was computed against. The backend compares
                // them to the actual input: a mismatch means the canvas hasn't seen the
                // new input yet (first run after a change), so it does a full-frame pass
                // instead of applying this stale crop and clipping the output.
                `${st.rawW || 0},${st.rawH || 0},${st.paddingEnabled === false ? 0 : 1},${st.frameCount || 0},${st.mediaSig || 0},` +
                // [20] currently-viewed scrubber frame. Persisted here (not
                // node.properties) so it rides the same reliable widget path as
                // the rest; media_sig above gates it to the same input on restore.
                `${st.viewFrame || 0},` +
                // [21..24] fixed-duration range mode: enabled, fps*100,
                // seconds*10, active edge (0=in, 1=out).
                `${st.fixedRange ? 1 : 0},${Math.round((st.fixedRangeFps || DEFAULT_FPS) * 100)},${Math.round((st.fixedRangeSeconds || 5) * 10)},${st.fixedRangeActiveEdge === "out" ? 1 : 0},` +
                // [25] fine rotation offset, [26] mask mode (0=both, 1=input, 2=empty),
                // [27] invert output_mask, [28] feather UI value, [29] grow UI value,
                // [30] threshold * 1000 (0 disables thresholding), [31] manual
                // resolution lock, [32] explicit frame mode (1=single,2=range,3=last).
                `${Math.round(st.fineRotate || 0)},${maskModeCode(st)},${st.maskInvert ? 1 : 0},` +
                `${Math.round(clampMaskNumber(st.maskFeather, 0, 99))},${Math.round(clampMaskNumber(st.maskGrow, -99, 99))},${Math.round(clampMaskNumber(st.maskThreshold, 0, 1) * 1000)},${st.resLocked ? 1 : 0},${frameModeCode(st)}`;
        } else if (!st._fromWorkflow) {
            // Fresh nodes have no real source dimensions before their first run.
            // Keep output/mode flags, but submit an unset crop so Python uses its
            // full-frame fallback instead of the placeholder square preview crop.
            widgets.cropState.value =
                `0,0,0,0,${st.outW},${st.outH},${st.arLocked ? 1 : 0},` +
                `${st.resMode === "mp" ? 1 : 0},${Math.round(st.targetMP * 100)},${st.noSelect ? 1 : 0},${st.divisor || GRID},` +
                `${st.rotate || 0},${st.flipX ? 1 : 0},${st.flipY ? 1 : 0},0,0,0,${st.paddingEnabled === false ? 0 : 1},0,0,${st.viewFrame || 0},` +
                `${st.fixedRange ? 1 : 0},${Math.round((st.fixedRangeFps || DEFAULT_FPS) * 100)},${Math.round((st.fixedRangeSeconds || 5) * 10)},${st.fixedRangeActiveEdge === "out" ? 1 : 0},` +
                `${Math.round(st.fineRotate || 0)},${maskModeCode(st)},${st.maskInvert ? 1 : 0},` +
                `${Math.round(clampMaskNumber(st.maskFeather, 0, 99))},${Math.round(clampMaskNumber(st.maskGrow, -99, 99))},${Math.round(clampMaskNumber(st.maskThreshold, 0, 1) * 1000)},${st.resLocked ? 1 : 0},${frameModeCode(st)}`;
        }
    }
    if (widgets.padColor)
        widgets.padColor.value = st.padColor;
    if (widgets.customPadColor)
        widgets.customPadColor.value = st.customPadColor;
    if (widgets.frameSelect) {
        const preservingRestoredRange = !st.hasFrameData
            && st._fromWorkflow
            && (frameModeFromCropState(widgets) === "range" || frameSelectLooksRange(widgets.frameSelect.value))
            && String(widgets.frameSelect.value || "").includes(",");
        if (!preservingRestoredRange) {
            widgets.frameSelect.value = (!st.hasFrameData && !st._fromWorkflow) ? ""
              : st.frameMode === "last"   ? "last"
              : st.frameMode === "single" ? `${st.frameIn},${st.frameIn}`
              : st.frameMode === "range"  ? `${st.frameIn},${st.frameOut}`
              : "";
        }
    }
    if (widgets.passthrough)
        widgets.passthrough.value = st.passthrough ? "1" : "0";
    if (node.graph) node.graph.setDirtyCanvas(true, true);
}

// ── AR lock helper ────────────────────────────────────────────────────

export function setArLocked(st, dom, locked) {
    st.arLocked = locked;
    if (locked) st.cropAR = st.cr.w / st.cr.h;
    dom.arBtn.classList.toggle("is-locked", locked);
    dom.arBtn.title = locked ? "Unlock aspect ratio" : "Lock aspect ratio";
    setControlActive(dom.arBtn, locked);
    dom.arBtn._active        = locked;
}

// ── Frame select + passthrough UI ─────────────────────────────────────

/** Clamp IN/OUT to valid frame indices and enforce IN <= OUT. */
export function clampFrameSel(st) {
    const maxF = Math.max(0, st.frameCount - 1);
    st.frameIn  = clamp(Math.round(st.frameIn),  0, maxF);
    st.frameOut = clamp(Math.round(st.frameOut), 0, maxF);
    if (st.frameOut < st.frameIn) st.frameOut = st.frameIn;
}

/** Reflect frame-select mode / passthrough state into the toggle buttons,
 *  the per-mode rows, the range highlight, and the dimming of the crop rows. */
export function updateFrameSelUI(st, dom) {
    clampFrameSel(st);
    const maxF = Math.max(0, st.frameCount - 1);
    const m = st.frameMode;

    // Toggle button appearance. Active state is shown by color/border/background
    // only — no check-box glyph (its width changes on toggle and shifts the row).
    const setToggle = (btn, active, label) => {
        btn.textContent = label;
        setControlActive(btn, active);
    };
    setToggle(dom.singleBtn, m === "single", "SINGLE FRAME");
    setToggle(dom.rangeBtn, m === "range", "RANGE");
    setToggle(dom.lastFrameBtn, m === "last", "LAST FRAME");
    setToggle(dom.noSelBtn, st.noSelect, "NO SELECTION");
    setToggle(dom.passBtn, st.passthrough, "PASSTHROUGH");
    // Passthrough ignores frame selection: the frame modes dim (still settable, for when
    // passthrough goes off).
    for (const btn of [dom.singleBtn, dom.rangeBtn, dom.lastFrameBtn]) {
        btn.style.opacity = st.passthrough ? "0.45" : "";
    }
    dom.loopBtn?.classList.toggle("is-on", !!st.playbackLoop);

    // Per-mode rows.
    dom.singleRow.style.display = "flex";
    dom.selRow.style.display    = "flex";
    dom.selSpan.style.display   = m === "range"  ? "block" : "none";

    const rangeActive = m === "range";
    const fixedActive = rangeActive && st.fixedRange;
    const inPct  = maxF ? (st.frameIn  / maxF) * 100 : 0;
    const outPct = maxF ? (st.frameOut / maxF) * 100 : 0;
    dom.selSpan.style.left  = inPct + "%";
    dom.selSpan.style.width = (outPct - inPct) + "%";
    dom.scrubWrap.classList.toggle("is-range-editing", rangeActive);
    dom.fixedInHandle.style.display = rangeActive ? "block" : "none";
    dom.fixedOutHandle.style.display = rangeActive ? "block" : "none";
    dom.fixedInHandle.style.left = inPct + "%";
    dom.fixedOutHandle.style.left = outPct + "%";
    dom.fixedInHandle.classList.toggle("is-active", rangeActive && st.fixedRangeActiveEdge !== "out");
    dom.fixedOutHandle.classList.toggle("is-active", rangeActive && st.fixedRangeActiveEdge === "out");
    if (document.activeElement !== dom.singleInput) dom.singleInput.value = dom.scrubber.value;
    if (document.activeElement !== dom.inInput)  dom.inInput.value  = st.frameIn;
    if (document.activeElement !== dom.outInput) dom.outInput.value = st.frameOut;
    dom.singleInput.max = maxF;
    dom.inInput.max = maxF;
    dom.outInput.max = maxF;
    dom.selReadout.textContent = (st.frameIn === st.frameOut)
        ? `IN/OUT ${st.frameIn}`
        : st.fixedRange && m === "range"
            ? `${st.fixedRangeActiveEdge === "out" ? "OUT" : "IN"} ${fixedRangePreviewFrame(st)} | ${st.frameIn} → ${st.frameOut} (${st.frameOut - st.frameIn + 1})`
            : `IN ${st.frameIn} → OUT ${st.frameOut} (${st.frameOut - st.frameIn + 1} frames)`;

    dom.singleRow.style.opacity = m === "single" && !st.passthrough ? "" : "0.45";
    dom.selRow.style.opacity = m === "range" && !st.passthrough ? "" : "0.45";
    setControlActive(dom.fixedRangeBtn, fixedActive);
    dom.fixedRangeBtn.title = fixedActive
        ? "Fixed range on: drag the green range or either endpoint"
        : "Fixed range off: drag endpoints independently";
    dom.fixedFpsInput.disabled = false;
    dom.fixedFpsInput.min = 1;
    dom.fixedFpsInput.max = 99;
    dom.fixedFpsInput.step = 1;
    dom.fixedFpsInput.style.opacity = "";
    dom.fixedFpsInput.style.pointerEvents = "";
    dom.fixedFpsInput.title = "Playback, fixed-range duration, and audio-sync FPS";
    dom.fixedSecInput.disabled = !fixedActive;
    dom.fixedSecInput.style.opacity = fixedActive ? "" : "0.38";
    dom.fixedSecInput.style.pointerEvents = fixedActive ? "" : "none";
    if (document.activeElement !== dom.fixedFpsInput) {
        dom.fixedFpsInput.value = Math.round(st.fixedRangeFps || DEFAULT_FPS);
    }
    if (document.activeElement !== dom.fixedSecInput) {
        dom.fixedSecInput.value = (Math.round((st.fixedRangeSeconds || 5) * 10) / 10).toFixed(1);
    }

    // Passthrough disables everything below (no crop, no resize). No-Selection
    // disables only the crop-shaping rows — output sizing still applies.
    const dimCrop = st.passthrough || st.noSelect;  // crop W/H, presets, snap
    const dimOut  = st.passthrough;                  // output size + megapixels
    if (dom.xformRow) {
        dom.xformRow.style.opacity = st.passthrough ? "0.35" : "";
        dom.xformRow.style.pointerEvents = st.passthrough ? "none" : "";
    }
    for (const row of [dom.cropSizeRow, dom.presetRow, dom.snapRow]) {
        row.style.opacity = dimCrop ? "0.35" : "";
        row.style.pointerEvents = dimCrop ? "none" : "";
    }
    for (const row of [dom.outputModeRow, dom.outSizeRow, dom.padColorRow]) {
        row.style.opacity = dimOut ? "0.35" : "";
        row.style.pointerEvents = dimOut ? "none" : "";
    }
    dom.mpRow.style.opacity = dimOut ? "0.35" : (st.resMode === "mp" ? "" : "0.45");
    dom.mpRow.style.pointerEvents = dimOut ? "none" : (st.resMode === "mp" ? "" : "none");
    updateOutputReadout(st, dom);
}

/** Reflect flip/rotate state into the transform-row buttons. */
export function updateXformUI(st, dom) {
    const disabled = !!st.passthrough;
    if (disabled) st._angleEditor?.close(true);
    const setT = (btn, active, label) => {
        btn.textContent = label;
        btn.disabled = disabled;
        btn.title = disabled ? "Disabled in Passthrough mode" : label.includes("Flip H")
            ? "Mirror horizontally (left↔right)"
            : "Mirror vertically (top↔bottom)";
        setControlActive(btn, !disabled && active);
    };
    setT(dom.flipHBtn, st.flipX, "⇄ Flip H");
    setT(dom.flipVBtn, st.flipY, "⇅ Flip V");
    const coarse = st.rotate || 0;
    const fine = Math.round(st.fineRotate || 0);
    let total = ((((coarse + fine + 180) % 360) + 360) % 360) - 180;
    if (total === -180) total = 180;
    if (Object.is(total, -0)) total = 0;
    if (dom.rotateAngleBtn) {
        dom.rotateAngleBtn.textContent = `${total}°`;
        dom.rotateAngleBtn.disabled = disabled;
        dom.rotateAngleBtn.classList.toggle("is-disabled", disabled);
        dom.rotateAngleBtn.title = disabled ? "Disabled in Passthrough mode" : "Fine rotation: type an angle or use the slider";
        setControlActive(dom.rotateAngleBtn, !disabled && (coarse !== 0 || fine !== 0));
    }
    if (dom.rotatePrevBtn) {
        dom.rotatePrevBtn.disabled = disabled;
        dom.rotatePrevBtn.title = disabled ? "Disabled in Passthrough mode" : "Rotate -5°";
    }
    if (dom.rotateNextBtn) {
        dom.rotateNextBtn.disabled = disabled;
        dom.rotateNextBtn.title = disabled ? "Disabled in Passthrough mode" : "Rotate +5°";
    }
}

export function updateMaskUI(st, dom) {
    const mode = st.maskMode === "input" || st.maskMode === "empty" ? st.maskMode : "both";
    setControlActive(dom.maskInputBtn, mode === "input");
    setControlActive(dom.maskEmptyBtn, mode === "empty");
    setControlActive(dom.maskInvertBtn, !!st.maskInvert);
    if (document.activeElement !== dom.featherInput) {
        dom.featherInput.value = Math.round(clampMaskNumber(st.maskFeather, 0, 99));
    }
    if (document.activeElement !== dom.growInput) {
        dom.growInput.value = Math.round(clampMaskNumber(st.maskGrow, -99, 99));
    }
    if (document.activeElement !== dom.thresholdInput) {
        const value = clampMaskNumber(st.maskThreshold, 0, 1);
        dom.thresholdInput.value = value > 0 ? value.toFixed(2) : "0";
    }
}

/** Reflect output-resolution mode (manual / megapixels) into the controls:
 *  toggle the MP row, lock the W/H inputs in MP mode, and show the resulting
 *  resolution + actual MP readout and active preset chip. */
export function updateResUI(st, dom) {
    if (st.resLocked) {
        st.resMode = "manual";
        st.divisor = 1;
    }
    const mp = st.resMode === "mp";
    dom.resModeSelect.value = st.resMode;
    dom.divSelect.value = String(st.divisor || GRID);
    dom.resModeButton.textContent = mp ? "MP" : "RES";
    setControlActive(dom.resModeButton, mp);
    dom.divButton.textContent = (st.divisor || GRID) === 1 ? "OFF" : String(st.divisor || GRID);
    // The exact resolution lock pins the divisor OFF.
    const divLocked = !!st.resLocked;
    dom.divSelect.disabled = divLocked;
    dom.divSelect.style.opacity = divLocked ? "0.55" : "";
    dom.divButton.disabled = divLocked;
    dom.divButton.style.opacity = divLocked ? "0.55" : "";
    dom.divSelect.title = st.resLocked
            ? "Locked OFF by exact output resolution lock"
        : "Round output width/height to a multiple of this. 32 is the safest default; 16 is usually fine for image models and WAN-style video.";
    dom.divButton.title = dom.divSelect.title;
    dom.outWInput.step = st.divisor || GRID;
    dom.outHInput.step = st.divisor || GRID;
    const g = st.divisor || GRID;
    const lockDisabled = mp || st.passthrough || st.noSelect || st.outW < g || st.outH < g;
    dom.resLockBtn.disabled = lockDisabled;
    dom.resLockBtn.classList.toggle("is-locked", !!st.resLocked && !lockDisabled);
    dom.resLockBtn.style.opacity = lockDisabled ? "0.45" : "";
    dom.resLockBtn.style.cursor = lockDisabled ? "not-allowed" : "";
    dom.resLockBtn.title = lockDisabled
        ? "Available in RES mode with crop/pad output sizing"
        : st.resLocked
            ? "Exact output W/H locked across input changes"
            : "Lock exact output W/H across input changes";
    setControlActive(dom.resLockBtn, !!st.resLocked && !lockDisabled);
    dom.mpRow.style.display = "flex";
    dom.mpRow.style.opacity = mp ? "" : "0.45";
    dom.mpRow.style.pointerEvents = mp ? "" : "none";
    updateOutputReadout(st, dom);
    for (const inp of [dom.outWInput, dom.outHInput]) {
        inp.readOnly = mp;
        inp.style.opacity = mp ? "0.55" : "";
        inp.style.cursor = mp ? "not-allowed" : "";
    }
    if (mp) {
        if (document.activeElement !== dom.mpInput) dom.mpInput.value = formatTargetMP(st.targetMP);
    } else if (document.activeElement !== dom.mpInput) {
        dom.mpInput.value = formatTargetMP(st.targetMP);
    }
}

/** Read frame_select / passthrough widget values into state (workflow load).
 *  Empty/legacy frame_select is treated as single frame 0 for safety. Newer
 *  crop_state values persist frame mode explicitly so Range survives temporary
 *  equal/clamped endpoints during workflow restore. */
export function restoreFrameSelFromWidgets(st, widgets) {
    const v = widgets.frameSelect?.value ?? "";
    const explicitMode = frameModeFromCropState(widgets);
    if (v === "last") {
        st.frameMode = "last";
    } else {
        const p = v ? v.split(",").map(Number) : [];
        if (p.length >= 2 && !p.some(isNaN)) {
            st.frameIn = p[0];
            st.frameOut = p[1];
            // IN == OUT persists as single-frame mode (semantically one frame).
            st.frameMode = (p[0] === p[1]) ? "single" : "range";
        } else {
            st.frameMode = "single";
            st.frameIn = 0;
            st.frameOut = 0;
        }
    }
    if (explicitMode) {
        st.frameMode = explicitMode;
        if (explicitMode === "single") st.frameOut = st.frameIn;
    }
    st.passthrough = (widgets.passthrough?.value ?? "0") === "1";
}

export function updatePadColorUI(st, dom) {
    dom.padColorSelect.value = st.padColor;
    dom.customPadColorInput.style.display = "none";
    dom.customPadColorInput.value = st.customPadColor;
    setControlActive(dom.paddingBtn, st.paddingEnabled !== false);
    dom.paddingBtn.textContent = st.paddingEnabled === false ? "OFF" : "ON";
    dom.paddingBtn.title = st.paddingEnabled === false
        ? "Padding disabled: selection stays inside the image"
        : "Padding enabled: selection can extend outside the image";
    for (const btn of dom.padColorBtns) {
        const active = btn.dataset.padColor === st.padColor
            && (st.padColor !== "custom" || btn.dataset.customPadColor === st.customPadColor);
        btn.disabled = st.paddingEnabled === false;
        btn.style.opacity = st.paddingEnabled === false ? "0.32" : "";
        btn.style.pointerEvents = st.paddingEnabled === false ? "none" : "";
        btn.classList.toggle("is-active", active);
        btn.style.removeProperty("background");
        btn.style.removeProperty("color");
        if (active) {
            btn.style.setProperty("border-color", "rgba(var(--krc-accent-purple-a-rgb), 0.95)", "important");
            btn.style.setProperty("box-shadow", "0 0 0 2px rgba(var(--krc-accent-purple-a-rgb), 0.92), 0 0 0 4px rgba(var(--krc-black-rgb), 0.28)", "important");
        } else {
            btn.style.removeProperty("border-color");
            btn.style.removeProperty("box-shadow");
        }
    }
}
