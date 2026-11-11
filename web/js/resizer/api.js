import { API_PREFIX } from "./constants.js";

function revokeFramePreviewSrc(dom) {
    const old = dom?.frameImg?.src || "";
    if (old.startsWith("blob:")) URL.revokeObjectURL(old);
}

export function setFramePreviewBlob(dom, blob, st = null) {
    if (!blob?.size) {
        clearFramePreview(st, dom);
        return false;
    }
    const url = URL.createObjectURL(blob);
    revokeFramePreviewSrc(dom);
    dom.frameImg.src = url;
    if (st) st.hasPreviewImage = true;
    dom.sfEl.style.display = "block";
    dom.frameImg.style.display = "block";
    dom.noDataMsg.style.display = "none";
    return true;
}

export function setFramePreviewBase64(dom, base64, st = null, mimeType = "image/jpeg") {
    const clean = String(base64 || "").trim();
    if (!clean) {
        clearFramePreview(st, dom);
        return false;
    }
    const raw = atob(clean);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
    return setFramePreviewBlob(dom, new Blob([bytes], { type: mimeType }), st);
}

export function clearFramePreview(st, dom) {
    if (st) st.hasPreviewImage = false;
    revokeFramePreviewSrc(dom);
    dom.frameImg.removeAttribute("src");
    dom.sfEl.style.display = "none";
    dom.frameImg.style.display = "none";
    dom.noDataMsg.style.display = "flex";
    for (const el of [dom.padTop, dom.padBot, dom.padLeft, dom.padRight]) {
        el.style.display = "none";
    }
}

export async function fetchInfo(nodeId) {
    try {
        const r = await fetch(`${API_PREFIX}/info?node_id=${nodeId}`);
        if (r.status === 204) return null;
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

export async function fetchFrame(nodeId, idx, dom, st = null) {
    try {
        const r = await fetch(`${API_PREFIX}/frame?node_id=${nodeId}&idx=${idx}`);
        if (!r.ok) return false;
        const blob = await r.blob();
        if (!blob.size) {
            clearFramePreview(st, dom);
            return false;
        }
        return setFramePreviewBlob(dom, blob, st);
    } catch {
        return false;
    }
}
