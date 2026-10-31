// The Media Loader's canvas pieces (GAMEPLAN.md section 4), kept apart from its logic: the
// KRC node structure (.krc-node.krc-solo-widget › .krc-panel › .krc-panel-header), the
// hidden data widget, the preset button (from presets.js), the 6 slot cells, the
// Options modal (the node palette), and the Media opener.
import { installMediaDropTarget, makeMediaDraggable } from "./drag.js";
import { thumbnailBox } from "./krc.js";
import { mediaDisplayState } from "./display.js";
import { buildNodePaletteField, closeFloatingMenu, openKrcModal, openLibraryModal, toggleFloatingMenu } from "./krc.js";
import { mediaApi } from "./api.js";
import { MEDIA_PROVIDER_ID } from "./mode.js";
import { SLOT_COUNT } from "./presets.js";

export { presetButton } from "./presets.js";

// Node 2.0 reserves 24px around the DOM root; the panel adds 16px padding.
// A 318px node therefore has a 278px square preview. With its 43px slot strip,
// 69px controls, 24px gaps and 16px padding, the full DOM is 430px (Resizer).
// This is also the full-layout minimum so loaded 280px nodes adopt the new size.
export const MEDIA_NODE_DEFAULT_WIDTH = 318;

export const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

// The data widget carries the pick but is never drawn (Node 2.0 needs the type change; the
// root's .krc-solo-widget collapses its empty row). `serialize` (optional) is what the
// prompt gets when it's queued.
export function prepareDataWidget(node, name, serialize = null) {
  const widget = node.widgets?.find((item) => item.name === name);
  if (!widget) return null;
  widget.hidden = true;
  widget.type = "hidden";
  widget.computeSize = () => [0, -4];
  if (serialize) widget.serializeValue = () => serialize();
  const element = widget.element || widget.inputEl;
  if (element?.style) element.style.display = "none";
  return widget;
}

// The node's root and its background cell; `render` fills the panel.
export function nodeShell(className) {
  const root = el("div", `krc-node krc-solo-widget krc-mio-node ${className}`);
  const panel = el("div", "krc-panel krc-mio-panel");
  root.append(panel);
  return { root, panel };
}

export function iconButton(text, title, onClick, extra = "") {
  return el("button", `krc-icon-button ${extra}`.trim(), {
    type: "button", textContent: text, title,
    onclick: (event) => { event.stopPropagation(); onClick(); },
  });
}

// Compact, centered media controls use one vector style in the node header.
export function mediaControlButton(kind, onClick) {
  const paths = kind === "clear"
    ? '<rect x="7" y="7" width="14" height="14" rx="2"/><path d="M17 3H5a2 2 0 0 0-2 2v12M11 11l6 6M17 11l-6 6"/>'
    : kind === "mute"
    ? '<path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>'
    : '<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/><path d="m10 8 6 4-6 4z" fill="currentColor" stroke="none"/>';
  const button = iconButton("", "", onClick, `krc-mio-control krc-mio-output-${kind}`);
  const glyph = el("span", "krc-mio-control-glyph");
  glyph.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  button.append(glyph);
  return button;
}

export function clearAllButton(onClick, disabled = false, title = "Clear all references (media files are kept)") {
  const button = mediaControlButton("clear", onClick);
  button.classList.add("krc-mio-clear-all");
  button.title = title;
  button.setAttribute("aria-label", title);
  button.disabled = disabled;
  return button;
}

// The row above the cells: what the cells are (SLOT / HISTORY) on the left, the shown
// media's name on the right. The label tells a Loader from an Output at a glance.
export function captionRow(label, text) {
  const row = el("div", "krc-mio-slot-sub krc-mio-caption");
  const name = el("span", "krc-mio-caption-name", { textContent: text, title: text });
  row.append(el("span", "krc-mio-caption-label", { textContent: label }), name);
  return row;
}

// A bar button with a thick arrow before its label (UPLOAD up, DOWNLOAD down).
const ARROWS = { up: "M8 13V3M3.5 7.5 8 3l4.5 4.5", down: "M8 3v10M3.5 8.5 8 13l4.5-4.5" };
export function arrowButton(direction, label, props = {}, extra = "") {
  const button = el("button", `krc-action-button krc-mio-arrow-btn ${extra}`.trim(), { type: "button", ...props });
  const glyph = el("span", "krc-mio-arrow-glyph");
  glyph.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ARROWS[direction]}"/></svg>`;
  button.append(glyph, el("span", "", { textContent: label }));
  return button;
}

// The 6 slot cells: the slot's thumbnail (or its number), the selected one ringed.
// `slots` may be shorter (no preset): the rest show their numbers.
export function slotCells(slots, { selected = -1, onPick = null, itemOf = () => null, onDrop = null, onDropMany = null, canDrop = () => true, draggable = false } = {}) {
  const row = el("div", "krc-mio-cells");
  for (let index = 0; index < SLOT_COUNT; index += 1) {
    const slot = slots[index];
    const item = slot?.id ? itemOf(slot.id) : null;
    const cell = el(onPick ? "button" : "div", `krc-mio-cell${index === selected ? " is-selected" : ""}${slot?.id ? "" : " is-empty"}${slot?.id && !item ? " is-loading" : ""}`, {
      title: `Slot ${index + 1}${slot?.id ? "" : " (empty)"}`,
    });
    if (onPick) {
      cell.type = "button";
      cell.addEventListener("click", (event) => { event.stopPropagation(); onPick(index); });
    }
    if (slot?.id) {
      const visibility = mediaDisplayState(item);
      cell.append(thumbnailBox({ className: "krc-mio-cell-img", ...mediaApi.thumbnailSpec(item, visibility), draggable: false }));
    }
    if (onDrop || onDropMany) installMediaDropTarget(cell, { enabled: canDrop, onDrop: onDrop ? id => onDrop(index, id) : null, onDropMany: onDropMany ? ids => onDropMany(index, ids) : null });
    if (draggable && item) makeMediaDraggable(cell, () => itemOf(slot.id));
    cell.append(el("span", "krc-mio-cell-number", { textContent: String(index + 1) }));
    row.append(cell);
  }
  return row;
}

// NodePack's Options button: its CSS gear glyph in a KRC icon button (as the Loadout Kit's).
export function optionsButton(onClick) {
  const button = el("button", "krc-icon-button krc-config-button krc-mio-options", { type: "button", title: "Options" });
  button.setAttribute("aria-label", "Options");
  button.append(el("span", "krc-gear-glyph"));
  button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return button;
}

// The slot picker as a dropdown (Barebones): `entries` [{ label, muted, selected }], one per
// slot; `onPick(index)`. NodePack's preset-menu look.
export function openSlotMenu(anchor, entries, onPick) {
  const menu = el("div", "krc-preset-menu is-portal-menu is-fixed krc-mio-preset-menu");
  menu.hidden = true;
  const list = el("div", "krc-preset-option-list");
  entries.forEach((entry, index) => {
    list.append(el("button", `krc-preset-option${entry.selected ? " is-selected" : ""}${entry.muted ? " is-muted" : ""}`, {
      type: "button",
      textContent: entry.label,
      title: entry.label,
      onclick: (event) => {
        event.stopPropagation();
        closeFloatingMenu();
        onPick(index);
      },
    }));
  });
  menu.append(list);
  toggleFloatingMenu(anchor, menu);
}

// Both numeric Options fields share KRC's split up/down strip, while native
// number stepping retains min/max/step and keyboard behavior across browsers.
export function numberField(input) {
  const wrap = el("span", "krc-mio-number-field");
  const arrows = el("span", "krc-mio-number-arrows");
  const buttons = [1, -1].map(direction => {
    const label = direction > 0 ? "Increase" : "Decrease";
    const button = el("button", "", { type: "button", title: label });
    button.setAttribute("aria-label", `${label} ${input.getAttribute("aria-label") || "value"}`);
    button.append(el("span", `krc-mio-number-glyph ${direction > 0 ? "is-up" : "is-down"}`, {
      textContent: direction > 0 ? "▴" : "▾",
    }));
    button.addEventListener("click", event => {
      event.preventDefault();
      if (input.disabled) return;
      direction > 0 ? input.stepUp() : input.stepDown();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return button;
  });
  arrows.append(...buttons);
  wrap.append(input, arrows);
  wrap.syncDisabled = () => { for (const button of buttons) button.disabled = input.disabled; };
  wrap.syncDisabled();
  return wrap;
}

// Match the shared modal width; node-specific fields precede the palette.
export function openNodeOptions(node, title, root, extra = []) {
  const body = [...extra, buildNodePaletteField({ node, root })];
  for (const field of body) field.classList.add("krc-mio-node-options");
  openKrcModal({ node, title, body });
}

// Media's Presets page on the node's `preset` with its slot `slot` selected (never a
// resume: the node says where); without a preset (a following node), Media as it is.
// `view: "output"` opens the Output side on `folder` ("" = Unsorted), whatever exists.
export function openMedia({ preset = "", slot = 0, folder = "", view = "" } = {}) {
  openLibraryModal({
    provider: MEDIA_PROVIDER_ID,
    infoOpen: true,
    ...(preset ? { select: { preset, slot } } : view === "output" ? { select: { view, folder } } : folder ? { select: { folder } } : {}),
  });
}

// Loader and Output share sizing so their square previews and surrounding rows align.
export function mediaNodeContentHeight(node, widgetName, minWidth, barebones = false) {
  const root = node.widgets?.find(widget => widget.name === widgetName)?.element;
  const panel = root?.querySelector(".krc-mio-panel");
  if (barebones) return Math.max(panel?.offsetHeight || 0, 40) + 4;
  const width = Math.max(Math.max(node.size?.[0] || 0, minWidth) - 24 - 16, 120);
  const rows = [...(panel?.children || [])].filter(child => !child.classList.contains("krc-mio-preview"));
  // Slot squares scale with the requested width. Measuring their old, rounded
  // offsetHeight during a resize uses stale geometry and can accumulate a pixel.
  const measured = rows.reduce((sum, child) => sum + (child.classList.contains("krc-mio-cells")
    ? (width - 4 * (SLOT_COUNT - 1)) / SLOT_COUNT
    : child.offsetHeight || 0), 0);
  return width + (measured || 69 + (width - 4 * (SLOT_COUNT - 1)) / SLOT_COUNT) + 6 * (rows.length || 4) + 16 + 4;
}

export function fitMediaNode(node, minWidth) {
  requestAnimationFrame(() => {
    const want = (node.computeSize?.() || node.size)[1];
    const width = Math.max(node.size?.[0] || 0, minWidth);
    if (Math.abs((node.size?.[1] || 0) - want) > 1 || width !== node.size?.[0]) node.setSize?.([width, want]);
    node.setDirtyCanvas?.(true, true);
  });
}
