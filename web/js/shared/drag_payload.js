const KRC_DRAG_PAYLOAD_KEY = "__krcDragPayload";

export function setKrcDragPayload(payload = {}) {
  window[KRC_DRAG_PAYLOAD_KEY] = {
    kind: String(payload.kind || ""),
    id: String(payload.id || ""),
    ...(Array.isArray(payload.ids) ? { ids: payload.ids.map(String) } : {}),
    modelType: String(payload.modelType || ""),
    // Prompt cards (kind:"prompt") identify a Prompt Vault record by category+name
    // so the drop target can hydrate the deferred prompt text; model cards leave it "".
    category: String(payload.category || ""),
    path: String(payload.path || ""),
    relativePath: String(payload.relativePath || payload.relative_path || ""),
    file: String(payload.file || payload.filename || ""),
    title: String(payload.title || payload.name || ""),
    thumbnailUrl: String(payload.thumbnailUrl || payload.thumbnail || ""),
    cardColor: String(payload.cardColor || ""),
    favorite: Boolean(payload.favorite),
  };
}

export function getKrcDragPayload() {
  return window[KRC_DRAG_PAYLOAD_KEY] || null;
}

export function clearKrcDragPayload() {
  delete window[KRC_DRAG_PAYLOAD_KEY];
}
