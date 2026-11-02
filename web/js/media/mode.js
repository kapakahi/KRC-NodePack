// The Media: KRC Media's mode in the KRC Portal (GAMEPLAN.md sections 1–5, 7).
// The server's items as cards (thumbnails; IMAGE / VIDEO, duration, Muted, ACTIVE badges; the
// notch menu's colour / favourite / pin, Send to ▸ slot n, Rename and Delete), uploads (a
// dropped or picked image or video previews locally with its settings; a still converts to
// WebP right away, a video / animated GIF to WebM as a background job the page polls, with
// progress and Stop), Flush (sparing what presets use), and the Presets page: the media
// preset editor (its name, its 6 slots: drag a card onto a slot, empty it).
import {
  BROWSER_VIEWS,
  createBrowserSelectionUI,
  normalizeCardColorId,
  createCardColorFilterButton,
  DEFAULT_BROWSER_VIEW,
  browserEmptyNote,
  browserListClass,
  closeFloatingMenu,
  createNodeHostStub,
  ensureSharedStylesheets,
  ensureStylesheet,
  getKrcDragPayload,
  krcBrowserMetrics,
  mountVirtualList,
  updateVirtualList,
  openKrcModal,
  registerLibraryProvider,
  renderLibraryBrowser,
  renderModelCard,
  setNodePalette,
  subscribeKrcSync,
  thumbnailBox,
} from "./krc.js";
import { makeMediaDraggable } from "./drag.js";
import { downloadMedia } from "./download.js";
import { globalShowsNsfw, mediaDisplayState } from "./display.js";
import { MEDIA_EVENT, displayName, formatBytes, formatDuration, mediaApi } from "./api.js";
import { createBatch } from "./batch.js";
import { openPurgeMenu } from "./purge.js";
import { ALL_FOLDERS, INPUT_VIEW, OUTPUT_VIEW, UNSORTED, folderIdOf, folderInView, inFolder, itemInView, renderFolderStrip } from "./folders.js";
import { renderInfoColumn } from "./info_column.js";
import { NODES_EVENT, activeItems, nodesSignature, workflowPresetId } from "./nodes.js";
import { allPresets, onPresets, presetById, presetSlots, presetsLoaded, refreshPresets, setPresetSlot } from "./presets.js";
export const MEDIA_PROVIDER_ID = "media";
export { MEDIA_DRAG_KIND } from "./drag.js";
const STYLE_VERSION = "1.0.6-shared-1671";
// Media offers only thumbnail list and grid; derive from the shared view order.
const MEDIA_VIEWS = Object.freeze(BROWSER_VIEWS.filter((view) => view !== "list"));
const mediaView = (view) => MEDIA_VIEWS.includes(view) ? view : DEFAULT_BROWSER_VIEW;
// While the Media is visible it compares the workflow's Media nodes to what it last
// drew: a workflow-tab switch (or a node edited on the canvas) refreshes the ACTIVE badges.
const NODES_WATCH_MS = 750;
const TAG = "[KRC Media]";
const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const JOB_POLL_MS = 500;

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

function badge(text, modifier, title = "") {
  return el("span", `krc-card-badge krc-mio-badge ${modifier}`, { textContent: text, title });
}

// The IMAGE / VIDEO badge: the nodes' preview type glyph (NodePack's placeholder glyph, read
// once per kind from a thumbnailBox and cloned) + the word, in the kind's own colour.
const kindGlyphs = {};
function kindBadge(kind) {
  const video = kind === "video";
  const key = video ? "video" : "image";
  kindGlyphs[key] ||= thumbnailBox({ className: "krc-mio-glyph-source", placeholderKind: key }).querySelector(".krc-thumb-glyph");
  const pill = el("span", `krc-card-badge krc-mio-badge is-kind is-${key}`);
  if (kindGlyphs[key]) pill.append(kindGlyphs[key].cloneNode(true));
  pill.append(el("span", "krc-mio-badge-text", { textContent: video ? "VIDEO" : "IMAGE" }));
  return pill;
}

// Per-viewer conveniences remembered in this browser (the folder chip, the sort); the
// default when storage is unreadable.
const FOLDER_KEY = "krc-media.media-folder";
const SORT_KEY = "krc-media.media-sort";
const KIND_KEY = "krc-media.media-kind";
const VIEW_KEY = "krc-media.media-storage";
const NSFW_KEY = "krc-media.media-show-nsfw";
function readChoice(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function writeChoice(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private window / blocked storage: just not remembered
  }
}
const readFolderChoice = () => readChoice(FOLDER_KEY, ALL_FOLDERS);
// The tab's NSFW eye: its own remembered choice. The first time, it starts at "Show NSFW by
// default" and is written straight away, so changing that option later leaves it alone.
function readNsfwChoice() {
  const stored = readChoice(NSFW_KEY, "");
  if (stored === "1" || stored === "0") return stored === "1";
  const seeded = globalShowsNsfw();
  writeChoice(NSFW_KEY, seeded ? "1" : "0");
  return seeded;
}
const writeFolderChoice = (value) => writeChoice(FOLDER_KEY, value);

// Date Added = the upload's `created` stamp (ms); names compare as shown, numbers naturally.
const byName = (a, b) => displayName(a).localeCompare(displayName(b), undefined, { numeric: true, sensitivity: "base" });
const SORTS = {
  "date-desc": (a, b) => (b.created || 0) - (a.created || 0),
  "date-asc": (a, b) => (a.created || 0) - (b.created || 0),
  alpha: byName,
  "alpha-desc": (a, b) => byName(b, a),
};
const SORT_OPTIONS = [["date-desc", "Added ▼"], ["date-asc", "Added ▲"], ["alpha", "A-Z"], ["alpha-desc", "Z-A"]];

// The kind filter (one button, cycles): all media -> videos only -> images only.
const KINDS = [
  ["all", "▦", "Showing all media: click for videos only"],
  ["video", "▶", "Showing videos only: click for images only"],
  ["image", "◩", "Showing images only: click for all media"],
];
const kindEntry = (kind) => KINDS.find((entry) => entry[0] === kind) || KINDS[0];
// The trash glyph (an SVG in currentColor: an emoji would draw in its own colours).
const TRASH_SVG = '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5"/></svg>';

function createMediaMode() {
  ensureSharedStylesheets?.();
  ensureStylesheet("krc-media-css", "../krc_media.css", import.meta.url, { version: STYLE_VERSION });

  const state = {
    items: [], loaded: false, error: "", heif: false,
    selected: "", query: "", view: mediaView(DEFAULT_BROWSER_VIEW), page: "info", currentSlot: 0,
    // The Presets page's preset ("" = the workflow's first Media node's, else the first).
    presetId: "",
    favoritesOnly: false, colorFilter: "", showNsfw: readNsfwChoice(),
    // The kind filter (remembered): "all" | "video" | "image".
    kind: kindEntry(readChoice(KIND_KEY, "all"))[0],
    // Folders (the chip strip): Input or Output (remembered; never both), the records, the
    // selected chip (remembered), the chip editor.
    storageView: readChoice(VIEW_KEY, INPUT_VIEW) === OUTPUT_VIEW ? OUTPUT_VIEW : INPUT_VIEW,
    folders: [], folder: readFolderChoice(), folderEditor: null,
    // The sort (ML / LL's sort control; remembered): Added newest / oldest, A-Z, Z-A.
    sort: readChoice(SORT_KEY, "date-desc"),
    // A file being uploaded: { file, url, kind, megapixels, fps, audio, trimIn, trimOut, duration,
    // status: "ready" | "uploading" | "converting" | "error", progress, error, jobId, player }
    pending: null,
  };
  let selectionUI = null;
  const stub = createNodeHostStub({ key: MEDIA_PROVIDER_ID });
  const root = el("div", "krc-node krc-portal-mode krc-mio-media");
  const grid = el("div", "krc-portal-mode-grid");
  const list = el("div");
  const strip = el("div", "krc-mio-folder-slot");
  const info = el("div", "krc-portal-mode-info krc-mio-info");
  const picker = el("input", "krc-mio-file-input", { type: "file", accept: "image/*,video/*,.heic,.heif,.avif,.mkv", hidden: true });
  const cards = new Map();
  // The Batch page's list and runner; it redraws the column as it goes (the column only
  // changes when the batch's own state did).
  const batch = createBatch({
    items: () => state.items,
    // Called later, so it may name uploadFolder (declared below; read now it would throw).
    folder: () => uploadFolder(),
    onChange: () => { if (root.isConnected) renderInfo(); },
  });
  let active = {};

  const selectedItem = () => state.items.find((item) => item.id === state.selected) || null;
  const visible = () => {
    const query = state.query.trim().toLowerCase();
    return state.items
      .filter((item) => (!query || displayName(item).toLowerCase().includes(query))
        && (state.kind === "all" || item.kind === state.kind)
        && itemInView(item, state.storageView)
        && (!state.favoritesOnly || item.favorite)
        && (!state.colorFilter || (state.colorFilter === "__none__" ? !normalizeCardColorId(item.color) : normalizeCardColorId(item.color) === state.colorFilter))
        && !mediaDisplayState(item, state.showNsfw).hidden
        && inFolder(item, state.folder))
      .sort((a, b) => (Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))) || (SORTS[state.sort] || SORTS["date-desc"])(a, b));
  };

  // The Presets page's preset: the one picked here while it exists, else the workflow's, else
  // the first preset.
  const currentPreset = () => presetById(state.presetId) || presetById(workflowPresetId()) || allPresets()[0] || null;
  const usedByPresets = (id) => allPresets().some((preset) => presetSlots(preset).some((slot) => slot.id === id));
  // Is chip `value` one the current view shows? (ALL and Unsorted are in both.)
  const chipInView = (value) => value === ALL_FOLDERS || value === UNSORTED
    || state.folders.some((folder) => folder.id === value && folderInView(folder, state.storageView));
  // Where an upload / a batch goes: the selected Input chip's folder; from the Output view,
  // Unsorted (output folders take outputs, not uploads).
  const uploadFolder = () => (state.storageView === OUTPUT_VIEW ? "" : folderIdOf(state.folder));
  // ---- drawing: any number of triggers -> one redraw on the next frame. The card list is
  // updated in place (each card re-renders only when its signature changed; it's remounted
  // only for a new view or an empty <-> filled switch), and the InfoPanel redraws only when
  // what it shows changed — never while a name is being typed there.
  let drawnNodes = "";
  let mountedView = null;
  let frame = 0;
  const typingInInfo = () => info.contains(document.activeElement) && document.activeElement.matches("input[type=text]");
  const drawList = () => {
    const hasRows = Boolean(list.querySelector(".krc-lora-virtual-spacer"));
    if (mountedView !== state.view || hasRows !== visible().length > 0) {
      mountVirtualList(list, listSource);
      mountedView = state.view;
    } else {
      updateVirtualList(list, listSource);
    }
  };
  const draw = () => {
    frame = 0;
    selectionUI?.refresh();
    drawnNodes = nodesSignature();
    active = activeItems();
    // Not while its editor's name field is being typed in (a chip button's focus is fine).
    if (!(strip.contains(document.activeElement) && document.activeElement.matches("input"))) renderStrip();
    drawList();
    if (!typingInInfo()) renderInfo();
  };
  const refresh = () => {
    if (!frame) frame = requestAnimationFrame(draw);
  };
  const select = (item) => {
    state.selected = item?.id || "";
    if (state.selected && state.page !== "presets") state.page = "info";
    refresh();
  };
  // Re-read the items; an answer identical to what's drawn (the echo of our own change)
  // redraws nothing.
  const reload = async () => {
    const before = JSON.stringify([state.items, state.folders, state.heif, state.error, state.loaded]);
    try {
      const payload = await mediaApi.list();
      state.items = Array.isArray(payload.items) ? payload.items : [];
      state.heif = Boolean(payload.heif);
      state.folders = Array.isArray(payload.folders) ? payload.folders : [];
      if (!chipInView(state.folder)) state.folder = ALL_FOLDERS;
      state.error = "";
    } catch (error) {
      state.error = String(error?.message || error);
      console.warn(`${TAG} couldn't load Media: ${state.error}`);
    }
    state.loaded = true;
    if (state.selected && !selectedItem()) state.selected = "";
    const ids = new Set(state.items.map((item) => item.id));
    for (const id of cards.keys()) if (!ids.has(id)) cards.delete(id);
    if (JSON.stringify([state.items, state.folders, state.heif, state.error, state.loaded]) !== before) refresh();
  };

  // ---- uploads ------------------------------------------------------------------------
  const clearPending = () => {
    state.pending?.player?.video?.pause();
    if (state.pending?.url) URL.revokeObjectURL(state.pending.url);
    state.pending = null;
  };
  const stageFile = (file) => {
    if (!file) return;
    clearPending();
    const name = file.name || "";
    const type = String(file.type || "");
    const kind = VIDEO_FILE.test(name) || type.startsWith("video/") ? "video"
      : IMAGE_FILE.test(name) || type.startsWith("image/") ? "image" : "";
    state.pending = kind
      ? { file, url: URL.createObjectURL(file), kind, megapixels: 0, fps: 0, audio: true, trimIn: 0, trimOut: 0, duration: 0, status: "ready", progress: 0, error: "" }
      : { file, url: "", kind: "", megapixels: 0, status: "error", error: "Upload an image or a video (MP4, MOV, M4V, WebM, MKV, AVI)." };
    state.selected = "";
    state.page = "info";
    refresh();
  };
  const finishPending = async (itemId) => {
    clearPending();
    state.selected = itemId || "";
    await reload();
  };
  const pollJob = async (pending) => {
    if (state.pending !== pending || pending.status !== "converting") return;
    try {
      const { job } = await mediaApi.job(pending.jobId);
      if (state.pending !== pending) return;
      pending.progress = job.progress || 0;
      if (job.status === "done") return finishPending(job.item?.id);
      if (job.status === "cancelled") { clearPending(); renderInfo(); return; }
      if (job.status === "error") {
        pending.status = "error";
        pending.error = job.error || "The conversion failed.";
        renderInfo();
        return;
      }
      renderInfo();
    } catch (error) {
      console.warn(`${TAG} couldn't read the conversion's progress: ${error?.message || error}`);
    }
    setTimeout(() => pollJob(pending), JOB_POLL_MS);
  };
  const startUpload = async () => {
    const pending = state.pending;
    if (!pending || pending.status === "uploading" || pending.status === "converting") return;
    pending.player?.video?.pause();
    pending.status = "uploading";
    pending.error = "";
    renderInfo();
    // Into the selected chip's folder (ALL / Unsorted -> Unsorted).
    const settings = { maxMegapixels: pending.megapixels || 0, folder: uploadFolder() };
    if (pending.kind === "video") {
      Object.assign(settings, { fps: pending.fps, audio: pending.audio !== false, trimIn: pending.trimIn || 0 });
      // The whole clip: no end (the server takes the duration).
      if (pending.trimOut && pending.duration && pending.trimOut < pending.duration - 0.05) settings.trimOut = pending.trimOut;
    }
    try {
      const answer = await mediaApi.upload(pending.file, settings);
      if (answer.job) {
        pending.status = "converting";
        pending.jobId = answer.job.id;
        pending.progress = answer.job.progress || 0;
        renderInfo();
        pollJob(pending);
        return;
      }
      await finishPending(answer.item?.id);
    } catch (error) {
      pending.status = "error";
      pending.error = String(error?.message || error);
      renderInfo();
    }
  };
  const cancelPending = async () => {
    const pending = state.pending;
    if (pending?.status === "converting" && pending.jobId) {
      try {
        await mediaApi.cancelJob(pending.jobId);
      } catch (error) {
        console.warn(`${TAG} couldn't stop the conversion: ${error?.message || error}`);
      }
    }
    clearPending();
    renderInfo();
  };
  picker.addEventListener("change", () => {
    stageFile(picker.files?.[0]);
    picker.value = "";
  });
  const dragHasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
  root.addEventListener("dragover", (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    root.classList.add("is-file-drop");
  });
  root.addEventListener("dragleave", (event) => {
    if (!root.contains(event.relatedTarget)) root.classList.remove("is-file-drop");
  });
  root.addEventListener("drop", (event) => {
    if (!dragHasFiles(event)) return;
    event.preventDefault();
    root.classList.remove("is-file-drop");
    const files = [...(event.dataTransfer.files || [])];
    // Several files (or any drop while on Batch): the batch list; one file: the Preview flow.
    if (files.length > 1 || state.page === "batch") {
      batch.add(files);
      state.page = "batch";
      refresh();
      return;
    }
    stageFile(files[0]);
  });

  // ---- card actions -------------------------------------------------------------------
  const patchItem = async (item, fields) => {
    selectionUI?.endForEdit();
    const previous = { ...item };
    Object.assign(item, fields);   // optimistic; the reload below settles it
    refresh();
    try {
      const { item: saved } = await mediaApi.update(item.id, fields);
      Object.assign(item, saved);
      await reload();
      return true;
    } catch (error) {
      Object.assign(item, previous);
      refresh();
      console.warn(`${TAG} couldn't save ${displayName(item)}: ${error?.message || error}`);
      await reload();
      openKrcModal({ node: stub, title: "Couldn't save media", body: [String(error?.message || error)], actions: [{ label: "Close", onClick: ({ close }) => close() }] });
      return false;
    }
  };
  // The card menu's slot boxes (NodePack 1.17 quickExtra): the Presets page's preset's 6
  // slots as numbered boxes — empty, dim green (another card is in it), green (this card).
  // A click puts the card in that slot, or (green) takes it out; the menu stays open and the
  // boxes redraw from the saved preset.
  const slotBoxes = (item) => () => {
    const wrap = el("div", "krc-mio-menu-slots");
    const preset = currentPreset();
    if (!preset) {
      wrap.append(el("div", "krc-mio-send-note", { textContent: "No media preset yet: a new Media Loader node, or + New preset on the Presets page, makes one." }));
      return wrap;
    }
    const label = el("div", "krc-mio-menu-slots-label", { textContent: preset.name, title: "The Presets page's preset" });
    const row = el("div", "krc-mio-menu-slots-row");
    const draw = () => {
      const slots = presetSlots(presetById(preset.id));
      row.replaceChildren(...slots.map((slot, index) => {
        const here = slot.id === item.id;
        const box = el("button", `krc-mio-menu-slot${here ? " is-this" : slot.id ? " is-taken" : " is-empty"}`, {
          type: "button",
          textContent: String(index + 1),
          title: `Slot ${index + 1}: ${here ? "this card (click to take it out)" : slot.id ? "another card (click to replace it)" : "empty (click to put this card here)"}`,
        });
        box.addEventListener("click", async (event) => {
          event.stopPropagation();
          row.classList.add("is-busy");
          await setPresetSlot(preset.id, index, { id: here ? "" : item.id });
          row.classList.remove("is-busy");
          if (!here) {
            state.presetId = preset.id;
            state.currentSlot = index;
          }
          if (wrap.isConnected) draw();
        });
        return box;
      }));
    };
    draw();
    wrap.append(label, row);
    return wrap;
  };

  // ---- folders -------------------------------------------------------------------------
  const moveTo = (itemId, folderId) => {
    const item = state.items.find((entry) => entry.id === itemId);
    if (item && (item.folder || "") !== folderId) patchItem(item, { folder: folderId });
  };
  // The notch menu's Move to: Unsorted, then the folders of the card's own view (Input or
  // Output), the current one ticked.
  const moveMode = (item) => (_config, _context, setMode) => {
    const view = el("div", "krc-mio-send");
    view.append(el("button", "krc-card-menu-mode-back", { type: "button", textContent: "‹", title: "Back", onclick: () => setMode("quick") }));
    const itemView = itemInView(item, OUTPUT_VIEW) ? OUTPUT_VIEW : INPUT_VIEW;
    const targets = state.folders.filter((folder) => folderInView(folder, itemView)).map((folder) => [folder.id, folder.name]);
    for (const [id, name] of [["", "Unsorted"], ...targets]) {
      view.append(el("button", "krc-card-menu-item krc-mio-send-slot", {
        type: "button",
        textContent: `${name}${(item.folder || "") === id ? " ✓" : ""}`,
        onclick: (event) => { event.stopPropagation(); closeFloatingMenu(); moveTo(item.id, id); },
      }));
    }
    if (!state.folders.length) view.append(el("div", "krc-mio-send-note", { textContent: "No folders yet: + on the chip strip makes one." }));
    return view;
  };
  const renderStrip = () => {
    strip.replaceChildren(renderFolderStrip({
      folders: state.folders,
      storageView: state.storageView,
      active: state.folder,
      editor: state.folderEditor,
      countOf: (id) => state.items.filter((item) => item.folder === id).length,
      inPresetsOf: (id) => state.items.filter((item) => item.folder === id && usedByPresets(item.id)).length,
      dragPayload: () => getKrcDragPayload?.(),
      onSelect: (value) => {
        state.folder = value;
        selectionUI?.refresh();
        writeFolderChoice(value);
        refresh();
      },
      onEdit: (editor) => { state.folderEditor = editor; refresh(); },
      onChanged: () => reload(),
      onMove: moveTo,
    }));
  };

  const cardSource = {
    keyOf: (item) => item.id,
    setCardKey: (card, _item, key) => { card.dataset.krcCardKey = key; },
    isSelected: (item) => item.id === state.selected,
    cardColor: (item) => item.color || "",
    resolveThumbnail: (item) => mediaApi.thumbnailSpec(item, mediaDisplayState(item, state.showNsfw)),
    nameText: (item) => displayName(item),
    subtitleText: (item) => [item.width && item.height ? `${item.width}×${item.height}` : "",
      item.kind === "video" && item.fps ? `${item.fps} fps` : "", formatBytes(item.bytes)].filter(Boolean).join(" · "),
    fillBadgeRow: (row, item) => {
      const badges = [];
      if (item.favorite) badges.push(el("span", "krc-badge-star", { textContent: "★", title: "Favourite" }));   // leads, as in the other KRC browsers
      if (item.nsfw) badges.push(el("span", "krc-card-badge krc-nsfw-badge", { textContent: "NSFW" }));
      if (item.customBadge) badges.push(el("span", "krc-card-badge is-json", { textContent: item.customBadge }));
      badges.push(kindBadge(item.kind));
      if (item.kind === "video" && item.duration) badges.push(badge(formatDuration(item.duration), "is-duration"));
      if (item.kind === "video" && item.audio === false) badges.push(badge("Muted", "is-muted", "No audio"));
      if (active[item.id]) badges.push(badge("Active", "is-active", `Loaded by this workflow: ${active[item.id].join(", ")}`));
      row.append(...badges);
      return badges.length;
    },
    isPinned: (item) => Boolean(item.pinned),
    notchMenu: (item) => ({
      title: displayName(item),
      quickActions: {
        color: { value: item.color || "", title: "Card colour", onChange: (value) => patchItem(item, { color: value || "" }) },
        customBadge: { active: Boolean(item.customBadge), value: item.customBadge || "", onSave: (customBadge) => patchItem(item, { customBadge }) },
        favorite: { active: Boolean(item.favorite), title: item.favorite ? "Remove favourite" : "Favourite", onToggle: () => patchItem(item, { favorite: !item.favorite }) },
        pin: { active: Boolean(item.pinned), title: item.pinned ? "Unpin" : "Pin", onToggle: () => patchItem(item, { pinned: !item.pinned }) },
        nsfw: { active: Boolean(item.nsfw), title: item.nsfw ? "Remove NSFW tag" : "Tag as NSFW", onToggle: () => patchItem(item, { nsfw: !item.nsfw }) },
      },
      actions: [
        { id: "download", label: "Download", onClick: () => downloadMedia(item) },
        { id: "move", label: "Move to…", mode: "move" },
        { id: "rename", label: "Rename…", mode: "rename" },
        {
          id: "delete",
          label: "Delete",
          danger: true,
          confirm: true,
          confirmLabel: usedByPresets(item.id) ? "Delete? (a preset uses it)" : "Delete?",
          onClick: async () => {
            try {
              await mediaApi.remove(item.id);
            } catch (error) {
              console.warn(`${TAG} couldn't delete ${displayName(item)}: ${error?.message || error}`);
            }
            if (state.selected === item.id) state.selected = "";
            reload();
          },
        },
      ],
      modes: { move: moveMode(item) },
      quickExtra: slotBoxes(item),
      // NodePack's built-in rename row (the "rename" mode).
      rename: {
        value: displayName(item),
        maxLength: 80,
        title: "Rename (only the name shown; the file is kept)",
        onSave: async (name) => {
          const clean = String(name || "").trim();
          if (!clean) return false;
          if (clean !== displayName(item)) await patchItem(item, { name: clean });
          return true;
        },
      },
    }),
    installInteractions: (card, item) => {
      card.addEventListener("click", () => select(item));
      // A double-click always shows the card on the Preview page (from the Presets page
      // too); the Portal itself opens the info column when it's closed.
      card.addEventListener("dblclick", () => {
        state.page = "info";
        select(item);
      });
      makeMediaDraggable(card, () => {
        const controller = selectionUI?.controller;
        if (controller?.status().busy) return null;
        if (controller?.status().active && controller.has(item.id)) return visible().filter(entry => controller.has(entry.id));
        return state.items.find(entry => entry.id === item.id);
      });
    },
  };

  const listSource = {
    view: () => state.view,
    listClass: () => browserListClass(state.view),
    visibleItems: visible,
    metrics: (view) => krcBrowserMetrics(view),
    keyOf: (item) => item.id,
    selectedKey: () => state.selected,
    selectItem: select,
    cardFor: (item) => {
      const signature = JSON.stringify([item, item.id === state.selected, state.view, active[item.id] || null, mediaDisplayState(item, state.showNsfw)]);
      const cached = cards.get(item.id);
      if (cached?.signature === signature) return cached.node;
      const node = renderModelCard(item, cardSource, { viewMode: state.view });
      cards.set(item.id, { signature, node });
      return node;
    },
    renderEmpty: () => browserEmptyNote(
      state.error ? `Media couldn't load: ${state.error}`
        : !state.loaded ? "Loading…"
          : state.storageView === OUTPUT_VIEW && !state.items.some((item) => itemInView(item, OUTPUT_VIEW)) ? "No outputs yet"
            : state.items.length ? "No media matches"
              : "Media is empty: drop images or videos here",
    ),
  };

  const syncNsfwButton = () => {
    const visibility = mediaDisplayState({ nsfw: true }, state.showNsfw);
    const button = browser.querySelector(".krc-browser-actions .krc-nsfw-button");
    if (!button) return;
    const shown = !visibility.hidden && !visibility.blurred;
    button.classList.toggle("is-active", shown);
    button.title = shown ? "Showing NSFW media" : visibility.blurred ? "NSFW media is blurred; click to show" : "NSFW media is hidden; click to show";
  };
  const changeColorFilter = (value) => {
    state.colorFilter = value;
    browser.querySelector(".krc-card-color-filter-button")?.replaceWith(createCardColorFilterButton({ value, onChange: changeColorFilter }));
    refresh();
  };
  const browser = renderLibraryBrowser({
    panelClass: "krc-panel krc-browser krc-mio-browser",
    title: "Media",
    controls: [
      {
        kind: "select",
        className: "krc-sort-select",
        title: "Sort Media",
        value: state.sort,
        options: SORT_OPTIONS,
        onChange: (value) => {
          if (!SORTS[value]) return;
          state.sort = value;
          writeChoice(SORT_KEY, value);
          refresh();
        },
      },
      { kind: "favorite", active: state.favoritesOnly, onClick: (event) => {
        state.favoritesOnly = !state.favoritesOnly;
        event?.currentTarget?.classList.toggle("is-active", state.favoritesOnly);
        refresh();
      } },
      { kind: "color", value: state.colorFilter, onChange: changeColorFilter },
      { kind: "nsfw", active: state.showNsfw, title: "Show NSFW media", onClick: () => {
        state.showNsfw = !state.showNsfw;
        writeChoice(NSFW_KEY, state.showNsfw ? "1" : "0");
        syncNsfwButton();
        refresh();
      } },
      { kind: "view", views: MEDIA_VIEWS, current: state.view, onChange: (view) => {
        state.view = mediaView(view);
        // The shared toggle doesn't restyle itself (the built-in modes re-render their header).
        browser.querySelectorAll(".krc-view-toggle > button").forEach((button, index) => {
          button.classList.toggle("is-active", MEDIA_VIEWS[index] === state.view);
        });
        refresh();
      } },
    ],
    search: {
      placeholder: state.storageView === OUTPUT_VIEW ? "Search Output Media…" : "Search Input Media…",
      onInput: (value) => { state.query = value || ""; refresh(); },
      onClear: () => { state.query = ""; refresh(); },
    },
    slots: [strip, list],
  });
  syncNsfwButton();
  const actions = browser.querySelector(".krc-browser-actions");
  const kindButton = el("button", "krc-icon-button krc-mio-kind-filter", { type: "button" });
  const syncKindButton = () => {
    const [kind, glyph, title] = kindEntry(state.kind);
    kindButton.textContent = glyph;
    kindButton.title = title;
    kindButton.dataset.kind = kind;
    kindButton.classList.toggle("is-active", kind !== "all");
  };
  kindButton.addEventListener("click", () => {
    const index = KINDS.findIndex((entry) => entry[0] === state.kind);
    state.kind = KINDS[(index + 1) % KINDS.length][0];
    writeChoice(KIND_KEY, state.kind);
    syncKindButton();
    refresh();
  });
  syncKindButton();
  // Input / Output folders: label the current view, with one button to switch.
  const viewButton = el("button", "krc-action-button krc-mio-storage-toggle", { type: "button" });
  const syncViewButton = () => {
    const output = state.storageView === OUTPUT_VIEW;
    viewButton.textContent = output ? "OUTPUT" : "INPUT";
    viewButton.title = output ? "Output folders (what the workflow saved): click for Input" : "Input folders (uploads): click for Output";
    viewButton.classList.toggle("is-output", output);
    const search = browser.querySelector("input.krc-search");
    if (search) search.placeholder = output ? "Search Output Media…" : "Search Input Media…";
  };
  const setStorageView = (view) => {
    state.storageView = view === OUTPUT_VIEW ? OUTPUT_VIEW : INPUT_VIEW;
    state.folderEditor = null;
    if (!chipInView(state.folder)) {
      state.folder = ALL_FOLDERS;
      writeFolderChoice(state.folder);
    }
    writeChoice(VIEW_KEY, state.storageView);
    syncViewButton();
    selectionUI?.refresh();
    refresh();
  };
  viewButton.addEventListener("click", () => setStorageView(state.storageView === OUTPUT_VIEW ? INPUT_VIEW : OUTPUT_VIEW));
  syncViewButton();
  // Delete (the global one: scopes in a menu, then a confirm), a trash glyph.
  const flush = el("button", "krc-icon-button krc-mio-delete", {
    type: "button",
    innerHTML: TRASH_SVG,
    title: "Delete Media…",
    onclick: () => openPurgeMenu({ anchor: flush, node: stub, controller: selectionUI?.controller,
      onChanged: async () => { state.selected = ""; await reload(); },
    }),
  });
  flush.setAttribute("aria-label", "Delete Media");
  actions?.append(kindButton, viewButton, flush);
  const bulkOperation = (kind) => ({
    node: stub, kind, noun: "media items", title: kind === "delete" ? "Delete selected media" : "Move selected media",
    destinationLabel: "Folder",
    async preview(ids) {
      const result = await mediaApi.previewOperation(ids, kind);
      if (kind === "delete") result.message += ` ${ids.filter((id) => active[id]).length} selected items are loaded by this workflow.`;
      return result;
    },
    async execute(ids, options) {
      const result = await mediaApi.bulkOperation(ids, kind, options);
      await reload();
      return result;
    },
  });
  selectionUI = createBrowserSelectionUI({
    attributes: {
      read: (item, field) => item[field === "cardColor" ? "color" : field],
      async apply(ids, field, value) {
        const result = await mediaApi.bulkAttributes(ids, field, value);
        const saved = new Map(result.items.map((item) => [item.id, item]));
        for (const item of state.items) if (saved.has(item.id)) Object.assign(item, saved.get(item.id));
        refresh();
        return result;
      },
    },
    items: visible,
    allItems: () => state.items,
    scope: () => `${state.storageView}:${state.folder}`,
    filters: () => [state.query, state.favoritesOnly, state.colorFilter, state.kind, state.showNsfw, mediaDisplayState({ nsfw: true }, state.showNsfw)],
    keyOf: (item) => item.id,
    focusedKey: () => state.selected,
    isFiltered: () => Boolean(state.query || state.favoritesOnly || state.colorFilter || state.kind !== "all" || state.folder !== ALL_FOLDERS),
    actions: () => [
      { id: "move", label: "Move to folder…", operation: bulkOperation("move") },
      { id: "delete", label: "Delete", danger: true, operation: bulkOperation("delete") },
    ],
  });
  selectionUI.mount(browser, { after: flush });

  let infoDrawn = null;
  const renderInfo = () => {
    // Everything the column shows; unchanged -> keep its DOM (a playing video, a focused field).
    const pending = state.pending;
    const preset = currentPreset();
    const shownIds = new Set([state.selected, ...presetSlots(preset).map((slot) => slot.id)].filter(Boolean));
    const key = JSON.stringify([state.page, selectedItem(), state.heif, preset, state.currentSlot, presetsLoaded(),
      pending && [pending.url, pending.kind, pending.status, Math.round((pending.progress || 0) * 100), pending.error,
        pending.megapixels, pending.fps, pending.audio, pending.trimIn, pending.trimOut, pending.duration],
      state.page === "info" ? allPresets() : null, state.items.filter((item) => shownIds.has(item.id)),
      state.folders, state.folder, state.storageView, state.showNsfw, mediaDisplayState({ nsfw: true }, state.showNsfw), state.page === "batch" ? batch.signature() : null]);
    if (key === infoDrawn && info.childElementCount) return;
    infoDrawn = key;
    // Replacing the column empties it for a moment, which clamps every scroll position to 0:
    // remember them (by element class) and put them back.
    const scrolled = [info, ...info.querySelectorAll("*")]
      .filter((element) => element.scrollTop > 0 && (element === info || element.classList.length))
      .map((element) => [element === info ? null : `.${[...element.classList].join(".")}`, element.scrollTop]);
    info.replaceChildren(renderInfoColumn({
      page: state.page,
      selected: selectedItem(),
      pending,
      heif: state.heif,
      preset,
      onPreset: (id) => { state.presetId = id; state.currentSlot = 0; renderInfo(); },
      onPage: (page) => { state.page = page; renderInfo(); },
      onPick: () => picker.click(),
      onPending: (fields) => { if (state.pending) { Object.assign(state.pending, fields); renderInfo(); } },
      onUpload: startUpload,
      onCancel: cancelPending,
      onPatch: patchItem,
      showNsfw: state.showNsfw,
      folderName: (id) => (id ? state.folders.find((folder) => folder.id === id)?.name || "Unsorted" : "Unsorted"),
      uploadFolder: uploadFolder(),
      currentSlot: state.currentSlot,
      isCurrentPreset: id => state.presetId === id,
      onCurrentSlot: (index) => { state.currentSlot = index; renderInfo(); },
      itemById: (id) => state.items.find((item) => item.id === id) || null,
      dragPayload: () => getKrcDragPayload?.(),
      batch,
    }));
    for (const [selector, top] of scrolled) {
      const element = selector ? info.querySelector(selector) : info;
      if (element) element.scrollTop = top;
    }
  };

  grid.append(browser, info);
  root.append(grid, picker, batch.picker);
  subscribeKrcSync(MEDIA_EVENT, () => reload());
  window.addEventListener("krc-global-nsfw-default-changed", () => { syncNsfwButton(); if (root.isConnected) refresh(); });
  window.addEventListener(NODES_EVENT, () => { if (root.isConnected) refresh(); });
  // A preset change (here, on a node, or another page) redraws what it touches.
  onPresets(() => { if (root.isConnected) refresh(); });

  // The nodes watch (NODES_WATCH_MS): runs only while the mode is on screen (the Portal has
  // no hide hook, so a tick that finds the root gone or hidden stops it; onShow restarts it).
  // A name being typed is never re-rendered away.
  let nodesWatch = 0;
  const watchNodes = () => {
    if (nodesWatch) return;
    nodesWatch = setInterval(() => {
      if (!root.isConnected || root.offsetParent === null) {
        clearInterval(nodesWatch);
        nodesWatch = 0;
        return;
      }
      if (info.contains(document.activeElement) && document.activeElement.matches("input")) return;
      if (nodesSignature() !== drawnNodes) refresh();
    }, NODES_WATCH_MS);
  };

  return {
    getRoot: () => root,
    onShow: () => { syncNsfwButton(); reload(); refreshPresets(); watchNodes(); },
    setPalette: (id) => setNodePalette(stub, root, id),
    // { preset, slot } (a node's MEDIA): the Presets page on that preset, the slot
    // previewed; else an item id.
    select: (selection) => {
      if (selection && typeof selection === "object" && "folder" in selection) {
        state.page = "info";
        const target = state.folders.find((folder) => folder.id === selection.folder);
        if (selection.view === OUTPUT_VIEW) {
          // An Output node's MEDIA: always the Output view, on its folder, else Unsorted (Default).
          state.storageView = OUTPUT_VIEW;
          state.folder = target && folderInView(target, OUTPUT_VIEW) ? target.id : UNSORTED;
        } else {
          state.folder = String(selection.folder || ALL_FOLDERS);
          // An output folder opens the Output view; anything else, Input.
          state.storageView = target && folderInView(target, OUTPUT_VIEW) ? OUTPUT_VIEW : INPUT_VIEW;
        }
        writeChoice(VIEW_KEY, state.storageView);
        syncViewButton();
        state.query = "";
        state.favoritesOnly = false;
        state.colorFilter = "";
        state.kind = "all";
        writeChoice(KIND_KEY, state.kind);
        syncKindButton();
        state.selected = "";
        browser.querySelector(".krc-search-clear")?.click();
        browser.querySelector(".krc-favorite-button")?.classList.remove("is-active");
        changeColorFilter("");
        writeFolderChoice(state.folder);
        selectionUI?.refresh();
        refresh();
        reload();
        return;
      }
      if (selection && typeof selection === "object" && "preset" in selection) {
        state.page = "presets";
        state.presetId = String(selection.preset || "");
        state.currentSlot = Math.min(Math.max(Number(selection.slot) || 0, 0), 5);
        refresh();
        return;
      }
      const id = String(selection?.id ?? selection ?? "");
      if (state.items.some((item) => item.id === id)) select({ id });
    },
    getSelection: () => selectedItem(),
    // "Remember where I was" (NodePack API 1.18): the selected item, the page (Preview /
    // Presets) and the preset + slot shown. The folder chip and the sort keep their own
    // storage. A deleted item is dropped by the next reload (nothing selected).
    getState: () => ({ selected: state.selected, page: state.page, presetId: state.presetId, currentSlot: state.currentSlot }),
    restoreState: (saved) => {
      if (!saved || typeof saved !== "object") return;
      state.selected = String(saved.selected || "");
      state.page = ["presets", "batch"].includes(saved.page) ? saved.page : "info";
      state.presetId = String(saved.presetId || "");
      state.currentSlot = Math.min(Math.max(Number(saved.currentSlot) || 0, 0), 5);
      refresh();
    },
  };
}

registerLibraryProvider({ id: MEDIA_PROVIDER_ID, label: "Media", order: 10, create: createMediaMode });
