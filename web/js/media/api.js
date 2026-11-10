// The Media's server routes (utils/media_routes.py), all under /krc/media/.
import { api } from "../../../scripts/api.js";

export const MEDIA_EVENT = "krc-media-media-changed";
export const PRESETS_EVENT = "krc-media-presets-changed";

// Seconds as m:ss (or m:ss.s with `tenths`).
export function formatDuration(seconds, { tenths = false } = {}) {
  const value = Math.max(0, Number(seconds) || 0);
  const minutes = Math.floor(value / 60);
  const rest = value - minutes * 60;
  const secs = tenths ? rest.toFixed(1).padStart(4, "0") : String(Math.floor(rest)).padStart(2, "0");
  return `${minutes}:${secs}`;
}

// An item's name as shown: every item is WebP or WebM, so an extension says nothing (names
// are stored without one now; this also cleans older items).
export function displayName(item) {
  return String(item?.name || "").replace(/\.(webp|webm)$/i, "") || "(unnamed)";
}

// Output filenames preserve their requested container; card names may be renamed.
// Older media uploads have no public filename and were always WebP/WebM.
export function storedFormat(item) {
  const extension = String(item?.filename || "").match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  const labels = { png: "PNG", webp: "WebP", gif: "GIF", mp4: "MP4", webm: "WebM" };
  if (extension) return labels[extension] || extension.toUpperCase();
  if (!item?.storage || item.storage === "media") return item?.kind === "video" ? "WebM" : "WebP";
  return "Unknown";
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return value ? `${value} B` : "—";
}

async function json(response) {
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = {};
  }
  if (!response.ok || payload.ok === false) {
    // The status and answer ride along (a 409 conflict carries the preset as it is now).
    throw Object.assign(new Error(payload.error || `HTTP ${response.status}`), { status: response.status, payload });
  }
  return payload;
}

const post = (path, body) => api.fetchApi(path, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body || {}),
}).then(json);

export const mediaApi = {
  list: () => api.fetchApi("/krc/media/media", { cache: "no-store" }).then(json),
  // `settings`: { maxSize, folder } (+ for video: fps, audio, trimIn, trimOut; seconds; + assign:
  // { preset, slot } puts the new item into that preset slot when it's added). A still
  // -> { item }; a video / animated GIF -> { job } (converting in the background).
  // `signal` (an AbortController's) stops the request while it's sending.
  upload: (file, settings = {}, signal = undefined) => {
    const form = new FormData();
    form.append("settings", JSON.stringify(settings));
    form.append("file", file, file.name);
    return api.fetchApi("/krc/media/upload", { method: "POST", body: form, ...(signal ? { signal } : {}) }).then(json);
  },
  previewOperation: (ids, operation) => post("/krc/media/bulk-operation/preview", { ids, operation }),
  bulkOperation: (ids, operation, options) => post("/krc/media/bulk-operation", { ids, operation, ...options }),
  bulkAttributes: (ids, field, value) => post("/krc/media/bulk-attributes", { ids, field, value }),
  update: (id, fields) => post(`/krc/media/item/${encodeURIComponent(id)}`, fields),
  remove: (id) => post(`/krc/media/delete/${encodeURIComponent(id)}`),
  // Everything except favourites / pinned, or (`everything`) all of it. -> { removed, kept, bytes }
  flush: (everything = false) => post("/krc/media/flush", { everything: Boolean(everything) }),
  previewPurge: (scope, ids) => post("/krc/media/purge/preview", { scope, ids }),
  purge: (scope, options = {}) => post("/krc/media/purge", { scope, ...options }),
  job: (id) => api.fetchApi(`/krc/media/job/${encodeURIComponent(id)}`, { cache: "no-store" }).then(json),
  cancelJob: (id) => post(`/krc/media/job/${encodeURIComponent(id)}/cancel`),
  // Folders: -> { folder }; delete -> { removed, moved } (its items move to Unsorted).
  createFolder: (name, storage = "media") => post("/krc/media/folders/create", { name, storage }),
  outputOptions: () => api.fetchApi("/krc/media/output-options", { cache: "no-store" }).then(json),
  updateFolder: (id, fields) => post(`/krc/media/folders/${encodeURIComponent(id)}`, fields),
  deleteFolder: (id) => post(`/krc/media/folders/${encodeURIComponent(id)}/delete`),
  // The folder AND every item in it. -> { removed, bytes }
  purgeFolder: (id) => post(`/krc/media/folders/${encodeURIComponent(id)}/purge`),
  downloadUrl: (id) => api.apiURL(`/krc/media/download/${encodeURIComponent(id)}`),
  fileUrl: (id) => api.apiURL(`/krc/media/file/${encodeURIComponent(id)}`),
  thumbUrl: (id) => api.apiURL(`/krc/media/thumb/${encodeURIComponent(id)}`),
  // One preview policy for browser cards and every Media slot. Originals are
  // requested only when the shared hold gesture opens its overlay.
  thumbnailSpec: (item, { hidden = false, blurred = false } = {}) => ({
    url: item && !hidden ? mediaApi.thumbUrl(item.id) : "",
    previewImageUrl: item && !hidden && item.kind !== "video" ? mediaApi.fileUrl(item.id) : "",
    previewVideoUrl: item && !hidden && item.kind === "video" ? mediaApi.fileUrl(item.id) : "",
    previewMaxSize: 480,
    blurred,
    placeholderKind: hidden ? "nsfw" : item?.kind === "video" ? "video" : "image",
  }),
};

// Media presets (utils/preset_store.py): exactly 6 slots each, saved on every change.
const presetPath = (id) => `/krc/media/presets/${encodeURIComponent(id)}`;
export const presetsApi = {
  list: () => api.fetchApi("/krc/media/presets", { cache: "no-store" }).then(json),
  create: ({ name = "", auto = false, numbered = false } = {}) => post("/krc/media/presets/create", { name, auto, numbered }),
  rename: (id, name) => post(presetPath(id), { name }),
  // `fields`: { id } (a Media item, "" empties) and / or { name }; `index` 0-5; + { version }:
  // refused with a 409 conflict when the preset changed since that version.
  setSlot: (id, index, fields) => post(`${presetPath(id)}/slot/${Number(index) || 0}`, fields),
  setSlots: (id, ids, start = null) => post(`${presetPath(id)}/slots`, { ids, ...(start === null ? {} : { start }) }),
  remove: (id) => post(`${presetPath(id)}/delete`),
};
