// The Media tab's Batch page (GAMEPLAN.md section 2): many files at once. The left column is
// the list (queued ○, in progress ◐ n%, done ✓ in green, failed ! with Retry, skipped
// duplicates), the right column a 1:1 preview of the file in progress (or the row clicked)
// with the batch's total progress under it; below both, one cell of common controls:
// Images (max megapixels, keep transparency), Videos (max megapixels, FPS, audio, max
// length), Skip duplicates, the target folder, Choose files / Start / Stop / Clear done.
// Files go one at a time (a video waits for its conversion), into the folder that was
// selected when Start was pressed. The list lives in this page (a reload loses what wasn't
// sent: browsers can't keep picked files); the controls are remembered in this browser.
import { openNumericPopover, switchToggle } from "./krc.js";
import { displayName, formatBytes, mediaApi } from "./api.js";
import { mediaPreview } from "./preview.js";

const IMAGE_FILE = /\.(png|jpe?g|webp|gif|bmp|tiff?|heic|heif|avif)$/i;
const VIDEO_FILE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;
const IMAGE_MAX_BYTES = 200 * 1024 * 1024;        // the server's caps (media_routes.py)
const VIDEO_MAX_BYTES = 4 * 1024 * 1024 * 1024;
const JOB_POLL_MS = 500;
const SETTINGS_KEY = "krc-media.batch-settings";
const TAG = "[KRC Media]";

// The choices (mirror MEGAPIXELS / CUSTOM_MEGAPIXELS / FPS_CHOICES / MAX_LENGTHS /
// CUSTOM_FPS / CUSTOM_LENGTH in utils/process_*.py).
export const MEGAPIXELS = [0, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1, 2];
export const CUSTOM_MEGAPIXELS = [0.1, 64];
export const CUSTOM_FPS = [1, 60];
export const CUSTOM_LENGTH = [1, 600];
export const FPS_CHOICES = [0, 30, 24, 16, 12, 8];
export const MAX_LENGTHS = [0, 5, 10, 30, 60];
const DEFAULT_SETTINGS = { imageMp: 0, keepAlpha: true, videoMp: 0, fps: 0, audio: true, maxLength: 0, skipDuplicates: true };

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // not remembered
  }
}

export const kindOf = (file) => {
  const name = file?.name || "";
  const type = String(file?.type || "");
  return VIDEO_FILE.test(name) || type.startsWith("video/") ? "video"
    : IMAGE_FILE.test(name) || type.startsWith("image/") ? "image" : "";
};

// The batch: its entries and the runner. `host`: { items() (the Media items), folder() (the
// selected chip's folder id, "" = Unsorted), onChange() }.
export function createBatch(host) {
  let nextId = 1;
  const batch = {
    entries: [],          // { id, file, name, size, kind, url, status, progress, error, itemId, jobId }
    running: false,
    target: "",           // the folder fixed when Start was pressed
    pinned: "",           // a clicked row (the preview stays on it); "" = follow the active one
    settings: readSettings(),
  };
  const changed = () => host.onChange();

  const entryError = (file, kind) => {
    if (!kind) return "Not an image or a video";
    if (file.size > (kind === "video" ? VIDEO_MAX_BYTES : IMAGE_MAX_BYTES)) return `Too large (over ${kind === "video" ? "4 GB" : "200 MB"})`;
    return "";
  };

  batch.add = (files) => {
    for (const file of files || []) {
      const kind = kindOf(file);
      const error = entryError(file, kind);
      batch.entries.push({
        id: nextId++, file, name: file.name || "file", size: file.size || 0, kind,
        url: !error ? URL.createObjectURL(file) : "",
        status: error ? "error" : "queued", progress: 0, error, itemId: "", jobId: "", invalid: Boolean(error),
      });
    }
    changed();
  };

  const release = (entry) => {
    if (entry.url) URL.revokeObjectURL(entry.url);
    entry.url = "";
  };

  batch.remove = (id) => {
    const entry = batch.entries.find((item) => item.id === id);
    if (!entry || ["uploading", "converting"].includes(entry.status)) return;
    release(entry);
    batch.entries = batch.entries.filter((item) => item !== entry);
    if (batch.pinned === id) batch.pinned = "";
    changed();
  };

  batch.clearDone = () => {
    for (const entry of batch.entries) if (entry.status === "done" || entry.status === "duplicate") release(entry);
    batch.entries = batch.entries.filter((entry) => entry.status !== "done" && entry.status !== "duplicate");
    if (!batch.entries.some((entry) => entry.id === batch.pinned)) batch.pinned = "";
    changed();
  };

  batch.clearAll = () => {
    const busy = (entry) => entry.status === "uploading" || entry.status === "converting";
    for (const entry of batch.entries) if (!busy(entry)) release(entry);
    batch.entries = batch.entries.filter(busy);
    batch.pinned = "";
    changed();
  };

  batch.retry = (id) => {
    const entry = batch.entries.find((item) => item.id === id);
    if (!entry || entry.status !== "error" || entry.invalid) return;
    Object.assign(entry, { status: "queued", progress: 0, error: "" });
    changed();
    if (!batch.running) batch.start();
  };

  batch.pin = (id) => {
    batch.pinned = batch.pinned === id ? "" : id;
    changed();
  };

  batch.setSettings = (fields) => {
    batch.settings = { ...batch.settings, ...fields };
    writeSettings(batch.settings);
    changed();
  };

  const isDuplicate = (entry) => host.items().some((item) => item.source?.name === entry.name
    && Number(item.source?.bytes) === entry.size && (item.folder || "") === batch.target);

  const uploadSettings = (entry) => {
    const s = batch.settings;
    return entry.kind === "video"
      ? { folder: batch.target, maxMegapixels: s.videoMp, fps: s.fps, audio: s.audio, maxLength: s.maxLength }
      : { folder: batch.target, maxMegapixels: s.imageMp, keepAlpha: s.keepAlpha };
  };

  const waitForJob = async (entry) => {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
      let job;
      try {
        ({ job } = await mediaApi.job(entry.jobId));
      } catch (error) {
        console.warn(`${TAG} batch: couldn't read the conversion's progress: ${error?.message || error}`);
        continue;
      }
      entry.progress = job.progress || 0;
      if (job.status === "done") return { ok: true, itemId: job.item?.id || "" };
      if (job.status === "cancelled") return { ok: false, cancelled: true };
      if (job.status === "error") return { ok: false, error: job.error || "The conversion failed." };
      changed();
    }
  };

  const runOne = async (entry) => {
    if (batch.settings.skipDuplicates && isDuplicate(entry)) {
      entry.status = "duplicate";
      return;
    }
    entry.status = "uploading";
    entry.progress = 0;
    changed();
    try {
      const answer = await mediaApi.upload(entry.file, uploadSettings(entry));
      if (answer.job) {
        entry.status = "converting";
        entry.jobId = answer.job.id;
        changed();
        const result = await waitForJob(entry);
        if (result.cancelled) {
          Object.assign(entry, { status: "queued", progress: 0, jobId: "" });   // Stop: back in the queue
          return;
        }
        if (!result.ok) throw new Error(result.error);
        entry.itemId = result.itemId;
      } else {
        entry.itemId = answer.item?.id || "";
      }
      entry.status = "done";
      entry.progress = 1;
    } catch (error) {
      Object.assign(entry, { status: "error", error: String(error?.message || error) });
    }
  };

  batch.start = async () => {
    if (batch.running || !batch.entries.some((entry) => entry.status === "queued")) return;
    batch.running = true;
    batch.stopping = false;
    batch.target = host.folder();
    changed();
    for (;;) {
      const entry = batch.entries.find((item) => item.status === "queued");
      if (!entry || batch.stopping) break;
      await runOne(entry);
      changed();
    }
    batch.running = false;
    batch.stopping = false;
    changed();
  };

  // Stop: the file in progress — a still finishes (it's one request), a converting video
  // is cancelled and goes back in the queue; nothing after it starts.
  batch.stop = async () => {
    if (!batch.running) return;
    batch.stopping = true;
    const current = batch.entries.find((entry) => entry.status === "converting");
    if (current?.jobId) {
      try {
        await mediaApi.cancelJob(current.jobId);
      } catch (error) {
        console.warn(`${TAG} batch: couldn't stop the conversion: ${error?.message || error}`);
      }
    }
    changed();
  };

  batch.counts = () => {
    const counts = { total: batch.entries.length, done: 0, failed: 0, skipped: 0 };
    for (const entry of batch.entries) {
      if (entry.status === "done") counts.done += 1;
      else if (entry.status === "error") counts.failed += 1;
      else if (entry.status === "duplicate") counts.skipped += 1;
    }
    return counts;
  };

  // What the page shows, for the InfoPanel's "did anything change" key.
  batch.signature = () => JSON.stringify([batch.running, batch.stopping, batch.target, batch.pinned, batch.settings,
    batch.entries.map((entry) => [entry.id, entry.status, Math.round((entry.progress || 0) * 100), entry.itemId, entry.error])]);

  // The file the preview shows: the clicked row, else the one in progress, else the last done.
  batch.previewEntry = () => batch.entries.find((entry) => entry.id === batch.pinned)
    || batch.entries.find((entry) => entry.status === "uploading" || entry.status === "converting")
    || [...batch.entries].reverse().find((entry) => entry.status === "done") || null;

  batch.picker = el("input", "krc-mio-file-input", { type: "file", multiple: true, accept: "image/*,video/*,.heic,.heif,.avif,.mkv", hidden: true });
  batch.picker.addEventListener("change", () => {
    batch.add([...(batch.picker.files || [])]);
    batch.picker.value = "";
  });
  return batch;
}

// ---- the page -----------------------------------------------------------------------------
// A row of choice buttons (right-aligned where the page says so), then Custom… : NodePack's
// number popover, whose value then shows on that chip. `spec`: { values, label(value),
// title(value), custom: { range [min, max], slider [min, max, step], start, unit, name } }.
function customChoices(current, onChange, spec, { disabled = false } = {}) {
  const [low, high] = spec.custom.range;
  const clamp = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return Math.round(Math.min(Math.max(number, low), high) * 1000) / 1000;
  };
  const row = el("div", "krc-mio-choices");
  for (const value of spec.values) {
    row.append(el("button", `krc-mio-choice${value === current ? " is-active" : ""}`, {
      type: "button", textContent: spec.label(value), title: spec.title(value), disabled, onclick: () => onChange(value),
    }));
  }
  const custom = Boolean(current) && !spec.values.includes(current);
  const chip = el("button", `krc-mio-choice krc-mio-custom${custom ? " is-active" : ""}`, {
    type: "button", textContent: custom ? spec.label(current) : "Custom…", disabled,
    title: `A custom ${spec.custom.name} (${low}-${high}${spec.custom.unit})`,
  });
  chip.addEventListener("click", (event) => {
    event.stopPropagation();
    const root = chip.closest(".krc-mio-media");
    if (!root) return;
    const [sliderMin, sliderMax, step] = spec.custom.slider;
    openNumericPopover({
      root,
      anchor: chip,
      initialValue: custom ? current : spec.custom.start,
      classes: { popover: "krc-mio-mp-popover", input: "krc-mio-mp-input", slider: "krc-mio-mp-slider", nudge: "krc-mio-mp-nudge", sliderRow: "krc-mio-mp-slider-row" },
      ariaLabel: `Custom ${spec.custom.name}`,
      title: spec.custom.name[0].toUpperCase() + spec.custom.name.slice(1),
      inputAriaLabel: spec.custom.name,
      slider: { min: sliderMin, max: sliderMax, step, value: (value) => Math.min(Math.max(clamp(value), sliderMin), sliderMax), ariaLabel: `${spec.custom.name} slider` },
      nudge: { step, downTitle: `${step} less`, upTitle: `${step} more` },
      formatValue: (value) => String(clamp(value)),
      sanitizeInput: (value) => String(value ?? "").replace(/[^0-9.]/g, ""),
      isPartialInput: (value) => !value || value === ".",
      normalizeValue: clamp,
      onCommit: (value) => { const picked = clamp(value); if (picked) onChange(picked); },
    });
  });
  row.append(chip);
  return row;
}

// Max megapixels (None, 0.3-0.9, 1, 2, Custom… 0.1-64). Shared with the Preview page.
export function mpChoices(current, onChange, options) {
  return customChoices(current, onChange, {
    values: MEGAPIXELS,
    label: (value) => (value ? String(value) : "None"),
    title: (value) => (value ? `At most ${value} megapixels (aspect kept)` : "Keep the full size"),
    custom: { range: CUSTOM_MEGAPIXELS, slider: [0.1, 8, 0.1], start: 1.5, unit: " MP", name: "maximum in megapixels" },
  }, options);
}

// FPS (Source, 30 … 8, Custom… 1-60, decimals allowed). Shared with the Preview page.
export function fpsChoices(current, onChange, options) {
  return customChoices(current, onChange, {
    values: FPS_CHOICES,
    label: (value) => (value ? String(value) : "Source"),
    title: (value) => (value ? `Convert to ${value} fps` : "Keep the video's own frame rate"),
    custom: { range: CUSTOM_FPS, slider: [1, 60, 1], start: 20, unit: " fps", name: "frame rate" },
  }, options);
}

// Length (Full, 5 … 60 s, Custom… 1-600 s).
export function lengthChoices(current, onChange, options) {
  return customChoices(current, onChange, {
    values: MAX_LENGTHS,
    label: (value) => (value ? `${value} s` : "Full"),
    title: (value) => (value ? `Keep at most the first ${value} seconds` : "Keep the whole clip"),
    custom: { range: CUSTOM_LENGTH, slider: [1, 120, 1], start: 15, unit: " s", name: "length in seconds" },
  }, options);
}

const STATUS = {
  queued: ["○", "Queued"],
  uploading: ["◐", "Uploading…"],
  converting: ["◐", "Converting"],
  done: ["✓", "Added to Media"],
  error: ["!", "Failed"],
  duplicate: ["=", "Skipped: already in this folder"],
};

// List rows are kept per entry while their state is the same (no thumbnail reloads).
const rowCache = new Map();
function listRow(batch, entry) {
  const key = JSON.stringify([entry.status, Math.round((entry.progress || 0) * 100), entry.itemId, entry.error, batch.pinned === entry.id]);
  const cached = rowCache.get(entry.id);
  if (cached?.key === key) return cached.row;
  const [mark, label] = STATUS[entry.status] || ["?", entry.status];
  const row = el("div", `krc-mio-batch-row is-${entry.status}${batch.pinned === entry.id ? " is-pinned" : ""}`, {
    title: `${entry.name} · ${formatBytes(entry.size)} · ${entry.error || label}`,
  });
  row.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    batch.pin(entry.id);
  });
  const thumb = el("div", "krc-mio-batch-thumb");
  if (entry.status === "done" && entry.itemId) thumb.append(el("img", "", { src: mediaApi.thumbUrl(entry.itemId), alt: "", loading: "lazy" }));
  else if (entry.kind === "image" && entry.url) thumb.append(el("img", "", { src: entry.url, alt: "", loading: "lazy" }));
  else thumb.append(el("span", "krc-mio-batch-glyph", { textContent: entry.kind === "video" ? "▶" : "?" }));
  const status = el("span", "krc-mio-batch-status", {
    textContent: entry.status === "converting" ? `${Math.round((entry.progress || 0) * 100)}%` : mark,
  });
  row.append(thumb, el("span", "krc-mio-batch-name", { textContent: entry.name }), status);
  if (entry.status === "error" && !entry.invalid) {
    row.append(el("button", "krc-icon-button krc-mio-batch-retry", { type: "button", textContent: "↻", title: `Retry (${entry.error})`, onclick: () => batch.retry(entry.id) }));
  } else if (entry.status === "queued" || entry.status === "error") {
    const remove = el("button", "krc-icon-button krc-mio-x krc-mio-batch-remove", { type: "button", title: "Take it out of the list", onclick: () => batch.remove(entry.id) });
    remove.append(el("span", "krc-search-clear-glyph", { textContent: "×" }));
    row.append(remove);
  }
  rowCache.set(entry.id, { key, row });
  return row;
}

// The preview box, kept while it shows the same file (a playing video isn't restarted).
let previewCache = { key: "", box: null };
function previewBox(entry, itemById) {
  const key = entry ? `${entry.id}:${entry.status === "done" ? entry.itemId : "local"}` : "";
  if (previewCache.key === key && previewCache.box) return previewCache.box;
  let box;
  if (!entry) {
    box = mediaPreview(null, { empty: "Choose or drop files", className: "krc-mio-fit-preview" });
  } else if (entry.status === "done" && entry.itemId) {
    // The stored item's kind: an animated GIF was picked as an image but is a video now.
    box = mediaPreview({ id: entry.itemId, kind: itemById(entry.itemId)?.kind || entry.kind }, { full: true, className: "krc-mio-fit-preview" });
  } else {
    box = el("div", "krc-mio-preview krc-mio-fit-preview");
    if (!entry.url) box.append(el("span", "krc-mio-preview-label", { textContent: entry.error || "No preview" }));
    else if (entry.kind === "video") box.append(el("video", "krc-mio-preview-media", { src: entry.url, muted: true, autoplay: true, loop: true, playsInline: true }));
    else box.append(el("img", "krc-mio-preview-media", { src: entry.url, alt: "" }));
  }
  previewCache = { key, box };
  return box;
}

function flagSwitch(label, active, title, onToggle) {
  const toggle = switchToggle({ label, active, title, onClick: () => onToggle(!active) });
  toggle.classList.toggle("is-on", active);
  return toggle;
}


function controlsCell(batch, { folderName, currentFolder }) {
  const s = batch.settings;
  const set = (fields) => batch.setSettings(fields);
  const cell = el("div", "krc-mio-batch-controls krc-options-host");
  const section = (title, ...rows) => {
    const block = el("div", "krc-mio-batch-section");
    block.append(el("div", "krc-mio-batch-kind", { textContent: title }), ...rows);
    return block;
  };
  const line = (label, control) => {
    const row = el("div", "krc-mio-batch-line");
    row.append(el("span", "krc-mio-detail-label", { textContent: label }), control);
    return row;
  };
  cell.append(
    section("Images",
      line("Max MP", mpChoices(s.imageMp, (imageMp) => set({ imageMp }))),
      flagSwitch("Keep transparency", s.keepAlpha, "Off: transparent images are flattened onto black (smaller, no mask)", (keepAlpha) => set({ keepAlpha }))),
    section("Videos",
      line("Max MP", mpChoices(s.videoMp, (videoMp) => set({ videoMp }))),
      line("FPS", fpsChoices(s.fps, (fps) => set({ fps }))),
      line("Length", lengthChoices(s.maxLength, (maxLength) => set({ maxLength }))),
      flagSwitch("Include audio", s.audio, "Keep the videos' sound (Opus), or drop it", (audio) => set({ audio }))),
  );
  const target = batch.running ? batch.target : currentFolder;
  const footer = el("div", "krc-mio-batch-footer");
  footer.append(
    flagSwitch("Skip duplicates", s.skipDuplicates, "Don't send a file whose name and size match an item already in the target folder", (skipDuplicates) => set({ skipDuplicates })),
  );
  const queued = batch.entries.some((entry) => entry.status === "queued");
  const buttons = el("div", "krc-mio-buttons krc-mio-batch-buttons");
  buttons.append(
    el("button", "krc-modal-btn", { type: "button", textContent: "Choose files", title: "Pick images and videos (or drop them on Media)", onclick: () => batch.picker.click() }),
    el("button", "krc-modal-btn", {
      type: "button", textContent: "Clear done", title: "Take the added and skipped files out of the list (they stay in Media)",
      disabled: !batch.entries.some((entry) => entry.status === "done" || entry.status === "duplicate"),
      onclick: () => batch.clearDone(),
    }),
    clearAllButton(batch),
    batch.running
      ? el("button", "krc-modal-btn", { type: "button", textContent: batch.stopping ? "Stopping…" : "Stop", disabled: batch.stopping, title: "Stop after (or cancel) the file in progress", onclick: () => batch.stop() })
      : el("button", "krc-modal-btn krc-modal-btn-primary krc-mio-batch-add", {
        type: "button", textContent: `Add to ${folderName(target)}`, disabled: !queued,
        title: `Send the queued files, one at a time, into ${folderName(target)} (the selected folder chip)`,
        onclick: () => batch.start(),
      }),
  );
  cell.append(footer, buttons);
  return cell;
}

// Clear all: everything in the list except the file in progress (armed: queued files would
// have to be picked again). Finished items stay in Media.
function clearAllButton(batch) {
  const button = el("button", "krc-modal-btn krc-mio-batch-clear-all", {
    type: "button", textContent: "Clear all", title: "Empty the list (not the file in progress; added items stay in Media)",
    disabled: !batch.entries.some((entry) => !["uploading", "converting"].includes(entry.status)),
  });
  button.addEventListener("click", () => {
    if (button.dataset.armed !== "1") {
      button.dataset.armed = "1";
      button.textContent = "Clear all?";
      button.classList.add("is-armed");
      setTimeout(() => {
        if (!button.isConnected) return;
        button.dataset.armed = "";
        button.textContent = "Clear all";
        button.classList.remove("is-armed");
      }, 2500);
      return;
    }
    batch.clearAll();
  });
  return button;
}

export function renderBatchPage(batch, options) {
  const page = el("div", "krc-mio-page krc-mio-batch");
  const top = el("div", "krc-mio-batch-top");
  const list = el("div", "krc-mio-batch-list");
  if (!batch.entries.length) {
    list.classList.add("is-empty");
    list.tabIndex = 0;
    list.setAttribute("role", "button");
    list.setAttribute("aria-label", "Choose files");
    list.title = "Choose images and videos";
    const choose = () => batch.picker.click();
    list.addEventListener("click", choose);
    list.addEventListener("keydown", event => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      choose();
    });
    list.append(el("div", "krc-mio-batch-empty", { textContent: "Choose files, or drop several on Media." }));
  }
  for (const entry of batch.entries) list.append(listRow(batch, entry));
  for (const id of rowCache.keys()) if (!batch.entries.some((entry) => entry.id === id)) rowCache.delete(id);

  const side = el("div", "krc-mio-batch-side");
  const fit = el("div", "krc-mio-preview-fit");
  const entry = batch.previewEntry();
  fit.append(previewBox(entry, options.itemById));
  const counts = batch.counts();
  const finished = counts.done + counts.failed + counts.skipped;
  const bar = el("div", "krc-mio-progress");
  bar.append(el("div", "krc-mio-progress-fill", { style: `width: ${counts.total ? Math.round((finished / counts.total) * 100) : 0}%` }));
  const totals = [`${counts.done} of ${counts.total}`, counts.failed ? `${counts.failed} failed` : "", counts.skipped ? `${counts.skipped} skipped` : ""].filter(Boolean).join(" · ");
  const caption = entry ? (entry.status === "done" ? displayName(options.itemById(entry.itemId) || { name: entry.name }) : entry.name) : "";
  side.append(
    fit,
    el("div", "krc-mio-batch-caption", { textContent: caption, title: entry ? `${entry.name} · ${formatBytes(entry.size)}` : "" }),
    bar,
    el("div", "krc-mio-batch-totals", { textContent: totals }),
  );
  const listColumn = el("div", "krc-mio-batch-column");
  listColumn.append(el("div", "krc-mio-batch-heading", { textContent: "QUEUE" }), list);
  top.append(listColumn, side);
  page.append(top, el("div", "krc-mio-batch-heading", { textContent: "IMPORT SETTINGS" }), controlsCell(batch, options));
  return page;
}
