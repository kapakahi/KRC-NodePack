import { MARGIN } from "./constants.js";
import { setControlActive } from "./controls.js";
import { crToSrc } from "./geometry.js";
import { updateMaskUI, updateResUI, updateXformUI } from "./ui_state.js";

// ── Render ────────────────────────────────────────────────────────────

const PAD_RGB = {
    wan: [115, 115, 115],
    ltx: [0, 0, 0],
    custom: [255, 255, 255],
};

function parsePadRgb(st) {
    if (st.padColor !== "custom") return PAD_RGB[st.padColor] || PAD_RGB.wan;
    const raw = String(st.customPadColor || "").trim();
    if (/^#?[0-9a-f]{6}$/i.test(raw)) {
        const hex = raw.replace("#", "");
        return [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
    }
    const vals = raw.split(",").map(v => Number(v.trim()));
    if (vals.length === 3 && vals.every(Number.isFinite)) {
        return vals.map(v => Math.max(0, Math.min(255, v > 1 ? v : v * 255)));
    }
    return PAD_RGB.custom;
}

export function render(st, dom) {
    if (!st.initialized) return;
    const { sf, cr, view } = st;
    const showPreviewImage = !!st.hasPreviewImage;

    // Viewport transform.
    dom.viewport.style.transform = `translate(${view.panX}px,${view.panY}px) scale(${view.zoom})`;

    // Source frame
    dom.sfEl.style.display = showPreviewImage ? "block" : "none";
    dom.sfEl.style.left   = sf.x + "px";
    dom.sfEl.style.top    = sf.y + "px";
    dom.sfEl.style.width  = sf.w + "px";
    dom.sfEl.style.height = sf.h + "px";

    // Frame image transform: rotate (clockwise) then flip, matching the backend.
    // For a 90°/270° rotation the element is pre-sized swapped so that after the
    // rotate it fills sfEl with no distortion. Scale (flip) is applied AFTER the
    // rotate (left of it in the list) so flips act in the rotated/displayed frame.
    {
        const xformDisabled = !!st.passthrough;
        const r = xformDisabled ? 0 : (st.rotate || 0);
        const fine = xformDisabled ? 0 : Math.round(st.fineRotate || 0);
        const displayRotate = r + fine;
        const swap = r === 90 || r === 270;
        const iw = swap ? sf.h : sf.w;
        const ih = swap ? sf.w : sf.h;
        const fx = !xformDisabled && st.flipX ? -1 : 1;
        const fy = !xformDisabled && st.flipY ? -1 : 1;
        const fi = dom.frameImg.style;
        fi.left = "50%"; fi.top = "50%"; fi.right = "auto"; fi.bottom = "auto";
        fi.width = iw + "px"; fi.height = ih + "px";
        fi.transform = `translate(-50%,-50%) scale(${fx},${fy}) rotate(${displayRotate}deg)`;
    }

    // Crop box chrome is an unscaled overlay above the transformed viewport.
    dom.cropBox.style.left   = (view.panX + cr.x * view.zoom) + "px";
    dom.cropBox.style.top    = (view.panY + cr.y * view.zoom) + "px";
    dom.cropBox.style.width  = (cr.w * view.zoom) + "px";
    dom.cropBox.style.height = (cr.h * view.zoom) + "px";

    const s   = crToSrc(cr, sf, st.scale);

    // Pad overlays
    const ix1 = Math.max(cr.x, sf.x), iy1 = Math.max(cr.y, sf.y);
    const ix2 = Math.min(cr.x + cr.w, sf.x + sf.w);
    const iy2 = Math.min(cr.y + cr.h, sf.y + sf.h);
    const [padRgbaR, padRgbaG, padRgbaB] = parsePadRgb(st);
    const padOverlayColor = `rgba(${padRgbaR},${padRgbaG},${padRgbaB},0.38)`;

    const setPadOverlay = (el, x, y, w, h) => {
        if (w > 0 && h > 0) {
            el.style.cssText = `position:absolute;background:${padOverlayColor};pointer-events:none;display:block;left:${x}px;top:${y}px;width:${w}px;height:${h}px;`;
        } else {
            el.style.display = "none";
        }
    };
    const rotatedPreview = !st.passthrough && !!((st.rotate || 0) || Math.round(st.fineRotate || 0));
    if (rotatedPreview) {
        setPadOverlay(dom.padFill, cr.x, cr.y, cr.w, cr.h);
        for (const el of [dom.padTop, dom.padBot, dom.padLeft, dom.padRight]) {
            el.style.display = "none";
        }
    } else {
        dom.padFill.style.display = "none";
        setPadOverlay(dom.padTop,   cr.x, cr.y, cr.w, Math.max(0, iy1 - cr.y));
        setPadOverlay(dom.padBot,   cr.x, iy2,  cr.w, Math.max(0, cr.y + cr.h - iy2));
        setPadOverlay(dom.padLeft,  cr.x, iy1,  Math.max(0, ix1 - cr.x), iy2 - iy1);
        setPadOverlay(dom.padRight, ix2,  iy1,  Math.max(0, cr.x + cr.w - ix2), iy2 - iy1);
    }
    if (!showPreviewImage) {
        for (const el of [dom.padFill, dom.padTop, dom.padBot, dom.padLeft, dom.padRight]) {
            el.style.display = "none";
        }
    }

    // Canvas values
    const outW = Math.round(s.w), outH = Math.round(s.h);

    // Sync W/H inputs
    if (document.activeElement !== dom.wInput) dom.wInput.value = outW;
    if (document.activeElement !== dom.hInput) dom.hInput.value = outH;

    // Sync output size inputs
    if (document.activeElement !== dom.outWInput)
        dom.outWInput.value = st.outW || "";
    if (document.activeElement !== dom.outHInput)
        dom.outHInput.value = st.outH || "";

    // Sync output-mode controls (manual / megapixels)
    updateResUI(st, dom);

    // Sync transform-row buttons
    updateXformUI(st, dom);

    // Sync mask controls
    updateMaskUI(st, dom);

    // Sync active preset chip
    const actualAR = st.arLocked ? st.cropAR : s.w / s.h;
    for (const btn of dom.chipBtns) {
        const chipAR = parseFloat(btn.dataset.chipAR);
        const active = st.arLocked && Math.abs(chipAR - actualAR) < 0.005;
        setControlActive(btn, active);
    }

    // Passthrough / No-Selection: the crop window is irrelevant — hide it and its
    // overlays so the canvas reads as a plain frame viewer (No-Selection resizes
    // the whole frame; Passthrough passes it through untouched).
    if (st.passthrough || st.noSelect) {
        for (const el of [dom.cropBox, dom.padFill, dom.padTop, dom.padBot, dom.padLeft, dom.padRight]) {
            el.style.display = "none";
        }
    } else {
        dom.cropBox.style.display = "block";
    }
}

/** Keep the selection centered and fitted so all handles remain reachable. */
export function centerSelectionInView(st, dom) {
    const wrapW = dom.wrap.clientWidth;
    const wrapH = dom.wrap.clientHeight;
    if (wrapW <= 0 || wrapH <= 0) return; // node is offscreen / collapsed
    const pad = MARGIN;
    const usableW = Math.max(1, wrapW - pad * 2);
    const usableH = Math.max(1, wrapH - pad * 2);
    const zoom = Math.min(8.0, usableW / st.cr.w, usableH / st.cr.h);
    st.view.zoom = zoom;
    st.view.panX = wrapW / 2 - (st.cr.x + st.cr.w / 2) * zoom;
    st.view.panY = wrapH / 2 - (st.cr.y + st.cr.h / 2) * zoom;
}
