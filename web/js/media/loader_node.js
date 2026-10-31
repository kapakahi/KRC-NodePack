import { installMediaDropTarget } from "./drag.js";
// KRC Media Loader, browser side (GAMEPLAN.md section 4): the image / video loader. It loads
// one slot of a media preset (6 slots, saved on every change):
//
//   header   preset ▾                                                    [Options]
//   preview  1:1, fit to the box (a video's poster plays on hover; a pending upload says
//            "Uploading…", then a conversion's progress and Stop), the file name under it
//   cells    the preset's 6 slots: click one to load it (the selected one ringed green)
//   bar      [Upload] [MEDIA]
//
// Barebones (Options; per node): one row, [preset ▾] [slot ▾] [Options]; the slot
// button shows the file name (or "Empty"), its menu "n · file name".
//
// Upload picks a file and uploads it at once with the defaults (no resize / trim, source
// fps, audio kept, orientation fixed) into Media and into the selected slot (the server
// assigns it when the upload is done). The Media Portal's own upload strip still stages a
// file for its Add. With the `preset` input connected the node follows that preset (Upload
// is off: which preset arrives is only known at run time). There's no bypass button (the
// Resizer's DISABLE covers it); a node bypassed with Ctrl+B still dims its preview. A new
// node starts on a new "Untitled n" preset.
import { app } from "../../../scripts/app.js";
import { applyNodePalette, ensureStylesheet, markDirty, subscribeKrcSync, switchToggle } from "./krc.js";
import { MEDIA_EVENT, displayName, mediaApi } from "./api.js";
import { LOADER_TYPE, LOADER_WIDGET, NODES_EVENT, isBypassed, isFollowing, readLoader, writeLoader } from "./nodes.js";
import { createPreset, onPresets, presetById, presetSlots, presetsLoaded, refreshPresets, setPresetSlot, setPresetSlots } from "./presets.js";
import { teardownMedia } from "./krc.js";
import { mediaDisplayState } from "./display.js";
import { mediaItem, mediaLoaded, mediaPreview, onMediaItems, refreshMediaItems } from "./preview.js";
import { MEDIA_NODE_DEFAULT_WIDTH, arrowButton, captionRow, clearAllButton, el, fitMediaNode, mediaNodeContentHeight, iconButton, nodeShell, openMedia, openNodeOptions, openSlotMenu, optionsButton, prepareDataWidget, presetButton, slotCells } from "./panel.js";

const UI_WIDGET = "krc_media_loader_ui";
const STYLE_VERSION = "1.0.2-shared-1668";
const MIN_W = MEDIA_NODE_DEFAULT_WIDTH;
const BAREBONES_MIN_W = 240;
const BAREBONES_PROP = "krcMioBarebones";
const ACCEPT = "image/*,video/*,.heic,.heif,.avif,.mkv";
const JOB_POLL_MS = 500;
const TAG = "[KRC Media]";

const uiOf = (node) => node.widgets?.find((widget) => widget.name === UI_WIDGET) || null;
const isBarebones = (node) => Boolean(node.properties?.[BAREBONES_PROP]);
const minWidth = (node) => (isBarebones(node) ? BAREBONES_MIN_W : MIN_W);

// The node's Options: the palette and the Barebones switch (saved on the node).
function openOptions(node) {
  const barebones = switchToggle({
    label: "Barebones",
    active: isBarebones(node),
    title: "One row: the preset and slot dropdowns and Options (no preview or buttons)",
    onClick: (event) => {
      node.properties ||= {};
      node.properties[BAREBONES_PROP] = !isBarebones(node);
      event?.currentTarget?.classList.toggle("is-on", isBarebones(node));
      event?.currentTarget?.classList.toggle("is-active", isBarebones(node));
      markDirty(node);
      render(node);
    },
  });
  openNodeOptions(node, "Media Loader options", uiOf(node)?.element || null, [barebones]);
}

// A quiet write: keeps the stored auto flag current without marking the workflow modified
// (nothing the user changed).
function quietLoader(node, fields) {
  const widget = node.widgets?.find((item) => item.name === LOADER_WIDGET);
  if (widget) widget.value = JSON.stringify({ ...readLoader(node), ...fields });
}

// ---- the upload in progress (kept on the node: { file, status, progress, error, jobId })
// Picking a file uploads it straight away; the preview says "Uploading…" meanwhile.
function upload(node, file) {
  if (!file || isFollowing(node)) return;
  drop(node);
  node._krcMioPending = { file, status: "uploading", progress: 0, error: "" };
  send(node);
}

function drop(node) {
  node._krcMioPending = null;
}

async function pollJob(node, pending) {
  if (node._krcMioPending !== pending || pending.status !== "converting") return;
  try {
    const { job } = await mediaApi.job(pending.jobId);
    if (node._krcMioPending !== pending) return;
    pending.progress = job.progress || 0;
    if (job.status === "done" || job.status === "cancelled") { drop(node); render(node); return; }
    if (job.status === "error") { pending.status = "error"; pending.error = job.error || "The conversion failed."; render(node); return; }
    render(node);
  } catch (error) {
    console.warn(`${TAG} couldn't read the conversion's progress: ${error?.message || error}`);
  }
  setTimeout(() => pollJob(node, pending), JOB_POLL_MS);
}

async function send(node) {
  const pending = node._krcMioPending;
  if (!pending) return;
  render(node);
  // An upload always works. Decide only once the presets are read (before that every
  // preset looks missing), then a node with no preset (deleted, or none yet) gets a new
  // "Preset n" (the first is "Preset 1") for the upload.
  if (!presetsLoaded()) await refreshPresets();
  let pick = readLoader(node);
  if (!presetById(pick.preset)) {
    const created = await createPreset({ numbered: true });
    if (!created.ok) { pending.status = "error"; pending.error = created.error; render(node); return; }
    writeLoader(node, { preset: created.preset.id, autoPreset: false });
    pick = readLoader(node);
  }
  try {
    const answer = await mediaApi.upload(pending.file, { assign: { preset: pick.preset, slot: pick.slot } });
    if (answer.job) {
      pending.status = "converting";
      pending.jobId = answer.job.id;
      render(node);
      pollJob(node, pending);
      return;
    }
    drop(node);
    render(node);
  } catch (error) {
    pending.status = "error";
    pending.error = String(error?.message || error);
    render(node);
  }
}

async function stop(node) {
  const pending = node._krcMioPending;
  if (pending?.status === "converting" && pending.jobId) {
    try {
      await mediaApi.cancelJob(pending.jobId);
    } catch (error) {
      console.warn(`${TAG} couldn't stop the conversion: ${error?.message || error}`);
    }
  }
  drop(node);
  render(node);
}

// ---- the preview -------------------------------------------------------------------------
// No local preview of the file: the box says "Uploading…" until the server has it, then
// shows the slot's media (a converting video keeps its progress and Stop at the bottom).
function pendingPreview(node, pending) {
  const busy = pending.status === "uploading" || pending.status === "converting";
  const box = mediaPreview(null, {
    empty: pending.status === "uploading" ? "Uploading…" : "",
    full: true,
    className: "krc-mio-pick-preview is-pending",
  });
  box.classList.toggle("is-busy", busy);
  if (pending.status === "uploading") return box;
  const overlay = el("div", "krc-mio-pending-overlay");
  overlay.append(el("span", `krc-mio-pending-text${pending.status === "error" ? " is-error" : ""}`, {
    textContent: pending.status === "converting" ? `Converting… ${Math.round((pending.progress || 0) * 100)}%`
      : pending.error || "The upload failed.",
  }));
  if (pending.status === "converting") {
    const bar = el("div", "krc-mio-progress");
    bar.append(el("div", "krc-mio-progress-fill", { style: `width: ${Math.round((pending.progress || 0) * 100)}%` }));
    overlay.append(bar);
  }
  if (pending.status !== "uploading") {
    overlay.append(iconButton(pending.status === "converting" ? "■" : "✕", pending.status === "converting" ? "Stop converting" : "Dismiss", () => stop(node), "krc-mio-pending-close"));
  }
  box.append(overlay);
  return box;
}

// The slot's media preview, kept while the slot holds the same item (a re-render never
// interrupts a hovered video).
function slotPreview(node, item, empty) {
  const key = JSON.stringify([item?.id, item?.kind, empty, mediaDisplayState(item)]);
  if (node._krcMioPreview?.key !== key) {
    teardownMedia(node._krcMioPreview?.box);
    node._krcMioPreview = { key, box: mediaPreview(item, { empty, full: true, holdPreview: true, typeIndicator: true, className: "krc-mio-pick-preview" }) };
  }
  return node._krcMioPreview.box;
}

// Drop only references an existing record; the saved file stays in input/output.
function canFillSlot(node, presetId) {
  const pending = node._krcMioPending;
  return Boolean(node.graph && !node._krcMioSlotBatch && !isFollowing(node) && readLoader(node).preset === presetId
    && presetById(presetId) && !["uploading", "converting"].includes(pending?.status));
}

async function fillSlot(node, presetId, index, id) {
  if (!canFillSlot(node, presetId)) return;
  const gesture = {};
  node._krcMioSlotDrop = gesture;
  if (!mediaItem(id)) await refreshMediaItems();
  if (!canFillSlot(node, presetId) || !mediaItem(id)) return;
  if (presetSlots(presetById(presetId))[index]?.id !== id) {
    const result = await setPresetSlot(presetId, index, { id });
    if (!result.ok) return;
  }
  // A preset switch, removed node or new connection during the save must not
  // change the new selection; the original drop still belongs to its preset.
  if (canFillSlot(node, presetId) && node._krcMioSlotDrop === gesture) {
    writeLoader(node, { slot: index, autoPreset: false });
    render(node);
  }
}

// Drops patch 1–6 references in wraparound order; Clear all replaces all six.
async function replaceSlots(node, presetId, ids, start = null) {
  if (!canFillSlot(node, presetId) || !Array.isArray(ids) || ids.length < 1 || ids.length > 6
    || (start === null ? ids.length !== 6 : !Number.isInteger(start) || start < 0 || start > 5)) return;
  const gesture = {};
  node._krcMioSlotDrop = gesture;
  node._krcMioSlotBatch = gesture;
  render(node);
  let result;
  try { result = await setPresetSlots(presetId, ids, start); }
  catch (error) { console.warn(`${TAG} couldn't replace slots: ${error?.message || error}`); }
  finally { if (node._krcMioSlotBatch === gesture) node._krcMioSlotBatch = null; }
  if (result?.ok && canFillSlot(node, presetId) && node._krcMioSlotDrop === gesture) {
    writeLoader(node, { slot: start ?? 0, autoPreset: false });
  }
  render(node);
}

// ---- render ------------------------------------------------------------------------------
function render(node) {
  const root = uiOf(node)?.element;
  if (!root) return;
  const panel = root.querySelector(".krc-mio-panel");
  applyNodePalette(node, root);
  const pick = readLoader(node);
  const following = isFollowing(node);
  const bypassed = isBypassed(node);
  const preset = presetById(pick.preset);
  const loaded = presetsLoaded();

  // A new node's untouched preset pruned at a restart: a fresh one, silently.
  if (loaded && !following && pick.autoPreset && !preset && !node._krcMioCreating) {
    node._krcMioCreating = true;
    createPreset({ auto: true }).then((result) => {
      node._krcMioCreating = false;
      if (result.ok) quietLoader(node, { preset: result.preset.id, autoPreset: true });
      render(node);
    });
  }
  const slots = presetSlots(preset);
  const slot = slots[pick.slot];
  if (preset && !following) {
    // Keep the stored auto flag current.
    if (pick.autoPreset && !preset.auto) quietLoader(node, { autoPreset: false });
  }

  // Nothing it shows changed (an echo, a repeat event): keep the DOM as it is.
  const item = slot?.id ? mediaItem(slot.id) : null;
  const pending = node._krcMioPending;
  const barebones = isBarebones(node);
  const drawn = JSON.stringify([barebones, pick.preset, pick.slot, following, bypassed, loaded, mediaLoaded(), preset,
    slots.map((entry) => (entry.id ? [entry.id, mediaItem(entry.id)?.name ?? null, mediaItem(entry.id)?.kind ?? null, mediaDisplayState(mediaItem(entry.id))] : "")),
    Boolean(node._krcMioSlotBatch), pending && [pending.status, Math.round((pending.progress || 0) * 100), pending.error]]);
  if (drawn === node._krcMioDrawn && panel.childElementCount) return;
  node._krcMioDrawn = drawn;

  // Header (both layouts): preset ▾ … Options.
  const presetPicker = presetButton({
    label: following ? "Follows the preset input" : preset ? preset.name : loaded && pick.preset ? "Missing preset" : loaded ? "Pick a preset" : "…",
    title: following ? "The preset input is connected: it decides the preset" : "Pick a media preset",
    disabled: following,
    currentId: pick.preset,
    onPick: (id) => {
      writeLoader(node, { preset: id, autoPreset: false });
      render(node);
    },
  });
  const options = optionsButton(() => openOptions(node));
  const clear = clearAllButton(() => replaceSlots(node, preset.id, Array(6).fill("")),
    !canFillSlot(node, preset?.id) || !slots.some(entry => entry.id), "Clear all slots (media files are kept)");
  const pickSlot = (index) => {
    writeLoader(node, { slot: index });
    render(node);
  };
  const fileLabel = (entry) => {
    if (!entry?.id) return "Empty";
    const found = mediaItem(entry.id);
    return found ? displayName(found) : mediaLoaded() ? "Missing" : "…";
  };

  if (barebones) {
    // One row: preset ▾, slot ▾ (the file name; the menu has number · file), Options.
    const slotPicker = el("button", "krc-action-button krc-mio-preset-btn krc-mio-slot-btn", {
      type: "button",
      title: following ? `Slot ${pick.slot + 1} of the preset that arrives` : `Slot ${pick.slot + 1}`,
    });
    slotPicker.append(
      el("span", "krc-mio-preset-label", { textContent: following ? `Slot ${pick.slot + 1}` : fileLabel(slot) }),
      el("span", "krc-mio-preset-caret", { textContent: "▾" }),
    );
    slotPicker.addEventListener("click", (event) => {
      event.stopPropagation();
      openSlotMenu(slotPicker, Array.from({ length: 6 }, (_, index) => {
        const entry = slots[index];
        return {
          label: following ? `Slot ${index + 1}` : `${index + 1} · ${fileLabel(entry)}`,
          muted: !following && !entry?.id,
          selected: index === pick.slot,
        };
      }), pickSlot);
    });
    const row = el("div", "krc-panel-header krc-mio-header krc-mio-barebones-row");
    row.append(presetPicker, slotPicker, clear, options);
    row.classList.toggle("is-disabled", bypassed);
    panel.replaceChildren(row);
    fit(node);
    return;
  }

  const header = el("div", "krc-panel-header krc-mio-header");
  header.append(presetPicker, el("span", "krc-mio-header-gap"), clear, options);

  // Preview: the pending upload, else the slot's media.
  const empty = following ? "Follows the preset input" : !loaded ? "Loading…" : !preset ? (pick.preset ? "Missing preset" : "No preset")
    : !slot?.id ? "Empty slot: Upload or drag media into a slot" : item ? "" : mediaLoaded() ? "Missing media" : "Loading…";
  const preview = pending ? pendingPreview(node, pending) : slotPreview(node, item, empty);
  preview.classList.toggle("is-disabled", bypassed);
  preview.dataset.disabledLabel = "Bypassed";

  const caption = captionRow("SLOT", following ? "Loads the same slot of the preset that arrives"
    : item ? displayName(item) : slot?.id && mediaLoaded() ? "Missing — its media was deleted" : "");

  const cells = slotCells(following ? [] : slots, {
    selected: pick.slot, itemOf: mediaItem, onPick: pickSlot,
    canDrop: () => canFillSlot(node, preset?.id),
    onDrop: (index, id) => fillSlot(node, preset?.id, index, id),
    onDropMany: (index, ids) => replaceSlots(node, preset?.id, ids, index),
  });

  const picker = root.querySelector(".krc-mio-file") || el("input", "krc-mio-file", { type: "file", accept: ACCEPT, hidden: true });
  picker.onchange = () => { upload(node, picker.files?.[0]); picker.value = ""; };
  const busy = pending?.status === "uploading" || pending?.status === "converting";
  const bar = el("div", "krc-mio-bar");
  bar.append(
    arrowButton("up", busy ? "…" : "UPLOAD", {
      title: following ? "Off while the preset input is connected" : `Upload an image or video into Media and slot ${pick.slot + 1}`,
      disabled: busy || following,
      onclick: () => picker.click(),
    }, "krc-mio-upload"),
    el("button", "krc-action-button krc-mio-media-btn", {
      type: "button", textContent: "MEDIA", title: "Open Media as you left it (the first time: this preset)",
      onclick: () => openMedia({ preset: following ? "" : pick.preset, slot: pick.slot }),
    }),
  );
  panel.replaceChildren(header, preview, caption, cells, bar);
  if (!picker.isConnected) root.append(picker);
  fit(node);
}

// The node's height follows its width: the square preview plus the rows around it
// (Barebones: just its row).
function contentHeight(node) {
  return mediaNodeContentHeight(node, UI_WIDGET, MIN_W, isBarebones(node));
}

function fit(node) {
  fitMediaNode(node, minWidth(node));
}

// Every Media Loader on the page re-renders when presets, the Media, a node's pick or a
// node's mode change (Ctrl+B included: the mode is checked twice a second).
const liveNodes = new Set();
const refreshAll = () => {
  for (const node of liveNodes) if (node.graph) render(node);
};
window.addEventListener(NODES_EVENT, refreshAll);
subscribeKrcSync(MEDIA_EVENT, refreshAll);
onPresets(refreshAll);
onMediaItems(refreshAll);
setInterval(() => {
  for (const node of liveNodes) {
    const state = `${node.mode}:${isFollowing(node)}`;
    if (node.graph && node._krcMioState !== state) {
      node._krcMioState = state;
      render(node);
    }
  }
}, 500);

app.registerExtension({
  name: "KRC.MediaIO.MediaLoader",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== LOADER_TYPE) return;
    const extraMenu = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function (canvas, options) {
      extraMenu?.apply(this, arguments);
      const pick = readLoader(this);
      options.unshift(
        { content: "Open Media", callback: () => openMedia({ preset: pick.preset, slot: pick.slot }) },
        { content: "Options…", callback: () => openOptions(this) },
        null,
      );
    };
    const configure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (...args) {
      configure?.apply(this, args);
      this._krcMioConfigured = true;
      prepareDataWidget(this, LOADER_WIDGET);
      requestAnimationFrame(() => render(this));
    };
    const resize = nodeType.prototype.onResize;
    nodeType.prototype.onResize = function (size) {
      size[0] = Math.max(size[0], minWidth(this));
      resize?.apply(this, arguments);
      fit(this);   // a wider node has a taller square
    };
    const removed = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function (...args) {
      liveNodes.delete(this);
      teardownMedia(uiOf(this)?.element);
      this._krcMioPreview = null;
      drop(this);
      return removed?.apply(this, args);
    };
  },
  nodeCreated(node) {
    if (node?.comfyClass !== LOADER_TYPE) return;
    ensureStylesheet("krc-media-css", "../krc_media.css", import.meta.url, { version: STYLE_VERSION });
    prepareDataWidget(node, LOADER_WIDGET);
    const { root, panel } = nodeShell("krc-mio-loader");
    installMediaDropTarget(panel, {
      enabled: () => canFillSlot(node, readLoader(node).preset),
      onDropMany: ids => replaceSlots(node, readLoader(node).preset, ids, readLoader(node).slot),
    });
    const widget = node.addDOMWidget(UI_WIDGET, "krc-media-loader", root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => contentHeight(node),
    });
    widget.computeSize = (width) => [width ?? MIN_W, contentHeight(node)];
    applyNodePalette(node, root);
    liveNodes.add(node);
    node.size[0] = isBarebones(node) ? minWidth(node) : MEDIA_NODE_DEFAULT_WIDTH;
    render(node);
    // A brand-new node (not a loaded or pasted one, which configure) starts on a new
    // "Untitled n" preset.
    requestAnimationFrame(() => {
      if (node._krcMioConfigured || readLoader(node).preset) return;
      createPreset({ auto: true }).then((result) => {
        if (result.ok && !node._krcMioConfigured) {
          quietLoader(node, { preset: result.preset.id, slot: 0, autoPreset: true });
          render(node);
        }
      });
    });
  },
});
