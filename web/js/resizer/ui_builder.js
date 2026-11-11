import { CONTROL_W, DEFAULT_FPS, FIXED_DOM_H, FIXED_DOM_W, GRID, PREVIEW_SIZE } from "./constants.js";
import { mkBtn, mkEl } from "./dom_helpers.js";
import { injectStyles } from "./styles.js";
import { buildMaskUI } from "./mask_ui.js";

// Wrap a number input with a custom up/down stepper. We hide the browser's
// native spinner (which each engine draws differently — Firefox's is bulky and
// off-theme) and overlay our own buttons at the field's right edge. The field
// reserves padding so the right-aligned digits never sit under the arrows, and
// its width is unchanged (border-box), so row layout is unaffected. Buttons use
// native stepUp/stepDown (respecting min/step, incl. divisor=1) then dispatch a
// `change` event so the input's existing handler runs untouched. Returns the
// wrapper to place where the bare input used to go; the input ref is unchanged.
function wrapWithStepper(input) {
    input.classList.add("krc-rz-input--stepper");
    const wrap = mkEl("span", "");
    wrap.className = "krc-rz-num-stepper";
    const arrows = mkEl("span", "");
    arrows.className = "krc-rz-num-stepper-arrows";

    const mkArrow = (glyph, dir) => {
        const btn = mkEl("button", "", { type: "button", tabIndex: -1 });
        const glyphEl = mkEl("span", "");
        glyphEl.className = `krc-rz-num-stepper-glyph ${dir > 0 ? "is-up" : "is-down"}`;
        glyphEl.textContent = glyph;
        btn.appendChild(glyphEl);
        btn.setAttribute("aria-label", dir > 0 ? "Increase" : "Decrease");
        let holdTimer = null, repeatTimer = null;
        const step = () => {
            if (input.disabled) return;
            dir > 0 ? input.stepUp() : input.stepDown();
            input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const stop = () => {
            clearTimeout(holdTimer); clearInterval(repeatTimer);
            holdTimer = repeatTimer = null;
        };
        btn.addEventListener("pointerdown", (e) => {
            e.preventDefault();              // don't steal focus/selection
            step();                          // immediate step on press
            holdTimer = setTimeout(() => {   // then auto-repeat while held
                repeatTimer = setInterval(step, 60);
            }, 400);
        });
        for (const ev of ["pointerup", "pointerleave", "pointercancel"])
            btn.addEventListener(ev, stop);
        return btn;
    };

    arrows.append(mkArrow("▴", 1), mkArrow("▾", -1));
    wrap.append(input, arrows);
    return wrap;
}

export function buildUI() {
    injectStyles();
    // ── Root container ──
    const root = mkEl("div", `width:${FIXED_DOM_W}px;height:${FIXED_DOM_H}px;box-sizing:border-box;padding:0;font-family:system-ui,sans-serif;font-size:12px;color:#ccc;`);
    root.className = "krc-node krc-resizer krc-solo-widget";
    const body = mkEl("div", `display:grid;width:${FIXED_DOM_W}px;height:${FIXED_DOM_H}px;grid-template-columns:minmax(${PREVIEW_SIZE}px,1fr) ${CONTROL_W}px;gap:10px;align-items:stretch;`);
    body.className = "krc-rz-body";
    const previewCol = mkEl("div", `display:flex;flex-direction:column;gap:8px;min-width:${PREVIEW_SIZE}px;`);
    previewCol.className = "krc-rz-preview-col";
    const controlsCol = mkEl("div", `display:flex;flex-direction:column;gap:7px;width:${CONTROL_W}px;min-width:${CONTROL_W}px;max-width:${CONTROL_W}px;`);
    controlsCol.className = "krc-rz-controls";

    // ── Canvas area ──
    const wrap = mkEl("div", `position:relative;width:${PREVIEW_SIZE}px;height:${PREVIEW_SIZE}px;min-height:${PREVIEW_SIZE}px;background:rgba(var(--krc-surface-low-rgb,24,24,24),0.96);border:1px solid rgba(var(--krc-border-rgb,100,92,150),0.58);border-radius:8px;overflow:hidden;user-select:none;touch-action:none;cursor:default;`);
    wrap.className = "krc-rz-preview";

    // Source frame (holds actual frame image)
    const sfEl = mkEl("div", "position:absolute;background:#222;overflow:hidden;border:1px solid #333;display:none;");
    sfEl.className = "krc-rz-source-frame";

    const frameImg = mkEl("img", "position:absolute;inset:0;width:100%;height:100%;object-fit:fill;display:none;");
    frameImg.alt = "";

    const noDataMsg = mkEl("div", "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;color:rgba(255,255,255,0.2);pointer-events:none;text-align:center;padding:8px;");
    noDataMsg.className = "krc-rz-empty";
    noDataMsg.textContent = "Run node to enable preview";

    sfEl.append(frameImg);

    // Pad preview layers.
    const mkPadOverlay = () => mkEl("div", "position:absolute;pointer-events:none;display:none;");
    const padFill = mkPadOverlay();
    padFill.className = "krc-rz-pad-fill";
    const [padTop, padBot, padLeft, padRight] = [mkPadOverlay(), mkPadOverlay(), mkPadOverlay(), mkPadOverlay()];

    // Crop/output box
    const cropBox = mkEl("div", "position:absolute;cursor:move;");
    cropBox.className = "krc-rz-crop-box";


    // Corner handles
    const HBASE = "position:absolute;width:11px;height:11px;";
    const corners = {
        tl: mkEl("div", HBASE + "top:0;left:0;transform:translate(-50%,-50%);cursor:nw-resize;"),
        tr: mkEl("div", HBASE + "top:0;right:0;transform:translate(50%,-50%);cursor:ne-resize;"),
        bl: mkEl("div", HBASE + "bottom:0;left:0;transform:translate(-50%,50%);cursor:sw-resize;"),
        br: mkEl("div", HBASE + "bottom:0;right:0;transform:translate(50%,50%);cursor:se-resize;"),
    };
    for (const [dir, el] of Object.entries(corners)) {
        el.dataset.dir = dir;
        el.className = "krc-rz-handle krc-rz-corner-handle";
        cropBox.appendChild(el);
    }

    // Edge midpoint resize handles
    const EBASE = "position:absolute;pointer-events:auto;";
    const edges = {
        t: mkEl("div", EBASE + "width:18px;height:7px;top:0;left:50%;transform:translate(-50%,-50%);cursor:n-resize;"),
        b: mkEl("div", EBASE + "width:18px;height:7px;bottom:0;left:50%;transform:translate(-50%,50%);cursor:s-resize;"),
        l: mkEl("div", EBASE + "width:7px;height:18px;left:0;top:50%;transform:translate(-50%,-50%);cursor:w-resize;"),
        r: mkEl("div", EBASE + "width:7px;height:18px;right:0;top:50%;transform:translate(50%,-50%);cursor:e-resize;"),
    };
    for (const [dir, el] of Object.entries(edges)) {
        el.dataset.dir = dir;
        el.className = "krc-rz-handle krc-rz-edge-handle";
        cropBox.appendChild(el);
    }

    // Viewport: receives the centered preview transform and contains image-space elements.
    const viewport = mkEl("div", "position:absolute;inset:0;transform-origin:0 0;");
    viewport.append(padFill, sfEl, padTop, padBot, padLeft, padRight);
    wrap.append(viewport, cropBox, noDataMsg);

    // ── Controls ──
    const ctrl = controlsCol;
    const label = (text, extraClass = "") => {
        const el = mkEl("div", "");
        el.className = `krc-rz-section-title${extraClass ? ` ${extraClass}` : ""}`;
        el.textContent = text;
        return el;
    };

    // ── Crop Size Row ──
    const cropSizeRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    cropSizeRow.className = "krc-rz-row krc-rz-crop-size-row";
    const INPUT_CSS =
        "width:58px;padding:2px 5px;font-size:11px;font-family:monospace;" +
        "background:#1e1e1e;color:#ccc;border:1px solid #444;border-radius:4px;text-align:right;";
    const wLabel = mkEl("span", "font-size:10px;color:#999;"); wLabel.textContent = "W";
    const wInput = mkEl("input", INPUT_CSS, { type: "number", min: GRID, step: GRID, value: 1280 });
    wInput.className = "krc-rz-input";
    const hLabel = mkEl("span", "font-size:10px;color:#999;"); hLabel.textContent = "H";
    const hInput = mkEl("input", INPUT_CSS, { type: "number", min: GRID, step: GRID, value: 720 });
    hInput.className = "krc-rz-input";
    const arBtn = mkEl("button",
        "padding:3px 9px;font-size:11px;border:1px solid #444;border-radius:5px;" +
        "background:#2a2a2a;color:#bbb;cursor:pointer;"
    );
    arBtn.className = "krc-rz-button krc-rz-icon-button krc-rz-lock-button";
    arBtn.textContent = ""; arBtn._active = false; arBtn.title = "Lock aspect ratio";
    const resetBtn = mkBtn("reset");
    resetBtn.className = "krc-rz-button krc-rz-icon-button krc-rz-reset-button";
    resetBtn.textContent = "↺";
    resetBtn.title = "Reset all image adjustments.";
    const fullBtn = mkBtn("FULL");
    fullBtn.className = "krc-rz-button krc-rz-full-button";
    fullBtn.title = "Select the full source frame";
    cropSizeRow.append(fullBtn, resetBtn, arBtn, wLabel, wrapWithStepper(wInput), hLabel, wrapWithStepper(hInput));

    // ── Preset Chips Row ──
    const CHIP_PRESETS = [
        ["1:1",   960,  960], ["2:3",   720, 1080], ["3:2",  1080,  720], ["3:4",   720,  960],
        ["4:3",   960,  720], ["9:16",  720, 1280], ["16:9", 1280,  720], ["21:9", 1344,  576],
    ];
    const CHIP_CSS = "padding:2px 7px;font-size:10px;font-family:monospace;" +
        "border:1px solid #444;border-radius:12px;background:#222;color:#999;" +
        "cursor:pointer;white-space:nowrap;flex-shrink:0;";
    const presetRow = mkEl("div", "display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;overflow:hidden;padding-bottom:0;");
    presetRow.className = "krc-rz-chip-row krc-rz-ratio-strip";
    const chipBtns = CHIP_PRESETS.map(([label, w, h]) => {
        const btn = mkEl("button", CHIP_CSS);
        btn.className = "krc-rz-chip";
        btn.textContent = label;
        btn.dataset.chipW = w; btn.dataset.chipH = h; btn.dataset.chipAR = w / h;
        presetRow.appendChild(btn);
        return btn;
    });

    // ── Snap Buttons (compact d-pad + fit stack) ──
    const snapRow = mkEl("div", "");
    snapRow.className = "krc-rz-row krc-rz-snap-row";
    const SNAP_DEFS = [
        ["center","◎"], ["top","▲"], ["bottom","▼"],
        ["left","◀"], ["right","▶"], ["fitW","FIT\nWIDTH"], ["fitH","FIT\nHEIGHT"],
    ];
    const snapByKey = {};
    const snapBtns = SNAP_DEFS.map(([key, label]) => {
        const b = mkEl("button", "padding:0;font-size:10px;border:1px solid #444;background:#2a2a2a;color:#bbb;cursor:pointer;white-space:nowrap;");
        b.className = "krc-rz-button krc-rz-snap-button";
        b.textContent = label; b.dataset.snap = key;
        snapByKey[key] = b;
        return b;
    });
    const snapCluster = mkEl("div", "");
    snapCluster.className = "krc-rz-snap-cluster";
    const snapPad = mkEl("div", "");
    snapPad.className = "krc-rz-dpad";
    snapPad.append(
        mkEl("div", ""),
        snapByKey.top,
        mkEl("div", ""),
        snapByKey.left,
        snapByKey.center,
        snapByKey.right,
        mkEl("div", ""),
        snapByKey.bottom,
        mkEl("div", ""),
    );
    const fitStack = mkEl("div", "");
    fitStack.className = "krc-rz-fit-stack";
    fitStack.append(snapByKey.fitW, snapByKey.fitH);
    snapCluster.append(snapPad, fitStack);
    snapRow.append(snapCluster);

    // ── Mode grid (3 × 2): frame modes, their variants, output overrides ──
    //   SINGLE FRAME  LAST FRAME    DISABLE
    //   RANGE         NO SELECTION  PASSTHROUGH
    const TOGGLE_CSS = "padding:2px 9px;font-size:10px;border:1px solid #444;border-radius:12px;" +
        "background:#222;color:#999;cursor:pointer;white-space:nowrap;";
    const toggleRow = mkEl("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap;");
    toggleRow.className = "krc-rz-chip-row krc-rz-mode-row";
    const singleBtn    = mkEl("button", TOGGLE_CSS); singleBtn.textContent    = "SINGLE FRAME";
    singleBtn.className = "krc-rz-chip krc-rz-toggle";
    singleBtn.title = "Output one frame — scrub the slider to choose it (what you preview is the output).";
    const rangeBtn     = mkEl("button", TOGGLE_CSS); rangeBtn.textContent     = "RANGE";
    rangeBtn.className = "krc-rz-chip krc-rz-toggle";
    rangeBtn.title = "Output a contiguous IN→OUT range of frames.";
    const lastFrameBtn = mkEl("button", TOGGLE_CSS); lastFrameBtn.textContent = "LAST FRAME";
    lastFrameBtn.className = "krc-rz-chip krc-rz-toggle";
    lastFrameBtn.title = "Always output only the last frame of the input (a single-frame input is its own last frame).";
    const noSelBtn     = mkEl("button", TOGGLE_CSS); noSelBtn.textContent     = "NO SELECTION";
    noSelBtn.className = "krc-rz-chip krc-rz-toggle";
    noSelBtn.title = "No crop window: resize the whole frame to the output size while preserving the source aspect ratio.";
    const passBtn      = mkEl("button", TOGGLE_CSS); passBtn.textContent      = "PASSTHROUGH";
    passBtn.className = "krc-rz-chip krc-rz-toggle";
    passBtn.title = "Pass the input through untouched: every frame, the audio and the mask as they came in (frame selection, transform, crop, size and mask settings are ignored).";
    // DISABLE: leaves the node out of the run (ComfyUI's Mute, Ctrl+M); wired in disable_control.js.
    const disableBtn   = mkEl("button", TOGGLE_CSS); disableBtn.textContent   = "DISABLE";
    disableBtn.className = "krc-rz-chip krc-rz-toggle krc-rz-disable-button";
    toggleRow.append(singleBtn, lastFrameBtn, disableBtn, rangeBtn, noSelBtn, passBtn);

    // ── Transform row (flip / rotate) ──
    const xformRow = mkEl("div", "display:flex;align-items:center;gap:6px;flex-wrap:wrap;");
    xformRow.className = "krc-rz-chip-row krc-rz-transform-row";
    const flipHBtn  = mkEl("button", TOGGLE_CSS); flipHBtn.textContent  = "⇄ Flip H";
    flipHBtn.className = "krc-rz-chip krc-rz-toggle";
    flipHBtn.title = "Mirror horizontally (left↔right). Disabled in Passthrough mode.";
    const flipVBtn  = mkEl("button", TOGGLE_CSS); flipVBtn.textContent  = "⇅ Flip V";
    flipVBtn.className = "krc-rz-chip krc-rz-toggle";
    flipVBtn.title = "Mirror vertically (top↔bottom). Disabled in Passthrough mode.";
    const rotateGroup = mkEl("div", "");
    rotateGroup.className = "krc-rz-rotate-group";
    const rotatePrevBtn = mkEl("button", "", { type: "button" });
    rotatePrevBtn.className = "krc-rz-rotate-part krc-rz-rotate-step krc-rz-rotate-prev";
    rotatePrevBtn.textContent = "‹";
    rotatePrevBtn.title = "Rotate 90° counter-clockwise";
    const rotateAngleBtn = mkEl("button", "", { type: "button" });
    rotateAngleBtn.className = "krc-rz-rotate-part krc-rz-rotate-angle";
    rotateAngleBtn.textContent = "0°";
    rotateAngleBtn.title = "Fine rotation: type an angle or use the slider.";
    const rotateNextBtn = mkEl("button", "", { type: "button" });
    rotateNextBtn.className = "krc-rz-rotate-part krc-rz-rotate-step krc-rz-rotate-next";
    rotateNextBtn.textContent = "›";
    rotateNextBtn.title = "Rotate 90° clockwise";
    rotateGroup.append(rotatePrevBtn, rotateAngleBtn, rotateNextBtn);
    xformRow.append(flipHBtn, flipVBtn, rotateGroup);

    const {
        maskModeRow,
        maskAdjustRow,
        maskInputBtn,
        maskEmptyBtn,
        maskInvertBtn,
        featherInput,
        featherMenuBtn,
        growInput,
        growMenuBtn,
        thresholdInput,
        thresholdMenuBtn,
    } = buildMaskUI({ toggleCss: TOGGLE_CSS, inputCss: INPUT_CSS });

    // ── Frame scrubber (with IN/OUT markers overlaid on the track) ──
    const framePanel = mkEl("div", "");
    framePanel.className = "krc-rz-frame-panel";
    const scrubRow = mkEl("div", "display:flex;align-items:center;gap:7px;");
    scrubRow.className = "krc-rz-frame-row krc-rz-frame-slider-row";
    const scrubIdx = mkEl("span", "font-size:10px;font-family:monospace;color:#999;text-align:center;");
    scrubIdx.className = "krc-rz-frame-ticker";
    scrubIdx.textContent = "0 / 0";
    const scrubWrap = mkEl("div", "position:relative;flex:1;height:18px;display:flex;align-items:center;");
    scrubWrap.className = "krc-rz-scrub-wrap";
    const scrubber = mkEl("input", "width:100%;cursor:pointer;margin:0;", { type: "range", min: 0, max: 0, value: 0 });
    scrubber.className = "krc-rz-scrubber";
    // Highlight of the selected IN→OUT range. In Range mode the bar and endpoint
    // handles own range editing; Single/Last keep the native scrubber behavior.
    const selSpan  = mkEl("div", "position:absolute;top:50%;height:6px;transform:translateY(-50%);" +
        "background:rgba(80,150,255,0.35);border-radius:3px;pointer-events:none;display:none;");
    selSpan.className = "krc-rz-selection-span";
    const fixedInHandle = mkEl("div", "");
    fixedInHandle.className = "krc-rz-fixed-handle krc-rz-fixed-in";
    fixedInHandle.dataset.edge = "in";
    fixedInHandle.title = "Range start";
    const fixedOutHandle = mkEl("div", "");
    fixedOutHandle.className = "krc-rz-fixed-handle krc-rz-fixed-out";
    fixedOutHandle.dataset.edge = "out";
    fixedOutHandle.title = "Range end";
    scrubWrap.append(scrubber, selSpan, fixedInHandle, fixedOutHandle);
    const frameStepper = mkEl("div", "");
    frameStepper.className = "krc-rz-frame-stepper";
    const framePrevBtn = mkBtn("‹"); framePrevBtn.title = "Previous frame";
    const frameNextBtn = mkBtn("›"); frameNextBtn.title = "Next frame";
    scrubRow.append(scrubIdx, scrubWrap, frameStepper);

    // ── Frame-select controls ──
    const selRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    selRow.className = "krc-rz-frame-mode-group krc-rz-range-group";
    const fixedRangeBtn = mkBtn("FIXED");
    fixedRangeBtn.classList.add("krc-rz-fixed-button");
    fixedRangeBtn.title = "Fixed range: drag the green range or either endpoint";
    const fixedFpsLabel = mkEl("span", "");
    fixedFpsLabel.className = "krc-rz-fixed-label";
    fixedFpsLabel.textContent = "FPS";
    const fixedFpsInput = mkEl("input", INPUT_CSS + "width:34px;", { type: "number", min: 1, max: 99, step: 1, value: DEFAULT_FPS });
    fixedFpsInput.className = "krc-rz-input krc-rz-fixed-input krc-rz-fps-input";
    fixedFpsInput.title = "Playback and duration-estimate FPS";
    const fixedSecLabel = mkEl("span", "");
    fixedSecLabel.className = "krc-rz-fixed-label";
    fixedSecLabel.textContent = "SEC";
    const fixedSecInput = mkEl("input", INPUT_CSS + "width:42px;", { type: "number", min: 0.1, max: 999, step: 0.1, value: 5.0 });
    fixedSecInput.className = "krc-rz-input krc-rz-fixed-input krc-rz-sec-input";
    fixedSecInput.title = "Fixed range duration in seconds";
    const selResetBtn = mkBtn("↺"); selResetBtn.title = "Reset selection to the full clip (IN=0, OUT=last)";
    const playAllBtn = mkBtn("Play All"); playAllBtn.title = "Play all frames";
    playAllBtn.classList.add("krc-rz-play-button", "krc-rz-play-all-button");
    const playRangeBtn = mkBtn("Play"); playRangeBtn.title = "Play selected range";
    playRangeBtn.classList.add("krc-rz-play-button");
    const loopBtn = mkBtn("∞"); loopBtn.title = "Loop playback, capped at 10 passes";
    loopBtn.classList.add("krc-rz-play-button", "krc-rz-loop-button");
    const inInput   = mkEl("input", INPUT_CSS + "width:46px;", { type: "number", min: 0, step: 1, value: 0 });
    inInput.className = "krc-rz-input";
    const outInput  = mkEl("input", INPUT_CSS + "width:46px;", { type: "number", min: 0, step: 1, value: 0 });
    outInput.className = "krc-rz-input";
    const selReadout = mkEl("span", "font-size:10px;font-family:monospace;color:#7fa8d8;margin-left:6px;");
    selReadout.textContent = "";
    selRow.append(fixedRangeBtn, fixedFpsLabel, wrapWithStepper(fixedFpsInput), fixedSecLabel, wrapWithStepper(fixedSecInput), selResetBtn, playAllBtn, playRangeBtn, loopBtn, selReadout);

    // ── Single-frame control (shown only in single-frame mode) ──
    const singleRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    singleRow.className = "krc-rz-frame-mode-group krc-rz-single-group";
    const singleInput = mkEl("input", INPUT_CSS + "width:46px;", { type: "number", min: 0, step: 1, value: 0 });
    singleInput.className = "krc-rz-input";
    const singleReadout = mkEl("span", "font-size:10px;font-family:monospace;color:#7fa8d8;margin-left:6px;");
    frameStepper.append(framePrevBtn, singleInput, frameNextBtn);
    singleRow.append(singleReadout);
    const frameModeRow = mkEl("div", "");
    frameModeRow.className = "krc-rz-frame-mode-row";
    frameModeRow.append(singleRow, selRow);
    framePanel.append(scrubRow, frameModeRow);

    // ── Output Size + Mask Color Row (shared) ──
    const SELECT_CSS = "padding:2px 5px;font-size:11px;font-family:monospace;background:#1e1e1e;color:#ccc;border:1px solid #444;border-radius:4px;cursor:pointer;";
    const outputModeRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    outputModeRow.className = "krc-rz-row krc-rz-output-mode-row";
    const outSizeRow = mkEl("div", "display:flex;align-items:center;gap:3px;flex-wrap:wrap;");
    outSizeRow.className = "krc-rz-row krc-rz-output-size-row";
    const resModeSelect = mkEl("select", SELECT_CSS);
    resModeSelect.className = "krc-rz-hidden-select";
    for (const [val, label] of [["manual", "manual W×H"], ["mp", "megapixels"]]) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        resModeSelect.appendChild(opt);
    }
    resModeSelect.title = "Output sizing mode: type W×H, or target a total megapixel count";
    const resModeButton = mkEl("button", "", { type: "button" });
    resModeButton.className = "krc-rz-button krc-rz-latch-button krc-rz-mode-button";
    resModeButton.title = resModeSelect.title;
    resModeButton.textContent = "MP";
    const outWInput = mkEl("input", INPUT_CSS, { type: "number", min: 0, step: GRID, value: 0 });
    outWInput.className = "krc-rz-input";
    outWInput.placeholder = "auto";
    const outXLabel = mkEl("span", "font-size:10px;color:#999;"); outXLabel.textContent = "×";
    outXLabel.className = "krc-rz-output-x";
    const outHInput = mkEl("input", INPUT_CSS, { type: "number", min: 0, step: GRID, value: 0 });
    outHInput.className = "krc-rz-input";
    outHInput.placeholder = "auto";
    const resLockBtn = mkEl("button",
        "padding:0;font-size:11px;border:1px solid #444;border-radius:5px;" +
        "background:#2a2a2a;color:#bbb;cursor:pointer;"
    );
    resLockBtn.className = "krc-rz-button krc-rz-icon-button krc-rz-lock-button krc-rz-res-lock-button";
    resLockBtn.textContent = "";
    resLockBtn.title = "Lock exact output W/H across input changes";
    const divLabel = mkEl("span", "font-size:9px;color:#999;margin-left:2px;"); divLabel.className = "krc-rz-div-label"; divLabel.textContent = "MULTIPLE OF";
    const divSelect = mkEl("select", SELECT_CSS);
    divSelect.className = "krc-rz-hidden-select";
    for (const v of [1, 2, 4, 8, 16, 32, 64]) {
        const opt = document.createElement("option");
        opt.value = String(v); opt.textContent = v === 1 ? "OFF" : String(v);
        divSelect.appendChild(opt);
    }
    divSelect.title = "Round output width/height to a multiple of this. 32 is the safest default; 16 is usually fine for image models and WAN-style video. OFF = exact resolution, no rounding.";
    const divButton = mkEl("button", "", { type: "button" });
    divButton.className = "krc-rz-button krc-rz-divisor-button";
    divButton.title = divSelect.title;
    divButton.textContent = "32";
    const paddingBtn = mkEl("button", "", { type: "button" });
    paddingBtn.className = "krc-rz-button krc-rz-padding-button";
    paddingBtn.textContent = "ON";
    paddingBtn.title = "Allow selection to extend outside the image and fill with pad color";
    const padColorSelect = mkEl("select", "display:none;");
    for (const [val, label] of [["wan", "gray"], ["ltx", "black"], ["custom", "white"]]) {
        const opt = document.createElement("option");
        opt.value = val; opt.textContent = label;
        padColorSelect.appendChild(opt);
    }
    const customPadColorInput = mkEl("input", INPUT_CSS + "width:100px;display:none;", { type: "text", value: "115,115,115", placeholder: "#RRGGBB or R,G,B" });
    customPadColorInput.className = "krc-rz-input";
    const modeLabel = mkEl("span", "font-size:9px;color:#999;margin-left:2px;"); modeLabel.className = "krc-rz-mode-label"; modeLabel.textContent = "MODE";
    const paddingLabel = mkEl("span", "font-size:9px;color:#999;margin-left:2px;"); paddingLabel.className = "krc-rz-padding-label"; paddingLabel.textContent = "PADDING";
    outputModeRow.append(resModeSelect, modeLabel, resModeButton, divLabel, divSelect, divButton, paddingLabel, paddingBtn);
    outSizeRow.append(wrapWithStepper(outWInput), outXLabel, wrapWithStepper(outHInput), resLockBtn, padColorSelect, customPadColorInput);

    const padColorRow = mkEl("div", "display:flex;align-items:center;gap:5px;flex-wrap:wrap;");
    padColorRow.className = "krc-rz-pad-color-rail";
    const padColorLabel = mkEl("span", "font-size:10px;color:#999;"); padColorLabel.textContent = "PAD";
    const PAD_COLOR_DEFS = [
        ["ltx", "black", "0,0,0"],
        ["custom", "white", "255,255,255"],
        ["wan", "gray", "115,115,115"],
    ];
    const padColorBtns = PAD_COLOR_DEFS.map(([value, label, custom]) => {
        const btn = mkEl("button", CHIP_CSS);
        btn.className = `krc-rz-chip krc-rz-color-chip is-${label}`;
        btn.textContent = "";
        btn.title = label;
        btn.setAttribute("aria-label", `Pad color ${label}`);
        btn.dataset.padColor = value;
        btn.dataset.customPadColor = custom;
        return btn;
    });
    padColorRow.append(padColorLabel, ...padColorBtns);
    snapCluster.append(padColorRow);

    // ── Megapixel target row ──
    const mpRow = mkEl("div", "display:flex;align-items:center;gap:5px;");
    mpRow.className = "krc-rz-mp-selector";
    const mpPrevBtn = mkEl("button", "", { type: "button" });
    mpPrevBtn.className = "krc-rz-button krc-rz-mp-step-button";
    mpPrevBtn.textContent = "‹";
    mpPrevBtn.title = "Decrease megapixels";
    const mpInput = mkEl("input", INPUT_CSS + "width:62px;", { type: "number", min: 0.01, step: 0.01, value: 0.6 });
    mpInput.className = "krc-rz-input krc-rz-mp-input";
    const mpNextBtn = mkEl("button", "", { type: "button" });
    mpNextBtn.className = "krc-rz-button krc-rz-mp-step-button";
    mpNextBtn.textContent = "›";
    mpNextBtn.title = "Increase megapixels";
    const mpUnit = mkEl("span", "font-size:10px;color:#999;"); mpUnit.textContent = "MP";
    mpUnit.className = "krc-rz-mp-unit";
    const mpReadout = mkEl("span", "");
    mpReadout.className = "krc-rz-output-readout";
    const mpStepper = mkEl("div", "");
    mpStepper.className = "krc-rz-mp-stepper";
    mpStepper.append(mpPrevBtn, mpInput, mpNextBtn);
    mpRow.append(mpUnit, mpStepper);
    outSizeRow.append(mpRow);

    const optionsRow = mkEl("div", "");
    optionsRow.className = "krc-rz-options-row";
    const optionsBtn = mkEl("button", "", { type: "button" });
    optionsBtn.className = "krc-rz-button krc-rz-options-button";
    optionsBtn.title = "Options";
    optionsBtn.setAttribute("aria-label", "Options");
    const gearGlyph = mkEl("span", "");
    gearGlyph.className = "krc-gear-glyph";
    optionsBtn.append(gearGlyph);
    optionsRow.append(mpReadout, optionsBtn);

    previewCol.append(wrap, framePanel);
    ctrl.append(
        label("Mode"),
        toggleRow,
        label("Transform"),
        xformRow,
        label("Mask", "krc-rz-mask-title"),
        maskModeRow,
        maskAdjustRow,
        label("Crop", "krc-rz-crop-title"),
        cropSizeRow,
        presetRow,
        snapRow,
        label("Output"),
        outputModeRow,
        outSizeRow,
        optionsRow,
    );
    body.append(previewCol, ctrl);
    root.append(body);

    return { root, wrap, ctrl, viewport, sfEl, frameImg, noDataMsg, padFill, padTop, padBot, padLeft, padRight, cropBox, arBtn, snapBtns, scrubber, scrubWrap, scrubIdx, wInput, hInput, resetBtn, fullBtn, chipBtns, edges, outWInput, outHInput, divSelect, divButton, padColorSelect, padColorBtns, paddingBtn, customPadColorInput,
        singleBtn, rangeBtn, lastFrameBtn, noSelBtn, passBtn, disableBtn, xformRow, flipHBtn, flipVBtn, rotateGroup, rotatePrevBtn, rotateAngleBtn, rotateNextBtn, selSpan, fixedInHandle, fixedOutHandle, selRow, singleRow, fixedRangeBtn, fixedFpsInput, fixedSecInput, selResetBtn,
        inInput, outInput, selReadout, singleInput, singleReadout, framePrevBtn, frameNextBtn,
        playAllBtn, playRangeBtn, loopBtn,
        maskModeRow, maskAdjustRow, maskInputBtn, maskEmptyBtn, maskInvertBtn, featherInput, featherMenuBtn, growInput, growMenuBtn, thresholdInput, thresholdMenuBtn,
        cropSizeRow, presetRow, snapRow, outputModeRow, outSizeRow, padColorRow,
        resModeSelect, resModeButton, resLockBtn, mpRow, mpInput, mpPrevBtn, mpNextBtn, mpReadout, optionsBtn };
}
