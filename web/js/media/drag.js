// Media references use one payload across Portal cards, Output previews and slots.
import { clearKrcDragPayload, getKrcDragPayload, setKrcDragPayload } from "./krc.js";

export const MEDIA_DRAG_KIND = "krc-media";
const MIME = "application/x-krc-media";
const validId = id => /^[0-9a-f]{32}$/.test(String(id || ""));
const highlighted = new Set();
const clearHighlights = () => {
  for (const target of highlighted) target.classList.remove("is-drop-target");
  highlighted.clear();
};
window.addEventListener("dragend", clearHighlights, true);

export function makeMediaDraggable(element, itemOf) {
  element.draggable = true;
  let dragged = false;
  element.addEventListener("dragstart", event => {
    const item = itemOf();
    const ids = (Array.isArray(item) ? item : [item]).map(entry => entry?.id);
    if (!ids.length || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) { event.preventDefault(); return; }
    event.stopPropagation();
    dragged = true;
    setKrcDragPayload({ kind: MEDIA_DRAG_KIND, id: ids[0], ...(ids.length > 1 ? { ids } : {}) });
    event.dataTransfer?.setData(MIME, ids.length > 1 ? JSON.stringify(ids) : ids[0]);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  });
  element.addEventListener("dragend", () => {
    clearKrcDragPayload();
    clearHighlights();
    setTimeout(() => { dragged = false; }, 0);
  });
  // A history-cell drag must not turn into a history-selection click on release.
  element.addEventListener("click", event => {
    if (!dragged) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  return element;
}

export function installMediaDropTarget(element, { onDrop, onDropMany, enabled = () => true, dragPayload = getKrcDragPayload } = {}) {
  const payload = () => dragPayload?.();
  const readIds = event => {
    const current = payload();
    let ids = current?.kind === MEDIA_DRAG_KIND ? current.ids || [current.id] : null;
    if (!ids) {
      const raw = event.dataTransfer?.getData(MIME);
      if (!raw) return null; // Native dragover may hide its payload until drop.
      try { ids = raw.startsWith("[") ? JSON.parse(raw) : [raw]; } catch { return []; }
    }
    return Array.isArray(ids) && ids.length && ids.every(validId) && new Set(ids).size === ids.length ? ids : [];
  };
  const accepts = ids => enabled() && (ids === null || (ids.length === 1 && typeof onDrop === "function")
    || (ids.length >= 1 && ids.length <= 6 && typeof onDropMany === "function"));
  const isMedia = event => (payload()?.kind === MEDIA_DRAG_KIND && validId(payload()?.id))
    || Array.from(event.dataTransfer?.types || []).includes(MIME);
  const highlight = on => {
    element.classList.toggle("is-drop-target", on);
    if (on) highlighted.add(element); else highlighted.delete(element);
  };
  element.addEventListener("dragover", event => {
    if (!isMedia(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const allowed = Boolean(accepts(readIds(event)));
    if (event.dataTransfer) event.dataTransfer.dropEffect = allowed ? "copy" : "none";
    highlight(allowed);
  });
  element.addEventListener("dragleave", event => {
    if (!element.contains(event.relatedTarget)) highlight(false);
  });
  element.addEventListener("drop", event => {
    if (!isMedia(event)) return;
    event.preventDefault();
    event.stopPropagation();
    clearHighlights();
    const ids = readIds(event);
    if (!ids || !accepts(ids)) return;
    if (ids.length > 1 || typeof onDrop !== "function") onDropMany(ids);
    else onDrop(ids[0]);
  });
  return element;
}
