// Output settings execute on the server; history stays in the workflow properties.
import { makeMediaDraggable } from "./drag.js";
import { bindMediaKeys, wrapIndex } from "./keyboard.js";
import { downloadMedia } from "./download.js";
import { app } from "../../../scripts/app.js";
import { api as comfyApi } from "../../../scripts/api.js";
import { applyTextReplacements } from "../../../scripts/utils.js";
import { applyNodePalette, ensureStylesheet, markDirty, menuSelect, openKrcModal, subscribeKrcSync, switchToggle, teardownMedia } from "./krc.js";
import { mediaItem, mediaItems, mediaLoaded, mediaPreview, onMediaItems, refreshMediaItems } from "./preview.js";
import { mediaDisplayState } from "./display.js";
import { MEDIA_EVENT, mediaApi } from "./api.js";
import { MEDIA_NODE_DEFAULT_WIDTH, arrowButton, captionRow, clearAllButton, clickPreviewToMute, confirmControlButton, el, fitMediaNode, mediaNodeContentHeight, mediaControlButton, nodeShell, openMedia, openNodeOptions, optionsButton, prepareDataWidget, refitOnPanelResize, slotCells } from "./panel.js";
import { OUTPUT_DEFAULTS, OUTPUT_FORMATS, OUTPUT_TYPE, OUTPUT_WIDGET, mergeOutputHistory, newOutputKey, normalizeOutput, outputHistory, readOutput } from "./output_state.js";

const UI_WIDGET = "krc_media_output_ui";
const STYLE_VERSION = "1.0.6-shared-1671";
const MIN_W = MEDIA_NODE_DEFAULT_WIDTH;
const uiOf = node => node.widgets?.find(widget => widget.name === UI_WIDGET);
const contentHeight = node => mediaNodeContentHeight(node, UI_WIDGET, MIN_W);

function write(node, changes) {
  const widget = node.widgets?.find(entry => entry.name === OUTPUT_WIDGET);
  if (widget) widget.value = JSON.stringify(normalizeOutput({ ...readOutput(node), ...changes }));
  markDirty(node);
}

// Auto-download (Options, off by default): each output this node saves also downloads in
// the browser. A node property, not output_data: it never reaches the server, so toggling it
// doesn't change the run's inputs (no re-run, no cache miss).
const AUTO_DOWNLOAD = "krcMediaOutputAutoDownload";
const autoDownload = node => node.properties?.[AUTO_DOWNLOAD] === true;

function downloadOutputs(records) {
  for (const item of records) {
    const link = el("a", "", { href: mediaApi.fileUrl(item.id), download: item.filename || item.name || item.id, rel: "noopener" });
    link.style.display = "none";
    document.body.append(link);
    link.click();
    link.remove();
  }
}

function optionRow(label, control) {
  const row = el("label", "krc-modal-field");
  row.append(el("span", "krc-modal-field-label", { textContent: label }), control);
  return row;
}

const NATIVE_TITLE = "Each run's files also show in ComfyUI's queue and Assets (from the next run). The node keeps the KRC preview. Deleting a file in Media leaves a broken entry in the queue and Assets.";

function openOptions(node) {
  const fields = el("div", "krc-mio-output-options");
  fields.append(el("div", "krc-mio-output-note", { textContent: "Images save one still per image in the batch. A video is saved as it arrives: build it upstream (Create Video, VHS…). Metadata (prompt and workflow) is embedded in the file, without a sidecar." }));
  const prefix = el("input", "krc-modal-select krc-mio-output-setting", {
    type: "text", value: readOutput(node).prefix, placeholder: OUTPUT_DEFAULTS.prefix,
    title: "Output filename/prefix · ComfyUI automatic syntax; relative subfolders stay within the selected folder",
  });
  prefix.setAttribute("aria-label", "Output filename prefix");
  prefix.oninput = () => write(node, { prefix: prefix.value });
  const format = menuSelect({
    className: "krc-modal-select krc-mio-output-setting",
    title: "Image format (stills only; a video is saved as it arrives)",
    value: readOutput(node).format,
    options: OUTPUT_FORMATS.filter(entry => entry.value === readOutput(node).format || node._krcMioOutputContext?.formats?.[entry.value]).map(entry => [entry.value, entry.label + (node._krcMioOutputContext?.formats?.[entry.value] === false ? " · unavailable" : "")]),
    onChange: value => { write(node, { format: value }); sync(); },
  });
  const metadata = switchToggle({
    label: "Save metadata", active: readOutput(node).saveMetadata,
    onClick: () => { write(node, { saveMetadata: !readOutput(node).saveMetadata }); sync(); },
  });
  const native = switchToggle({
    label: "Show in queue and Assets", active: readOutput(node).native,
    title: NATIVE_TITLE,
    onClick: () => { write(node, { native: !readOutput(node).native }); sync(); },
  });
  const download = switchToggle({
    label: "Auto-download", active: autoDownload(node),
    title: "Also download each output this node saves, in this browser",
    onClick: () => {
      node.properties ||= {};
      node.properties[AUTO_DOWNLOAD] = !autoDownload(node);
      markDirty(node);
      sync();
    },
  });
  const sync = () => {
    for (const [toggle, on] of [[metadata, readOutput(node).saveMetadata], [native, readOutput(node).native], [download, autoDownload(node)]]) {
      toggle.classList.toggle("is-on", on);
      toggle.classList.toggle("is-active", on);
      toggle.setAttribute("aria-pressed", String(on));
    }
  };
  fields.append(optionRow("Filename / prefix", prefix), optionRow("Image format", format), metadata, native,
    el("div", "krc-mio-output-note", { textContent: NATIVE_TITLE }), download);
  sync();
  openNodeOptions(node, "Media Output options", uiOf(node)?.element || null, [fields]);
}

function historyOf(node) {
  return outputHistory(node.properties?.krcMediaOutputHistory || [], mediaItems(), readOutput(node).key);
}

// Trash: the shown history entry's file is deleted from Media (record, file, thumbnail), and
// the entry leaves the history. One already gone from Media just leaves the history.
async function deleteShown(node) {
  const entries = historyOf(node);
  const index = Math.min(node._krcMioOutputHistoryPick ?? 0, Math.max(0, entries.length - 1));
  const id = entries[index]?.id;
  if (!id) return;
  if (mediaItem(id)) {
    let result = null;
    try { result = await mediaApi.remove(id); } catch { result = null; }
    if (!result?.ok) {
      console.warn(`[KRC Media] couldn't delete output ${id}: ${result?.error || "no answer"}`);
      render(node);
      return;
    }
  }
  node.properties ||= {};
  node.properties.krcMediaOutputHistory = (node.properties.krcMediaOutputHistory || []).filter(entry => entry?.id !== id);
  if (node._krcMioOutputPending) delete node._krcMioOutputPending[id];
  node._krcMioOutputHistoryPick = Math.max(0, Math.min(index, historyOf(node).filter(entry => entry?.id !== id).length - 1));
  markDirty(node);
  Promise.resolve(refreshMediaItems()).catch(() => {});   // the Media event refreshes too
  render(node);
}

function clearHistory(node) {
  node.properties ||= {};
  node.properties.krcMediaOutputHistory = [];
  node._krcMioOutputPending = null;
  node._krcMioOutputHistoryPick = 0;
  // Retire the history key, so saved outputs cannot repopulate on refresh/reload.
  // Future runs use the new key. Existing records and files are untouched.
  write(node, { key: newOutputKey() });
  render(node);
}

// Every Output node has its own key. A copy (paste, clone) arrives with its original's key
// and history: it gets a new key and starts empty.
function ensureKey(node) {
  const key = readOutput(node).key;
  const taken = key && (node.graph?._nodes || []).some(other => other !== node && other.comfyClass === OUTPUT_TYPE && readOutput(other).key === key);
  if (key && !taken) return;
  if (taken && node.properties) node.properties.krcMediaOutputHistory = [];
  write(node, { key: newOutputKey() });
}

function prepare(node) {
  prepareDataWidget(node, OUTPUT_WIDGET, () => {
    const state = readOutput(node);
    return JSON.stringify({ ...state, prefix: applyTextReplacements(app, state.prefix) });
  });
}

// One request for all Output nodes in the same burst. A mutation received
// during an active fetch queues one fresh read before publishing the result.
let contextRequest = null;
let contextFetching = false;
let contextAgain = false;
function requestContext(refresh) {
  if (contextRequest) {
    if (refresh && contextFetching) contextAgain = true;
    return contextRequest;
  }
  contextRequest = Promise.resolve().then(async () => {
    let result;
    do {
      contextAgain = false;
      contextFetching = true;
      result = await mediaApi.outputOptions();
    } while (contextAgain);
    return result;
  }).finally(() => { contextRequest = null; contextFetching = false; });
  return contextRequest;
}

function scheduleRender(node) {
  if (node._krcMioOutputRemoved || node._krcMioOutputRenderFrame != null) return;
  node._krcMioOutputRenderFrame = requestAnimationFrame(() => {
    node._krcMioOutputRenderFrame = null;
    render(node);
  });
}

function loadContext(node, refresh = false) {
  if (node._krcMioOutputRemoved) return Promise.resolve();
  const request = requestContext(refresh);
  if (node._krcMioOutputContextLoad?.request === request) return node._krcMioOutputContextLoad.promise;
  const load = { request };
  load.promise = request.then(context => {
    if (node._krcMioOutputRemoved) return;
    node._krcMioOutputContext = context;
    node._krcMioOutputError = "";
  }, error => {
    if (!node._krcMioOutputRemoved) node._krcMioOutputError = String(error?.message || error);
  }).finally(() => {
    if (node._krcMioOutputContextLoad === load) node._krcMioOutputContextLoad = null;
    scheduleRender(node);
  });
  node._krcMioOutputContextLoad = load;
  return load.promise;
}

// Replace only a changed section. In particular, never detach an unchanged
// preview: moving the same video through replaceChildren can interrupt playback.
function section(node, panel, name, key, build) {
  const sections = node._krcMioOutputSections ||= {};
  const previous = sections[name];
  if (previous?.key === key && previous.element.parentNode === panel) return previous.element;
  const element = build();
  node._krcMioOutputLayoutChanged = true;
  if (previous?.element.parentNode === panel) {
    teardownMedia(previous.element);
    previous.element.replaceWith(element);
  } else panel.append(element);
  sections[name] = { key, element };
  return element;
}

function newFolder(node) {
  const input = el("input", "krc-modal-select krc-mio-output-setting", { type: "text", placeholder: "Output folder name", maxLength: 40 });
  const error = el("div", "krc-mio-output-note");
  openKrcModal({ node, title: "New output folder", body: [optionRow("Name", input), error], actions: [
    { label: "Cancel", onClick: ({ close }) => close() },
    { label: "Create", primary: true, onClick: async ({ close, btn }) => {
      btn.disabled = true;
      try {
        const { folder } = await mediaApi.createFolder(input.value, "output");
        write(node, { folder: folder.id });
        await loadContext(node, true);
        close();
      } catch (failure) {
        error.textContent = String(failure?.message || failure);
        btn.disabled = false;
      }
    } },
  ] });
  requestAnimationFrame(() => input.focus());
}

function render(node) {
  if (node._krcMioOutputRemoved) return;
  const root = uiOf(node)?.element;
  const panel = root?.querySelector(".krc-mio-panel");
  if (!panel) return;
  applyNodePalette(node, root);
  node._krcMioOutputLayoutChanged = false;
  const state = readOutput(node);
  const folders = node._krcMioOutputContext?.folders || [];
  // Default saves without a folder (the Output view's Unsorted). A folder deleted since
  // saves to Default too (the server never fails a run over it), so it just reads Default.
  const choices = [["", "Default"], ...folders.map(folder => [folder.id, folder.name]), ["__new__", "+ New output folder…"]];
  const shownFolder = folders.some(folder => folder.id === state.folder) ? state.folder : "";
  const entries = historyOf(node);
  const selected = Math.min(node._krcMioOutputHistoryPick ?? 0, Math.max(0, entries.length - 1));
  const itemOf = id => node._krcMioOutputPending?.[id] || mediaItem(id);
  const item = itemOf(entries[selected]?.id);
  const missing = entries[selected]?.id && mediaLoaded() && !item;
  const isMuted = () => node.properties?.krcMioOutputMuted !== false;
  const isAutoplay = () => node.properties?.krcMioOutputAutoplay !== false;
  const empty = missing ? "Missing media" : "No output yet";
  const previewKey = JSON.stringify([item?.id, item?.kind, item?.width, item?.height, item?.audio, mediaDisplayState(item), empty]);
  const playbackKey = () => JSON.stringify([isMuted(), isAutoplay()]);
  const headerKey = () => JSON.stringify([choices, state.folder, isMuted(), isAutoplay(), Boolean(entries.length), entries[selected]?.id || ""]);
  // Header comes first; its controls resolve the current preview when clicked.
  section(node, panel, "header", headerKey(), () => {
    const header = el("div", "krc-panel-header krc-mio-header");
    const folder = menuSelect({
      className: "krc-action-button krc-mio-preset-btn krc-mio-output-folder",
      title: "Output folder",
      value: shownFolder,
      options: choices,
      onChange: value => { if (value === "__new__") { folder.value = shownFolder; newFolder(node); } else { write(node, { folder: value }); render(node); } },
    });
    folder.setAttribute("aria-label", "Output folder");
    const currentPreview = () => node._krcMioOutputSections?.preview?.element;
    const rememberControls = () => {
      node._krcMioOutputSections.header.key = headerKey();
      node._krcMioOutputPlayback = playbackKey();
    };
    const mute = mediaControlButton("mute", () => {
      node.properties ||= {};
      node.properties.krcMioOutputMuted = !isMuted();
      syncMute();
      currentPreview()?.syncPreviewSound?.();
      rememberControls();
      markDirty(node);
    });
    const syncMute = () => {
      mute.classList.toggle("is-muted", isMuted());
      mute.title = isMuted() ? "Preview muted · click to unmute" : "Preview sound on hover · click to mute";
      mute.setAttribute("aria-label", "Mute preview");
      mute.setAttribute("aria-pressed", String(isMuted()));
    };
    syncMute();
    const auto = mediaControlButton("autoplay", () => {
      node.properties ||= {};
      node.properties.krcMioOutputAutoplay = !isAutoplay();
      syncAutoplay();
      currentPreview()?.syncPreviewSound?.();
      currentPreview()?.syncPreviewPlayback?.();
      rememberControls();
      markDirty(node);
    });
    const syncAutoplay = () => {
      auto.classList.toggle("is-off", !isAutoplay());
      auto.title = isAutoplay() ? "Autoplay on · loops continuously" : "Autoplay off · plays while hovering";
      auto.setAttribute("aria-label", "Autoplay preview");
      auto.setAttribute("aria-pressed", String(isAutoplay()));
    };
    syncAutoplay();
    const trash = confirmControlButton("trash", () => deleteShown(node), {
      title: "Delete the shown output's file from Media (the file itself, not just the history)",
      armedTitle: "Click again to delete the file",
      className: "krc-mio-output-trash-shown",
      disabled: !entries[selected]?.id,
    });
    header.append(folder, el("span", "krc-mio-header-gap"), auto, mute,
      clearAllButton(() => clearHistory(node), !entries.length, "Clear output history (media files are kept)"), trash,
      optionsButton(() => openOptions(node)));
    return header;
  });
  const previousPreview = node._krcMioOutputSections?.preview?.element;
  const preview = section(node, panel, "preview", previewKey, () => {
    const box = mediaPreview(item, {
      full: true, holdPreview: true, typeIndicator: true, muted: isMuted, autoplay: isAutoplay,
      className: "krc-mio-pick-preview", empty,
    });
    if (item) makeMediaDraggable(clickPreviewToMute(box), () => itemOf(item.id));
    return box;
  });
  const playback = playbackKey();
  if (preview === previousPreview && node._krcMioOutputPlayback !== playback) {
    preview.syncPreviewSound?.();
    preview.syncPreviewPlayback?.();
  }
  node._krcMioOutputPlayback = playback;
  const captionText = node._krcMioOutputError || item?.name || (missing ? "The saved file is no longer available" : "Ready to save outputs");
  section(node, panel, "caption", captionText, () => captionRow("HISTORY", captionText));
  const historyKey = JSON.stringify([selected, mediaLoaded(), entries.map(entry => {
    const media = itemOf(entry.id);
    return [entry.id, media?.name, media?.kind, mediaDisplayState(media)];
  })]);
  section(node, panel, "history", historyKey, () => {
    const history = slotCells(entries, { draggable: true, selected: entries.length ? selected : -1, itemOf, onPick: index => {
      if (entries[index]) { node._krcMioOutputHistoryPick = index; render(node); }
    } });
    history.classList.add("krc-mio-output-history");
    history.setAttribute("aria-label", "Output history, newest to oldest");
    [...history.children].forEach((cell, index) => {
      cell.title = `${index === 0 ? "Newest" : `History ${index + 1}`} · ${itemOf(entries[index]?.id)?.name || (entries[index] ? "Missing media" : "empty")}`;
      cell.setAttribute("aria-label", cell.title);
    });
    return history;
  });
  section(node, panel, "bar", JSON.stringify([item?.id, item?.filename, item?.name, state.folder, folders[0]?.id, Boolean(folders.length)]), () => {
    const bar = el("div", "krc-mio-bar krc-mio-output-bar");
    bar.append(
      arrowButton("down", "DOWNLOAD", { disabled: !item,
        onclick: () => downloadMedia(item, { original: true }) }),
      // Always the Output side: this node's folder, else (Default) Unsorted.
      el("button", "krc-action-button krc-mio-media-btn", { type: "button", textContent: "MEDIA",
        onclick: () => openMedia({ view: "output", folder: folders.some(folder => folder.id === state.folder) ? state.folder : "" }) }),
    );
    return bar;
  });
  if (node._krcMioOutputLayoutChanged) fitMediaNode(node, MIN_W);
}

// "Show in queue and Assets" (Options, on by default): the run also reports its files under
// core's `images`, so ComfyUI's queue and Assets list them (they read the server's history).
// The KRC preview is the node's preview: ComfyUI's own box can't sit in the KRC layout, took
// image runs for video and kept a hidden <video> on the node. So the live "executed" message
// loses `images` / `animated` before ComfyUI reads it (a KRC Media Output message is the one
// carrying krc_media_outputs): ComfyUI loads and builds nothing for this node.
function stripNativeResults(detail) {
  const output = detail?.output;
  if (!Array.isArray(output?.krc_media_outputs)) return;
  delete output.images;
  delete output.animated;
}
if (!comfyApi._krcMediaOutputStrip) {
  comfyApi._krcMediaOutputStrip = true;
  if (typeof comfyApi.dispatchCustomEvent === "function") {
    const dispatchCustom = comfyApi.dispatchCustomEvent;
    comfyApi.dispatchCustomEvent = function (type, detail, ...rest) {
      if (type === "executed") stripNativeResults(detail);
      return dispatchCustom.call(this, type, detail, ...rest);
    };
  } else {
    const dispatch = comfyApi.dispatchEvent;
    comfyApi.dispatchEvent = function (event, ...rest) {
      if (event?.type === "executed") stripNativeResults(event.detail);
      return dispatch.call(this, event, ...rest);
    };
  }
}

// Fallback, for outputs that reach the node another way (a workflow opened from the queue):
// drop ComfyUI's loaded images, its image / video preview widgets and their elements.
// `images` stays as ComfyUI set it, so its draw handler doesn't load them again every frame.
const NATIVE_PREVIEW_WIDGETS = new Set(["$$canvas-image-preview", "video-preview"]);
function hideNativePreview(node) {
  if (node.imgs) node.imgs = undefined;
  for (let index = (node.widgets?.length || 0) - 1; index >= 0; index -= 1) {
    const widget = node.widgets[index];
    if (!NATIVE_PREVIEW_WIDGETS.has(widget?.name)) continue;
    widget.element?.querySelectorAll?.("video").forEach(video => { video.pause(); video.removeAttribute("src"); video.load(); });
    widget.onRemove?.();
    widget.element?.remove?.();
    node.widgets.splice(index, 1);
  }
  if (node.videoContainer) node.videoContainer = undefined;
}

app.registerExtension({
  name: "KRC.MediaIO.MediaOutput",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== OUTPUT_TYPE) return;
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      configure?.apply(this, args);
      ensureKey(this);
      prepare(this);
      scheduleRender(this);
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      executed?.apply(this, arguments);
      hideNativePreview(this);
      // Only this node's own outputs (a message meant for a node of another workflow is ignored).
      const key = readOutput(this).key;
      const records = (Array.isArray(message?.krc_media_outputs) ? message.krc_media_outputs : [])
        .filter(item => !item?.outputKey || item.outputKey === key);
      if (!records.length) return;
      if (autoDownload(this)) downloadOutputs(records);
      this.properties ||= {};
      this.properties.krcMediaOutputHistory = mergeOutputHistory(historyOf(this), records);
      this._krcMioOutputHistoryPick = 0;
      this._krcMioOutputPending = Object.fromEntries(records.map(item => [item.id, item]));
      markDirty(this);
      scheduleRender(this);
      const pending = this._krcMioOutputPending;
      refreshMediaItems().then(fresh => {
        if (this._krcMioOutputRemoved || this._krcMioOutputPending !== pending) return;
        if (fresh) this._krcMioOutputPending = null;
        scheduleRender(this);
      });
      loadContext(this, true);
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      this._krcMioOutputRemoved = true;
      this._krcMioOutputCleanup?.();
      this._krcMioRefitCleanup?.();
      if (this._krcMioOutputRenderFrame != null) cancelAnimationFrame(this._krcMioOutputRenderFrame);
      this._krcMioOutputRenderFrame = null;
      this._krcMioOutputSections = null;
      teardownMedia(uiOf(this)?.element);
      return removed?.apply(this, arguments);
    };
    const resize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      size[0] = Math.max(size[0], MIN_W);
      resize?.apply(this, arguments);
      fitMediaNode(this, MIN_W);
    };
    const menu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      menu?.apply(this, arguments);
      options.unshift({ content: "Options…", callback: () => openOptions(this) }, null);
    };
  },
  nodeCreated(node) {
    if (node?.comfyClass !== OUTPUT_TYPE) return;
    ensureStylesheet("krc-media-css", "../krc_media.css", import.meta.url, { version: STYLE_VERSION });
    ensureKey(node);
    // ← / → (its panel clicked, or the node selected): the previous / next history entry,
    // wrapping. A view change only.
    node._krcMioStep = (delta) => {
      const count = historyOf(node).length;
      if (!count) return;
      node._krcMioOutputHistoryPick = wrapIndex(Math.min(node._krcMioOutputHistoryPick ?? 0, count - 1), delta, count);
      render(node);
    };
    prepare(node);
    const { root, panel } = nodeShell("krc-mio-output");
    bindMediaKeys(root, node);
    node._krcMioRefitCleanup = refitOnPanelResize(panel, () => fitMediaNode(node, MIN_W));
    const widget = node.addDOMWidget(UI_WIDGET, "krc-media-output", root, {
      serialize: false, hideOnZoom: false, getMinHeight: () => contentHeight(node),
    });
    widget.computeSize = width => [width ?? MIN_W, contentHeight(node)];
    node.size[0] = MEDIA_NODE_DEFAULT_WIDTH;
    const draw = node.onDrawBackground;
    node.onDrawBackground = function (...args) {
      const result = draw?.apply(this, args);
      hideNativePreview(this);
      return result;
    };
    const offItems = onMediaItems(() => {
      if (node._krcMioOutputPending && Object.keys(node._krcMioOutputPending).every(id => mediaItem(id))) node._krcMioOutputPending = null;
      scheduleRender(node);
    });
    const offSync = subscribeKrcSync(MEDIA_EVENT, () => loadContext(node, true));
    node._krcMioOutputCleanup = () => { offItems?.(); offSync?.(); };
    render(node);
    loadContext(node);
  },
});
