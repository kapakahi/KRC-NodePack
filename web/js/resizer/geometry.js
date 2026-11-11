import { GRID, MARGIN, MIN_SOURCE_OVERLAP } from "./constants.js";

export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// cr = crop rect in canvas px; sf = source frame rect in canvas px; scale = canvas px / source px
export function crToSrc(cr, sf, scale) {
    return {
        x: (cr.x - sf.x) / scale,
        y: (cr.y - sf.y) / scale,
        w: cr.w / scale,
        h: cr.h / scale,
    };
}

export function srcToCr(s, sf, scale) {
    return {
        x: sf.x + s.x * scale,
        y: sf.y + s.y * scale,
        w: s.w * scale,
        h: s.h * scale,
    };
}

export function quantizeSrc(s) {
    return {
        x: Math.round(s.x / GRID) * GRID,
        y: Math.round(s.y / GRID) * GRID,
        w: Math.max(GRID, Math.round(s.w / GRID) * GRID),
        h: Math.max(GRID, Math.round(s.h / GRID) * GRID),
    };
}

export function isFullSourceRect(s, st) {
    return Math.abs(s.x) < 0.5
        && Math.abs(s.y) < 0.5
        && Math.abs(s.w - st.srcW) < 0.5
        && Math.abs(s.h - st.srcH) < 0.5;
}

export function rotatedSourceBounds(st) {
    const angle = Math.round(st.fineRotate || 0);
    if (!angle) return { x: 0, y: 0, w: st.srcW, h: st.srcH };
    const radians = angle * Math.PI / 180;
    const cos = Math.abs(Math.cos(radians));
    const sin = Math.abs(Math.sin(radians));
    const w = st.srcW * cos + st.srcH * sin;
    const h = st.srcW * sin + st.srcH * cos;
    return {
        x: (st.srcW - w) / 2,
        y: (st.srcH - h) / 2,
        w,
        h,
    };
}

/** Enforce overlap constraint: crop must intersect source by at least MIN_SOURCE_OVERLAP px. */
export function clampToValid(s, srcW, srcH) {
    const c = { ...s };
    if (c.x >= srcW - MIN_SOURCE_OVERLAP) c.x = srcW - MIN_SOURCE_OVERLAP;
    if (c.y >= srcH - MIN_SOURCE_OVERLAP) c.y = srcH - MIN_SOURCE_OVERLAP;
    if (c.x + c.w <= MIN_SOURCE_OVERLAP)  c.x = MIN_SOURCE_OVERLAP - c.w;
    if (c.y + c.h <= MIN_SOURCE_OVERLAP)  c.y = MIN_SOURCE_OVERLAP - c.h;
    return c;
}

export function constrainSrcToPaddingMode(s, st, aspect = null) {
    if (st.paddingEnabled !== false) return clampToValid(s, st.srcW, st.srcH);
    const g = st.divisor || GRID;
    const c = { ...s };
    if (aspect && aspect > 0) {
        const cx = c.x + c.w / 2;
        const cy = c.y + c.h / 2;
        const maxW = Math.max(g, Math.floor(st.srcW / g) * g);
        const maxH = Math.max(g, Math.floor(st.srcH / g) * g);
        c.w = Math.min(Math.max(g, c.w), maxW);
        c.h = Math.max(g, Math.round(c.w / aspect / g) * g);
        if (c.h > maxH) {
            c.h = maxH;
            c.w = Math.max(g, Math.round(c.h * aspect / g) * g);
        }
        c.x = clamp(Math.round((cx - c.w / 2) / g) * g, 0, Math.max(0, st.srcW - c.w));
        c.y = clamp(Math.round((cy - c.h / 2) / g) * g, 0, Math.max(0, st.srcH - c.h));
        return c;
    }
    c.w = Math.min(Math.max(g, c.w), Math.max(g, Math.floor(st.srcW / g) * g));
    c.h = Math.min(Math.max(g, c.h), Math.max(g, Math.floor(st.srcH / g) * g));
    c.x = clamp(c.x, 0, Math.max(0, st.srcW - c.w));
    c.y = clamp(c.y, 0, Math.max(0, st.srcH - c.h));
    return c;
}

/** Adjust outW/outH AR to match cropAR (no-op when outW/outH are unset).
 *  preserveArea=true keeps pixel count constant (used by preset chips).
 *  preserveArea=false keeps outW fixed, adjusts only outH (used by drag-resize). */
export function syncOutToAR(st, preserveArea = false) {
    const g = st.divisor || GRID;
    if (st.outW >= g && st.outH >= g) {
        if (preserveArea) {
            const area = st.outW * st.outH;
            st.outW = Math.max(g, Math.round(Math.sqrt(area * st.cropAR) / g) * g);
        }
        st.outH = Math.max(g, Math.round(st.outW / st.cropAR / g) * g);
    }
}

/** Default output resolution for a new node: 1280×720, snapped to the divisor. */
export function defaultOut(st) {
    const g = st.divisor || GRID;
    return { w: Math.max(g, Math.round(1280 / g) * g), h: Math.max(g, Math.round(720 / g) * g) };
}

/** Set the crop to cover the exact entire source frame (fit W + fit H). */
export function fitFullFrame(st) {
    const s = { x: 0, y: 0, w: st.srcW, h: st.srcH };
    st.cr = srcToCr(s, st.sf, st.scale);
    st.cropAR = s.w / s.h;
}

/** Fit a crop window with the requested aspect ratio inside the source frame. */
export function fitAspectInsideSource(st, aspect) {
    const g = GRID;
    const srcAR = st.srcW / st.srcH;
    let w, h;
    if (srcAR > aspect) {
        h = Math.max(g, Math.floor(st.srcH / g) * g);
        w = Math.max(g, Math.floor((h * aspect) / g) * g);
    } else {
        w = Math.max(g, Math.floor(st.srcW / g) * g);
        h = Math.max(g, Math.floor((w / aspect) / g) * g);
    }
    const x = Math.round((st.srcW - w) / (2 * g)) * g;
    const y = Math.round((st.srcH - h) / (2 * g)) * g;
    const s = constrainSrcToPaddingMode({ x, y, w, h }, st);
    st.cr = srcToCr(s, st.sf, st.scale);
    st.cropAR = s.w / s.h;
}

/** No-Selection mode geometry: pin the crop to the entire source frame and lock
 *  the crop AR to the exact source AR. Output is still sized by the W×H / MP
 *  controls, at the source AR, without adding padded regions. */
export function applyNoSelect(st) {
    fitFullFrame(st);                 // crop covers the exact whole frame
    st.cropAR = st.srcW / st.srcH;    // exact source AR, so output never distorts
    updateOutputRes(st);
}

/** Recompute the EFFECTIVE source dims from the raw input dims and the current
 *  rotation. A 90°/270° rotation swaps width and height. All crop geometry runs
 *  against these effective dims, so the crop window always matches the rotated
 *  frame the user sees (and the rotated source the backend produces). */
export function applyTransformDims(st) {
    const swap = st.rotate === 90 || st.rotate === 270;
    st.srcW = swap ? st.rawH : st.rawW;
    st.srcH = swap ? st.rawW : st.rawH;
}

/** Megapixel mode: derive outW/outH from the target MP and current crop AR.
 *  outW·outH = targetMP·1e6 and outW/outH = cropAR  ⇒  outW = √(pixels·AR).
 *  Each axis snaps to the divisor; among the grid-aligned candidates we pick the
 *  one whose area is the LARGEST that still sits at or under the MP budget
 *  (nearest-under), so the output never overshoots the target and the shortfall
 *  is at most a single grid step. */
export function applyMP(st) {
    if (!(st.targetMP > 0) || !(st.cropAR > 0)) return;
    const g = st.divisor || GRID;
    const idealW = Math.sqrt(st.targetMP * 1e6 * st.cropAR);
    const idealH = idealW / st.cropAR;
    const [ow, oh] = nearestUnderGrid(idealW, idealH, st.targetMP * 1e6, g);
    st.outW = ow;
    st.outH = oh;
}

/** Pick the grid-aligned (W,H) whose area is the greatest that does NOT exceed
 *  `budgetPx`. Ceils AND floors each axis to the grid, then among the 2×2 combos
 *  keeps those with area ≤ budget and returns the largest; floor/floor is always
 *  ≤ budget, so a valid candidate always exists (falls back to it if none fit). */
export function nearestUnderGrid(idealW, idealH, budgetPx, g) {
    const wLo = Math.max(g, Math.floor(idealW / g) * g);
    const wHi = Math.max(g, Math.ceil(idealW / g) * g);
    const hLo = Math.max(g, Math.floor(idealH / g) * g);
    const hHi = Math.max(g, Math.ceil(idealH / g) * g);
    let best = [wLo, hLo];          // floor/floor — always ≤ budget
    let bestArea = wLo * hLo;
    for (const w of (wHi === wLo ? [wLo] : [wLo, wHi])) {
        for (const h of (hHi === hLo ? [hLo] : [hLo, hHi])) {
            const area = w * h;
            if (area <= budgetPx && area > bestArea) {
                best = [w, h];
                bestArea = area;
            }
        }
    }
    return best;
}

/** Recompute output resolution after a crop change, per the active mode. */
export function updateOutputRes(st, preserveArea = false) {
    if (st.resMode === "mp") applyMP(st);
    else syncOutToAR(st, preserveArea);
}

/** Full pipeline: canvas px → source px → quantise → constrain → canvas px. */
export function applyCanvasCr(canvasCr, st) {
    let s = crToSrc(canvasCr, st.sf, st.scale);
    s = quantizeSrc(s);
    s = constrainSrcToPaddingMode(s, st, st.arLocked ? st.cropAR : null);
    st.cr = srcToCr(s, st.sf, st.scale);
}

/** Convert a screen-space pointer event to world (canvas) coordinates. */
export function toWorld(e, wrapEl, view) {
    const rect = wrapEl.getBoundingClientRect();
    return {
        x: (e.clientX - rect.left  - view.panX) / view.zoom,
        y: (e.clientY - rect.top   - view.panY) / view.zoom,
    };
}

/** Compute source-frame rect, scale, and default crop window from current canvas size. */
export function initLayout(st, wrapEl) {
    const W = wrapEl.clientWidth;
    if (W <= 0) return false;
    const maxW = W - MARGIN * 2;
    const maxH = wrapEl.clientHeight - MARGIN * 2;
    if (maxW <= 0 || maxH <= 0) return false;
    const ar   = st.srcW / st.srcH;
    // Fit source frame inside (maxW × maxH) while preserving aspect ratio.
    let sfW, sfH;
    if (maxW / ar <= maxH) {
        sfW = maxW;
        sfH = Math.round(maxW / ar);
    } else {
        sfH = maxH;
        sfW = Math.round(maxH * ar);
    }
    const sfX = Math.round((W - sfW) / 2);
    const sfY = Math.max(MARGIN, Math.round((wrapEl.clientHeight - sfH) / 2));
    st.sf = { x: sfX, y: sfY, w: sfW, h: sfH };
    st.scale = sfW / st.srcW;
    st.view = { zoom: 1.0, panX: 0, panY: 0 };
    // Fresh node default: neutral square selection centered on the source frame.
    const defSize = Math.max(GRID, Math.floor(Math.min(st.srcW, st.srcH) / GRID) * GRID);
    const defW = defSize, defH = defSize;
    const defX = Math.round((st.srcW - defW) / (2 * GRID)) * GRID;
    const defY = Math.round((st.srcH - defH) / (2 * GRID)) * GRID;
    const def = clampToValid({ x: defX, y: defY, w: defW, h: defH }, st.srcW, st.srcH);
    st.cr = srcToCr(def, st.sf, st.scale);
    st.cropAR = st.cr.w / st.cr.h;
    st.initialized = true;
    return true;
}

// Keep a stable source-space snapshot across consecutive layout-only changes.
// Rebuild it after a real edit/source change, never round or clamp it on resize.
const layoutProjections = new WeakMap();
const projectionKey = st => [st.srcW, st.srcH, st.scale, st.sf.x, st.sf.y, st.sf.w, st.sf.h, st.cr.x, st.cr.y, st.cr.w, st.cr.h];
export function resizeLayout(st, wrap) {
    const previous = layoutProjections.get(st);
    const key = projectionKey(st);
    const source = previous && key.every((value, index) => value === previous.key[index])
        ? previous.source : crToSrc(st.cr, st.sf, st.scale);
    const aspect = st.cropAR;
    if (!initLayout(st, wrap)) return false;
    st.cr = srcToCr(source, st.sf, st.scale);
    st.cropAR = aspect;
    layoutProjections.set(st, { source, key: projectionKey(st) });
    return true;
}

/** Restore crop rect from the saved crop_state widget value (workflow load).
 *  @param {string} [overrideVal] - use this value instead of reading the widget
 *    (pass the value latched at onConfigure time to avoid rAF/configure races). */
export function restoreCropFromWidgets(st, widgets, overrideVal) {
    const val = overrideVal !== undefined ? overrideVal : (widgets.cropState?.value ?? "");
    if (!val) return;
    const parts = val.split(",").map(Number);
    if (parts.length < 4 || parts.some(isNaN)) return;
    if (parts.length >= 18 && !isNaN(parts[17])) {
        st.paddingEnabled = parts[17] !== 0;
    }
    if (parts.length >= 19 && !isNaN(parts[18])) {
        st.frameCount = parts[18];
    }
    if (parts.length >= 20 && !isNaN(parts[19])) {
        st.mediaSig = parts[19];
    }
    const [cx, cy, cw, ch] = parts;
    if (cw >= GRID && ch >= GRID) {
        const s = constrainSrcToPaddingMode({ x: cx, y: cy, w: cw, h: ch }, st);
        st.cr = srcToCr(s, st.sf, st.scale);
        st.cropAR = s.w / s.h;
    }
    if (parts.length >= 6) {
        st.outW = parts[4] || 0;
        st.outH = parts[5] || 0;
    }
    if (parts.length >= 7 && !isNaN(parts[6])) {
        st.arLocked = parts[6] !== 0;
    }
    if (parts.length >= 8 && !isNaN(parts[7])) {
        st.resMode = parts[7] !== 0 ? "mp" : "manual";
    }
    if (parts.length >= 9 && !isNaN(parts[8]) && parts[8] > 0) {
        st.targetMP = parts[8] / 100;   // stored as round(MP * 100) to fit the int CSV
    }
    if (parts.length >= 10 && !isNaN(parts[9])) {
        st.noSelect = parts[9] !== 0;
    }
    if (parts.length >= 11 && !isNaN(parts[10]) && parts[10] > 0) {
        st.divisor = parts[10];
    }
    if (parts.length >= 12 && [0, 90, 180, 270].includes(parts[11])) {
        st.rotate = parts[11];
    }
    if (parts.length >= 13 && !isNaN(parts[12])) {
        st.flipX = parts[12] !== 0;
    }
    if (parts.length >= 14 && !isNaN(parts[13])) {
        st.flipY = parts[13] !== 0;
    }
    if (parts.length >= 21 && !isNaN(parts[20])) {
        st.viewFrame = parts[20];   // currently-viewed scrubber frame
    }
    if (parts.length >= 24) {
        if (!isNaN(parts[21])) st.fixedRange = parts[21] !== 0;
        if (!isNaN(parts[22]) && parts[22] > 0) st.fixedRangeFps = parts[22] / 100;
        if (!isNaN(parts[23]) && parts[23] > 0) st.fixedRangeSeconds = parts[23] / 10;
    }
    if (parts.length >= 25 && !isNaN(parts[24])) {
        st.fixedRangeActiveEdge = parts[24] !== 0 ? "out" : "in";
    }
    if (parts.length >= 26 && !isNaN(parts[25])) {
        st.fineRotate = Math.round(parts[25]);
    }
    if (parts.length >= 27 && !isNaN(parts[26])) {
        st.maskMode = parts[26] === 1 ? "input" : parts[26] === 2 ? "empty" : "both";
    }
    if (parts.length >= 28 && !isNaN(parts[27])) {
        st.maskInvert = parts[27] !== 0;
    }
    if (parts.length >= 29 && !isNaN(parts[28])) {
        st.maskFeather = clamp(Math.round(parts[28]), 0, 99);
    }
    if (parts.length >= 30 && !isNaN(parts[29])) {
        st.maskGrow = clamp(Math.round(parts[29]), -99, 99);
    }
    if (parts.length >= 31 && !isNaN(parts[30])) {
        st.maskThreshold = clamp(parts[30] / 1000, 0, 1);
    }
    if (parts.length >= 32 && !isNaN(parts[31])) {
        st.resLocked = parts[31] !== 0;
    }
    if (st.resLocked) {
        st.resMode = "manual";
        st.divisor = 1;
    }
}

/** Restore only the input-independent config modes (lock, ratio/MP, LTX,
 *  padding, divisor) from the saved crop_state. Used on workflow load so these
 *  workflow preferences persist even when the input media changed and the crop
 *  geometry is re-fit. Deliberately does NOT touch geometry / rotate / flip /
 *  noSelect — those are input-specific. */
export function restoreConfigModes(st, widgets) {
    const val = widgets.cropState?.value ?? "";
    if (!val) return;
    const parts = val.split(",").map(Number);
    if (parts.length < 15 || parts.slice(0, 15).some(isNaN)) return;
    st.arLocked = parts[6] !== 0;
    st.resMode  = parts[7] !== 0 ? "mp" : "manual";
    if (parts[8] > 0)  st.targetMP = parts[8] / 100;
    if (parts[10] > 0) st.divisor  = parts[10];
    if (parts.length >= 18 && !isNaN(parts[17])) st.paddingEnabled = parts[17] !== 0;
    if (parts.length >= 27 && !isNaN(parts[26])) st.maskMode = parts[26] === 1 ? "input" : parts[26] === 2 ? "empty" : "both";
    if (parts.length >= 28 && !isNaN(parts[27])) st.maskInvert = parts[27] !== 0;
    if (parts.length >= 29 && !isNaN(parts[28])) st.maskFeather = clamp(Math.round(parts[28]), 0, 99);
    if (parts.length >= 30 && !isNaN(parts[29])) st.maskGrow = clamp(Math.round(parts[29]), -99, 99);
    if (parts.length >= 31 && !isNaN(parts[30])) st.maskThreshold = clamp(parts[30] / 1000, 0, 1);
    if (parts.length >= 32 && !isNaN(parts[31])) st.resLocked = parts[31] !== 0;
    if (st.resLocked) {
        st.resMode = "manual";
        st.divisor = 1;
    }
    if (parts.length >= 24) {
        if (!isNaN(parts[21])) st.fixedRange = parts[21] !== 0;
        if (!isNaN(parts[22]) && parts[22] > 0) st.fixedRangeFps = parts[22] / 100;
        if (!isNaN(parts[23]) && parts[23] > 0) st.fixedRangeSeconds = parts[23] / 10;
    }
    if (parts.length >= 25 && !isNaN(parts[24])) {
        st.fixedRangeActiveEdge = parts[24] !== 0 ? "out" : "in";
    }
}
