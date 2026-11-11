// The Media's InfoPanel side (GAMEPLAN.md sections 2 and 4): the tabs (with the selected
// card's colour / favourite / pin on the right, as in Model Library and Prompt Vault), the
// upload strip (Upload picks a file, Add sends the pending one), then the Preview page (a
// pending upload's local preview and settings; else the selected card's preview, editable
// name and details; else the uploader) or the Presets page (the preset editor: its name,
// a preview of the current slot, its 6 slots). A video's preview elements are kept on the pending
// upload / per item, so a re-render (a progress tick, a slot change) never restarts playback.
import { installMediaDropTarget } from "./drag.js";
import { mediaDownloadButton } from "./download.js";
import { createCardColorButton, customBadgeActionButton, favoriteActionButton, nsfwActionButton, pinActionButton, switchToggle, teardownMedia, thumbnailBox } from "./krc.js";
import { displayName, formatBytes, formatDuration, formatRunTime, mediaApi, storedFormat } from "./api.js";
import { SLOT_COUNT, allPresets, createPreset, deletePreset, presetButton, presetSlots, presetsLoaded, renamePreset, setPresetSlot, setPresetSlots } from "./presets.js";
import { fpsChoices as fpsChoiceRow, mpChoices, renderBatchPage } from "./batch.js";
import { mediaPreview } from "./preview.js";
import { mediaDisplayState } from "./display.js";

// The upload choices come from batch.js (they mirror MEGAPIXELS / FPS_CHOICES in
// utils/process_image.py and process_video.py; 0 = none / the source's).

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

// Match PV / Model Library: colour, badge, favourite, pin, NSFW.
function cardActions(item, onPatch) {
  const row = el("div", "krc-info-actions krc-mio-info-actions");
  row.append(
    createCardColorButton({ record: item, explicitColor: item.color || "", baseTitle: "Card colour", onChange: (color) => onPatch(item, { color: color || "" }) }),
    customBadgeActionButton({ value: item.customBadge || "", active: Boolean(item.customBadge), onSave: (customBadge) => onPatch(item, { customBadge }) }),
    favoriteActionButton({ active: Boolean(item.favorite), title: item.favorite ? "Remove favourite" : "Favourite", onClick: () => onPatch(item, { favorite: !item.favorite }) }),
    pinActionButton({ active: Boolean(item.pinned), title: item.pinned ? "Unpin" : "Pin to top", onClick: () => onPatch(item, { pinned: !item.pinned }) }),
    nsfwActionButton({ active: Boolean(item.nsfw), title: item.nsfw ? "Remove NSFW tag" : "Tag as NSFW", onClick: () => onPatch(item, { nsfw: !item.nsfw }) }),
  );
  return row;
}

function tabs(page, onPage, actions) {
  const row = el("div", "krc-panel-header krc-mio-tabs");
  for (const [id, label] of [["info", "Preview"], ["presets", "Presets"], ["batch", "Batch"]]) {
    row.append(el("button", `krc-mio-tab${page === id ? " is-active" : ""}`, {
      type: "button",
      textContent: label,
      onclick: () => onPage(id),
    }));
  }
  if (actions) row.append(actions);
  return row;
}

// Upload picks a file (or drop one anywhere on the Media); Add sends the pending one. The
// hint names the folder it goes into on its second line.
function uploadStrip(onPick, pending, onUpload, folder) {
  const strip = el("div", "krc-mio-upload-strip");
  const busy = pending?.status === "uploading" || pending?.status === "converting";
  const hint = el("span", "krc-mio-upload-hint");
  hint.append(
    el("span", "krc-mio-upload-hint-line", { textContent: "Add an image or video to Media" }),
    el("span", "krc-mio-upload-hint-folder", { textContent: folder, title: "The folder it goes into" }),
  );
  strip.append(
    hint,
    el("button", "krc-modal-btn krc-mio-upload-btn", { type: "button", textContent: "Upload", title: "Choose an image or video", onclick: onPick }),
    el("button", "krc-modal-btn krc-modal-btn-primary krc-mio-add-btn", {
      type: "button",
      textContent: busy ? "Working…" : "Add",
      title: pending ? "Add it to Media with these settings" : "Upload or drop a file first",
      disabled: !pending?.url || busy,
      onclick: onUpload,
    }),
  );
  return strip;
}

function detail(label, value) {
  const row = el("div", "krc-mio-detail");
  row.append(el("span", "krc-mio-detail-label", { textContent: label }), el("span", "krc-mio-detail-value", { textContent: value }));
  return row;
}

const sizeChoices = (current, onChange, disabled) => mpChoices(current, onChange, { disabled });
const fpsChoices = (current, onChange, disabled) => fpsChoiceRow(current, onChange, { disabled });

// A dropped video's player: kept on the pending upload (made once), with KRC controls (a
// play button and a krc-range scrubber; the browser's own controls stay off).
function pendingPlayer(pending, onPending) {
  if (pending.player) return pending.player;
  const video = el("video", "krc-mio-preview-media", { src: pending.url, muted: true, playsInline: true, preload: "metadata", loop: true });
  const play = el("button", "krc-icon-button krc-mio-play", { type: "button", textContent: "▶", title: "Play / pause" });
  const scrub = el("input", "krc-range krc-mio-scrub", { type: "range", min: "0", max: "1000", value: "0", step: "1" });
  const time = el("span", "krc-mio-time", { textContent: "0:00.0" });
  const sync = () => {
    const duration = video.duration || 0;
    const fill = duration ? (video.currentTime / duration) * 100 : 0;
    scrub.value = String(Math.round(fill * 10));
    scrub.style.setProperty("--krc-range-fill", `${fill}%`);
    time.textContent = `${formatDuration(video.currentTime, { tenths: true })} / ${formatDuration(duration, { tenths: true })}`;
    play.textContent = video.paused ? "▶" : "❚❚";
  };
  video.addEventListener("loadedmetadata", () => {
    pending.duration = video.duration || 0;
    if (!pending.trimOut) pending.trimOut = pending.duration;
    sync();
    onPending({});
  });
  video.addEventListener("timeupdate", sync);
  video.addEventListener("play", sync);
  video.addEventListener("pause", sync);
  play.addEventListener("click", () => (video.paused ? video.play() : video.pause()));
  scrub.addEventListener("input", () => {
    if (video.duration) video.currentTime = (Number(scrub.value) / 1000) * video.duration;
  });
  scrub.addEventListener("keydown", (event) => event.stopPropagation());
  const controls = el("div", "krc-mio-player-controls");
  controls.append(play, scrub, time);
  pending.player = { video, controls };
  return pending.player;
}

function trimRow(pending, onPending, disabled) {
  const row = el("div", "krc-mio-trim");
  const video = pending.player?.video;
  const end = pending.trimOut || pending.duration || 0;
  const mark = (label, value, onSet, title) => {
    const box = el("div", "krc-mio-trim-mark");
    box.append(
      el("span", "krc-mio-setting-label", { textContent: label }),
      el("span", "krc-mio-detail-value", { textContent: formatDuration(value, { tenths: true }) }),
      el("button", "krc-modal-btn krc-mio-trim-set", { type: "button", textContent: "Set", title, disabled, onclick: onSet }),
    );
    return box;
  };
  row.append(
    mark("Start", pending.trimIn || 0, () => {
      const at = video?.currentTime || 0;
      onPending({ trimIn: Math.min(at, Math.max(0, end - 0.1)) });
    }, "Start at the playhead"),
    mark("End", end, () => {
      const at = video?.currentTime || 0;
      onPending({ trimOut: Math.max(at, (pending.trimIn || 0) + 0.1) });
    }, "End at the playhead"),
    el("button", "krc-modal-btn krc-mio-trim-reset", {
      type: "button", textContent: "Whole", title: "Use the whole video", disabled,
      onclick: () => onPending({ trimIn: 0, trimOut: pending.duration || 0 }),
    }),
  );
  return row;
}

function progressBar(value) {
  const bar = el("div", "krc-mio-progress");
  bar.append(el("div", "krc-mio-progress-fill", { style: `width: ${Math.round((value || 0) * 100)}%` }));
  return bar;
}

// Nothing selected or pending: the uploader takes the panel.
function uploaderPage(onPick, heif) {
  const page = el("div", "krc-mio-page krc-mio-uploader");
  const drop = el("button", "krc-mio-drop", { type: "button", onclick: onPick });
  drop.append(
    el("div", "krc-mio-drop-title", { textContent: "Drop images or videos here, or click to choose" }),
    el("div", "krc-mio-drop-sub", { textContent: `Images become WebP and videos WebM, upright (the orientation is fixed on upload).${heif ? "" : " HEIC needs pillow-heif on the server."}` }),
  );
  page.append(drop);
  return page;
}

// A dropped / picked file, before (and while) it's sent: its local preview and the upload
// settings; a video adds the player, trim, FPS and audio, then the conversion's progress.
function pendingPage(pending, { onPending, onCancel }) {
  const page = el("div", "krc-mio-page krc-mio-pending");
  const video = pending.kind === "video";
  const busy = pending.status === "uploading" || pending.status === "converting";
  const unusable = pending.status === "error" && !pending.url;
  const preview = el("div", "krc-mio-preview");
  if (!pending.url) preview.append(el("span", "krc-mio-preview-label", { textContent: "No preview" }));
  else if (video) preview.append(pendingPlayer(pending, onPending).video);
  else preview.append(el("img", "krc-mio-preview-media", { src: pending.url, alt: "" }));
  page.append(preview);
  if (video && pending.url) page.append(pendingPlayer(pending, onPending).controls);

  const settings = el("div", "krc-mio-settings krc-options-host");
  settings.append(
    el("div", "krc-mio-item-name", { textContent: pending.file?.name || "Upload" }),
    detail("File", `${formatBytes(pending.file?.size)}${video && pending.duration ? ` · ${formatDuration(pending.duration, { tenths: true })}` : ""}`),
  );
  if (video && pending.url) {
    const audio = switchToggle({
      label: "Keep audio",
      active: pending.audio !== false,
      title: "Keep the video's sound (Opus), or drop it",
      onClick: () => onPending({ audio: pending.audio === false }),
    });
    audio.disabled = busy;
    settings.append(
      el("div", "krc-mio-section-title", { textContent: "Trim" }), trimRow(pending, onPending, busy),
      el("div", "krc-mio-section-title", { textContent: "FPS" }), fpsChoices(pending.fps || 0, (fps) => onPending({ fps }), busy),
      audio,
    );
  }
  settings.append(
    el("div", "krc-mio-section-title", { textContent: "Max size (megapixels)" }),
    sizeChoices(pending.megapixels || 0, (megapixels) => onPending({ megapixels }), busy || unusable),
  );
  page.append(settings);

  const status = el("div", `krc-mio-status${pending.status === "error" ? " is-error" : ""}`, {
    textContent: pending.status === "uploading" ? `Uploading ${formatBytes(pending.file?.size)}…`
      // A conversion job always makes WebM (an animated GIF too, though it was picked as an image).
      : pending.status === "converting" ? `Converting to WebM… ${Math.round((pending.progress || 0) * 100)}%`
        : pending.status === "error" ? pending.error : "",
  });
  page.append(status);
  if (pending.status === "converting") page.append(progressBar(pending.progress));
  const buttons = el("div", "krc-mio-buttons");
  buttons.append(
    el("button", "krc-modal-btn", {
      type: "button",
      textContent: pending.status === "converting" ? "Stop" : "Cancel",
      title: pending.status === "converting" ? "Stop converting (nothing is added)" : "Don't upload this",
      disabled: pending.status === "uploading",
      onclick: onCancel,
    }),
  );
  page.append(buttons);
  return page;
}

// The Preview page's preview, kept per item (a redraw never restarts its video): a still,
// or a video that plays once and loops while hovered; its sound-on-hover toggle
// (box.soundToggle) sits on the name row.
let itemPreviewCache = { key: "", box: null };
function itemPreview(item, showNsfw) {
  const key = JSON.stringify([item.id, item.kind, mediaDisplayState(item, showNsfw)]);
  if (itemPreviewCache.key !== key) {
    teardownMedia(itemPreviewCache.box);
    itemPreviewCache = { key, box: mediaPreview(item, { showNsfw, full: true, className: "krc-mio-fit-preview", playOnce: true, sound: true }) };
  }
  return itemPreviewCache.box;
}

// The selected card's name, edited in place (Enter or leaving the field saves; Escape undoes).
function nameField(item, onPatch) {
  const shown = displayName(item);
  const input = el("input", "krc-mio-item-name krc-mio-name-input", { type: "text", value: shown, maxLength: 80, title: "Rename (click to edit)" });
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") input.blur();
    if (event.key === "Escape") { input.value = shown; input.blur(); }
  });
  input.addEventListener("change", () => {
    const name = input.value.trim();
    if (!name) { input.value = shown; return; }
    if (name !== shown) onPatch(item, { name });
  });
  return input;
}

// One compact box of facts (two lines, "·" between) instead of label rows, so the Preview
// page never scrolls. Line 1: the file; line 2: its folder and the preset slots holding it.
function metaBox(item, presetsOf, folderName) {
  const video = item.kind === "video";
  const format = storedFormat(item);
  const fact = (text, title) => (text ? el("span", "krc-mio-fact", { textContent: text, title }) : null);
  const fileLine = [
    fact(video ? "VIDEO" : "IMAGE", format),
    fact(format, "Stored format"),
    fact(item.width && item.height ? `${item.width}×${item.height}` : "", "Dimensions"),
    ...(video ? [
      fact(item.duration ? formatDuration(item.duration, { tenths: true }) : "", "Duration"),
      fact(item.fps ? `${item.fps} fps` : "", "Frame rate"),
      fact(item.frames ? `${item.frames} frames` : "", "Frames"),
      fact(item.audio ? "audio" : "muted", item.audio ? "Has a sound track" : "No sound"),
    ] : [fact(item.oriented ? "fixed ↻" : "", "Its orientation was fixed on upload")]),
    fact(item.alpha ? "alpha" : "", "Transparent"),
    fact(formatBytes(item.bytes), "File size"),
    // Media Output items: how long the run that made it took (filled in once the run ends).
    fact(formatRunTime(item.runMs) ? `⏱ ${formatRunTime(item.runMs)}` : "", "Run time: how long the workflow run that made it took"),
  ];
  const inPresets = presetsOf(item.id);
  const placeLine = [
    fact(folderName(item.folder || ""), "Folder"),
    fact(inPresets.length ? inPresets.join(", ") : "in no preset", "In presets (preset, slot)"),
  ];
  const box = el("div", "krc-mio-meta");
  for (const facts of [fileLine, placeLine]) {
    const line = el("div", "krc-mio-meta-line");
    facts.filter(Boolean).forEach((node, index) => {
      if (index) line.append(el("span", "krc-mio-fact-sep", { textContent: "·" }));
      line.append(node);
    });
    box.append(line);
  }
  box.append(mediaDownloadButton(item));
  return box;
}

// The Preview page: the preview fills what the name and the facts box leave (square, fit
// to the box), so everything is in view at once without scrolling.
function infoPage(item, presetsOf, onPatch, folderName, showNsfw) {
  const page = el("div", "krc-mio-page krc-mio-item");
  const fit = el("div", "krc-mio-preview-fit");
  const box = itemPreview(item, showNsfw);
  fit.append(box);
  const nameRow = el("div", "krc-mio-name-row");
  nameRow.append(nameField(item, onPatch), ...(box.soundToggle ? [box.soundToggle] : []));
  page.append(fit, nameRow, metaBox(item, presetsOf, folderName));
  return page;
}

// One slot of the preset: click it to preview it, drop a Media card to fill it, × empties
// it. Every change is saved at once.
function slotCard(preset, slot, index, { itemById, dragPayload, currentSlot, onCurrentSlot, isCurrentPreset, showNsfw }) {
  const item = slot.id ? itemById(slot.id) : null;
  const missing = Boolean(slot.id) && !item;
  const card = el("div", `krc-mio-slot${slot.id ? "" : " is-empty"}${missing ? " is-missing" : ""}${index === currentSlot ? " is-current" : ""}`, {
    title: "Click to preview this slot",
  });
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    onCurrentSlot(index);
  });
  const thumb = el("div", "krc-mio-slot-thumb");
  if (item) {
    const visibility = mediaDisplayState(item, showNsfw);
    thumb.append(thumbnailBox({ className: "krc-mio-slot-img", ...mediaApi.thumbnailSpec(item, visibility) }));
  }
  const body = el("div", "krc-mio-slot-body");
  // The slot's number is on its left: the card names what it holds.
  body.append(el("div", "krc-mio-slot-name", { textContent: missing ? "Missing" : item ? displayName(item) : "Empty" }), el("div", "krc-mio-slot-sub", {
    textContent: missing ? "Its media was deleted" : item ? (item.kind === "video" ? "Video" : "Image") : "Drag a card here",
  }));
  const actions = el("div", "krc-mio-slot-actions");
  if (slot.id) {
    const clear = xButton("krc-mio-slot-clear", "Empty this slot");
    clear.addEventListener("click", () => setPresetSlot(preset.id, index, { id: "" }));
    actions.append(clear);
  }
  card.append(el("span", "krc-mio-slot-number", { textContent: String(index + 1) }), thumb, body, actions);

  installMediaDropTarget(card, {
    dragPayload,
    onDropMany: async ids => {
      const result = await setPresetSlots(preset.id, ids, index);
      if (result.ok && (isCurrentPreset ? isCurrentPreset(preset.id) : card.isConnected)) onCurrentSlot(index);
    },
    onDrop: async id => {
      const result = await setPresetSlot(preset.id, index, { id });
      if (result.ok && (isCurrentPreset ? isCurrentPreset(preset.id) : card.isConnected)) onCurrentSlot(index);
    },
  });
  return card;
}

// Slot cards and the preset row are kept while what they show is unchanged, so a redraw for
// one slot rebuilds only that slot's card (no thumbnail flash, nothing re-created). Their
// handlers only use stable state (the preset's id, the page's callbacks), so a kept card
// stays correct.
const keptCards = new Map();
function keptSlotCard(preset, slot, index, options, used) {
  const item = slot.id ? options.itemById(slot.id) : null;
  const key = JSON.stringify([preset.id, index, slot, item && [item.id, displayName(item)], index === options.currentSlot]);
  used.add(key);
  if (!keptCards.has(key)) keptCards.set(key, slotCard(preset, slot, index, options));
  return keptCards.get(key);
}

let keptPresetRow = { key: "", row: null };
function keptRow(preset, onPreset) {
  const key = JSON.stringify([preset.id, preset.name]);
  if (keptPresetRow.key !== key) keptPresetRow = { key, row: presetRow(preset, onPreset) };
  return keptPresetRow.row;
}

// The × of the search bars (NodePack's krc-search-clear-glyph, optically centred).
function xButton(className, title) {
  const button = el("button", `krc-icon-button krc-mio-x ${className}`, { type: "button", title });
  button.append(el("span", "krc-search-clear-glyph", { textContent: "×" }));
  return button;
}

// The preset row: its name (edited in place), ▾ to switch, + for a new preset, × to delete
// (armed: "Sure?").
function presetRow(preset, onPreset) {
  const row = el("div", "krc-mio-preset-row");
  const name = el("input", "krc-mio-combo-input", { type: "text", value: preset.name, maxLength: 60, title: "Rename this preset" });
  name.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") name.blur();
    if (event.key === "Escape") { name.value = preset.name; name.blur(); }
  });
  name.addEventListener("input", () => name.classList.remove("is-invalid"));
  name.addEventListener("change", async () => {
    const wanted = name.value.trim();
    if (!wanted || wanted === preset.name) { name.value = preset.name; return; }
    const result = await renamePreset(preset.id, wanted);
    if (!result.ok) {
      name.value = preset.name;
      name.classList.add("is-invalid");
      name.title = result.error;
    }
  });
  const add = el("button", "krc-icon-button krc-mio-preset-add", { type: "button", textContent: "+", title: "A new preset" });
  add.addEventListener("click", async () => {
    const result = await createPreset();
    if (result.ok && result.preset) onPreset(result.preset.id);
  });
  const remove = xButton("krc-mio-preset-delete", "Delete this preset (its items stay in Media)");
  const glyph = remove.firstChild;
  remove.addEventListener("click", async () => {
    if (remove.dataset.armed !== "1") {
      remove.dataset.armed = "1";
      remove.classList.add("is-armed");
      remove.textContent = "Sure?";
      setTimeout(() => {
        if (!remove.isConnected) return;
        remove.dataset.armed = "";
        remove.classList.remove("is-armed");
        remove.replaceChildren(glyph);
      }, 2500);
      return;
    }
    await deletePreset(preset.id);
    onPreset("");
  });
  // The name and ▾ are one field (a combobox): type to rename, ▾ for another preset.
  const combo = el("div", "krc-mio-combo");
  const caret = presetButton({ label: "", title: "Another preset", currentId: preset.id, onPick: onPreset, allowNew: false });
  caret.classList.add("krc-mio-combo-caret");
  combo.append(name, caret);
  row.append(combo, add, remove);
  return row;
}

// The Presets page's preview, kept while it shows the same thing (a redraw for another slot
// change never reloads the image or restarts a video).
let presetPreview = { key: "", anchor: null };
// Two sizes: compact (all 6 slot cards fit under it) and large; a click toggles, and the
// choice is remembered in this browser. Only the class changes (no redraw). The box sits in
// an anchor of its size, so the sound toggle can sit just right of it, at its bottom.
const PREVIEW_SIZE_KEY = "krc-media.presets-preview-large";
function previewLarge() {
  try {
    return localStorage.getItem(PREVIEW_SIZE_KEY) === "1";
  } catch {
    return false;
  }
}
function setPreviewLarge(large) {
  try {
    localStorage.setItem(PREVIEW_SIZE_KEY, large ? "1" : "0");
  } catch {
    // not remembered
  }
}
function slotPreview(item, empty, showNsfw) {
  const key = JSON.stringify([item?.id, item?.kind, empty, mediaDisplayState(item, showNsfw)]);
  if (presetPreview.key !== key) {
    teardownMedia(presetPreview.box);
    const box = mediaPreview(item, { showNsfw, full: true, className: "krc-mio-active-preview", empty, playOnce: true, sound: true });
    const anchor = el("div", "krc-mio-preview-anchor");
    anchor.append(box, ...(box.soundToggle ? [box.soundToggle] : []));
    box.addEventListener("click", () => {
      const large = !anchor.classList.contains("is-large");
      anchor.classList.toggle("is-large", large);
      box.title = large ? "Click for the small preview" : "Click for the large preview";
      setPreviewLarge(large);
    });
    presetPreview = { key, anchor, box };
  }
  const large = previewLarge();
  presetPreview.anchor.classList.toggle("is-large", large);
  presetPreview.box.title = large ? "Click for the small preview" : "Click for the large preview";
  return presetPreview.anchor;
}

// The Presets page (the preset editor): the preset row, the current slot's 1:1 preview and
// caption, then its 6 slot cards.
function presetsPage(options) {
  const { preset, onPreset } = options;
  const page = el("div", "krc-mio-page krc-mio-active");
  if (!presetsLoaded()) {
    page.append(el("div", "krc-mio-slot-sub", { textContent: "Loading the presets…" }));
    return page;
  }
  if (!preset) {
    const empty = el("div", "krc-mio-drop is-static");
    const presets = allPresets();
    empty.append(
      el("div", "krc-mio-drop-title", { textContent: presets.length ? "Pick a media preset" : "No media presets yet" }),
      el("div", "krc-mio-drop-sub", { textContent: "A preset is 6 slots; a KRC Media Loader loads one of them. A new Media Loader node makes one." }),
    );
    const buttons = el("div", "krc-mio-buttons");
    if (presets.length) buttons.append(presetButton({ label: "Presets", currentId: "", onPick: onPreset, allowNew: false }));
    buttons.append(el("button", "krc-modal-btn krc-modal-btn-primary", {
      type: "button", textContent: "+ New preset",
      onclick: async () => {
        const result = await createPreset();
        if (result.ok) onPreset(result.preset.id);
      },
    }));
    empty.append(buttons);
    page.append(empty);
    return page;
  }
  installMediaDropTarget(page, {
    dragPayload: options.dragPayload,
    onDropMany: async ids => {
      const result = await setPresetSlots(preset.id, ids, options.currentSlot);
      if (result.ok && (options.isCurrentPreset ? options.isCurrentPreset(preset.id) : page.isConnected)) options.onCurrentSlot(options.currentSlot);
    },
  });
  const slots = presetSlots(preset);
  const current = Math.min(Math.max(options.currentSlot, 0), SLOT_COUNT - 1);
  const slot = slots[current];
  const item = slot?.id ? options.itemById(slot.id) : null;
  page.append(keptRow(preset, onPreset), slotPreview(item, slot?.id ? "Missing — its media was deleted" : "Empty slot: drag a card onto it", options.showNsfw));
  const head = el("div", "krc-mio-active-head");
  const caption = el("div", "krc-mio-active-caption");
  caption.append(
    el("div", "krc-mio-item-name", { textContent: `Slot ${current + 1}` }),
    el("div", "krc-mio-slot-sub", { textContent: item ? displayName(item) : slot?.id ? "Missing" : "Empty" }),
  );
  head.append(caption, el("span", "krc-mio-slot-count", { textContent: `${slots.filter((entry) => entry.id).length} of ${SLOT_COUNT} filled` }));
  const list = el("div", "krc-mio-slots");
  const used = new Set();
  slots.forEach((entry, index) => list.append(keptSlotCard(preset, entry, index, { ...options, currentSlot: current }, used)));
  for (const key of keptCards.keys()) if (!used.has(key)) keptCards.delete(key);
  page.append(head, list);
  return page;
}

export function renderInfoColumn(options) {
  const { page, selected, pending, heif, onPage, onPick } = options;
  // "Preset n" (preset, slot) for every slot that holds `id` (the Preview page's facts).
  const presetsOf = (id) => allPresets().flatMap((entry) => presetSlots(entry)
    .flatMap((slot, index) => (slot.id === id ? [`${entry.name} ${index + 1}`] : [])));
  const column = el("div", "krc-mio-info-column");
  let body;
  if (page === "presets") body = presetsPage(options);
  else if (page === "batch") body = renderBatchPage(options.batch, { folderName: options.folderName, currentFolder: options.uploadFolder, itemById: options.itemById });
  else if (pending) body = pendingPage(pending, options);
  else if (selected) body = infoPage(selected, presetsOf, options.onPatch, options.folderName, options.showNsfw);
  else body = uploaderPage(onPick, heif);
  // The card buttons belong to the card the Preview page shows (not a pending upload).
  const actions = page === "info" && !pending && selected ? cardActions(selected, options.onPatch) : null;
  // Batch has its own Choose files / Start: no single-upload strip there.
  column.append(tabs(page, onPage, actions), ...(page === "batch" ? [] : [uploadStrip(onPick, pending, options.onUpload, options.folderName(options.uploadFolder))]), body);
  return column;
}
