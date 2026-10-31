/*
 * KRC shared modal — the pack-wide popup dialog primitive.
 *
 * `openKrcModal(...)` builds the standard KRC NodePack dialog: a centered
 * panel over a dimmed backdrop, with a header (title + × close), a scrollable
 * body slot the caller fills, and an optional footer action row. It owns the
 * chrome and all the close behavior (× / Escape / backdrop click) so every
 * consumer gets identical look and feel — the single "Options" dialog standard.
 *
 * Content-agnostic: callers pass their own body content (and either `actions`
 * button descriptors or arbitrary `footer` content). Chrome + button styles
 * live in shared/modal.css; content primitives (.krc-modal-select/-list/-row/
 * -count) are there too for list dialogs.
 *
 * Per-node theming: the overlay is appended to <body>, so a global palette
 * (data-krc-theme on :root) already cascades to it, but a per-node palette does
 * not. When a `node` is passed, its stored palette (node.properties.krcTheme)
 * is stamped onto the overlay so the dialog previews in the same palette as the
 * node it belongs to. Nodes without a per-node palette fall through to global.
 * Native is the exception: dialogs use Gray because they have no node body
 * color behind them.
 */
import { armConfirmButton } from "./confirm_action.js";
import { el, stopCanvasEvents } from "./dom.js";
import { modalPaletteIdForNode } from "./node_palette.js";
import { ensureStylesheet } from "./stylesheets.js";

const STYLE_ID = "krc-modal-style";
const STYLE_VERSION = "1.0.17-bundle-toggles";

// Preload the modal stylesheet at IMPORT time (not lazily on first open) and keep the
// real load-tracking promise. modal.css arrives via an async <link>, so opening a modal
// before it finished painted an unstyled panel that filled the full-width overlay for a
// beat — a horizontal stretch flash. Preloading gives it the whole session to load, and
// the promise lets openKrcModal keep the panel hidden until the CSS is actually applied.
const modalStylesReady = ensureStylesheet(
  STYLE_ID, "./modal.css", import.meta.url, { version: STYLE_VERSION, ready: true },
);

function ensureModalStyles() {
  return modalStylesReady;
}

function appendContent(parent, content) {
  for (const child of [].concat(content)) {
    if (!child) continue;
    parent.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
}

/*
 * Build a single shared IMPORT/EXPORT button — the pack-wide I/O control.
 *
 * A compact, fixed-width button carrying a direction glyph + label (from the
 * ACTION_EXPORT/ACTION_IMPORT vocabulary in shared/actions.js) in a neutral
 * utility style, so "file out" / "file in" reads and looks identical everywhere.
 */
export function krcIoButton({ action = null, glyph = "", label = "", title = "", onClick, disabled = false } = {}) {
  const g = action?.glyph ?? glyph;
  const text = action?.label ?? label;
  const btn = el("button", "krc-io-btn", { type: "button" });
  if (title) btn.title = title;
  if (disabled) btn.disabled = true;
  if (g) btn.appendChild(el("span", "krc-io-btn-glyph", { textContent: g }));
  btn.appendChild(el("span", "krc-io-btn-label", { textContent: text }));
  if (onClick) {
    btn.addEventListener("click", (event) => {
      const overlay = btn.closest(".krc-modal-overlay");
      onClick({ close: overlay?._krcModalClose || (() => {}), btn, event });
    });
  }
  return btn;
}

/*
 * A modal "cell": the pack-wide sub-section used to group related controls in
 * an Options dialog (a bordered, filled, rounded box with a small uppercase
 * title). This is the shared standard so every node's Options dialog reads the
 * same. Pass `title` for the header, or omit it for a title-less cell (e.g. the
 * IMPORT/EXPORT cell, which carries no header). `body` is any DOM/string/array.
 */
export function krcModalSection({ title = "", body = null } = {}) {
  const section = el("div", "krc-modal-section");
  if (title) section.appendChild(el("div", "krc-modal-section-title", { textContent: title }));
  appendContent(section, body);
  return section;
}

/*
 * Open a modal dialog. Returns { overlay, panel, body, head, title, foot, close }
 * so callers can reach into the shell or close it programmatically.
 *
 * Options:
 *   node            LiteGraph node the dialog belongs to; used to stamp its
 *                   per-node palette onto the overlay (optional).
 *   title           header text.
 *   body            DOM node / string / array appended to the body slot.
 *   actions         array of { label, onClick({ close, btn }), primary,
 *                   className, disabled } → standard footer buttons. Ignored
 *                   when `footer` is given.
 *   footer          DOM node / string / array appended to the panel as-is
 *                   after the body (wins over `actions`) — for custom footers
 *                   such as a multi-row action bar; omit both for no footer.
 *   width           panel width override (number → px, or any CSS length).
 *   height          panel height override (number → px, or any CSS length).
 *   resizable       add a bottom-right drag handle so the user can resize the
 *                   panel (width/height become the starting size; not persisted).
 *   draggable       let the user move the panel by dragging the header.
 *   dimBackdrop     dim the page behind the modal (default true).
 *   closeOnBackdrop close when the dimmed backdrop is clicked (default true).
 *   closeOnEscape   close on the Escape key (default true).
 *   onClose         called once after the modal is removed.
 *   canClose        optional guard for every close path (e.g. while writing).
 */
export function openKrcModal({
  node = null,
  title = "",
  body = null,
  actions = null,
  footer = null,
  width = null,
  height = null,
  resizable = false,
  draggable = false,
  dimBackdrop = true,
  closeOnBackdrop = true,
  closeOnEscape = true,
  onClose = null,
  canClose = () => true,
} = {}) {
  const stylesReady = ensureModalStyles();

  const overlay = el("div", "krc-modal-overlay");
  if (!dimBackdrop) overlay.classList.add("is-undimmed");
  const themeId = modalPaletteIdForNode(node);
  if (themeId) overlay.dataset.krcTheme = themeId;

  const panel = el("div", "krc-modal-panel");
  // Guard the very first open (before modal.css finished loading): keep the panel
  // hidden until the stylesheet is applied so it never flashes unstyled/full-width.
  // visibility (not display) preserves layout/measurement; already-loaded resolves on a
  // microtask, so subsequent opens reveal it the same frame (no perceptible delay).
  panel.style.visibility = "hidden";
  stylesReady.then(() => { panel.style.visibility = ""; });
  if (resizable) panel.classList.add("is-resizable");
  if (width != null) panel.style.width = typeof width === "number" ? `${width}px` : width;
  if (height != null) {
    panel.style.height = typeof height === "number" ? `${height}px` : height;
    // A resizable panel needs headroom to grow past its starting height, so let
    // the CSS max-height cap it; otherwise pin max-height to the fixed height.
    if (!resizable) panel.style.maxHeight = panel.style.height;
  }

  const titleEl = el("div", "krc-modal-title", { textContent: title });
  const x = el("button", "krc-modal-x", { textContent: "×", title: "Close", type: "button" });
  const head = el("div", "krc-modal-head");
  head.append(titleEl, x);
  if (draggable) {
    panel.classList.add("is-draggable");
    makePanelDraggable(panel, head);
  }

  const bodyEl = el("div", "krc-modal-body");
  if (body) appendContent(bodyEl, body);

  panel.append(head, bodyEl);

  let closed = false;
  function close() {
    if (closed || !canClose()) return;
    closed = true;
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
    onClose?.();
  }
  overlay._krcModalClose = close;
  function onKey(event) {
    const stack = Array.from(document.querySelectorAll(".krc-modal-overlay"));
    const isTop = stack[stack.length - 1] === overlay;
    if (closeOnEscape && isTop && event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  }

  // Footer: explicit `footer` content is appended to the panel as-is (caller
  // owns its layout); otherwise build a standard action row from `actions`.
  // Omit both → no footer.
  let footEl = null;
  if (footer) {
    appendContent(panel, footer);
  } else if (actions && actions.length) {
    footEl = el("div", "krc-modal-foot");
    for (const action of actions) {
      const cls = action.primary ? "krc-modal-btn-primary" : "krc-modal-btn";
      const btn = el("button", action.className ? `${cls} ${action.className}` : cls, {
        textContent: action.label,
        type: "button",
      });
      btn.disabled = !!action.disabled;
      btn.addEventListener("click", () => action.onClick?.({ close, btn }));
      action.btn = btn; // let callers keep the descriptor and reach its element
      footEl.appendChild(btn);
    }
  }
  if (footEl) panel.appendChild(footEl);

  overlay.appendChild(panel);
  // Keep clicks/keys inside the dialog from reaching the LiteGraph canvas.
  stopCanvasEvents(overlay);
  x.addEventListener("click", close);
  if (closeOnBackdrop) {
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) close();
    });
  }
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(overlay);

  return { overlay, panel, body: bodyEl, head, title: titleEl, foot: footEl, close };
}

// Small themed confirm dialog built on openKrcModal. Resolves true when the user
// confirms, false on cancel / backdrop / Escape / ×. For deliberate, reversible
// actions that still warrant a beat of friction (e.g. marking a model verified).
// `danger` paints the confirm button red. `armed` (for the most destructive ones) makes
// it a two-step button: the first click turns it into `armedLabel`, a second click
// within a few seconds confirms.
export function openKrcConfirm({
  node = null,
  title = "Confirm",
  message = "",
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  danger = false,
  armed = false,
  armedLabel = "Sure?",
  width = 360,
} = {}) {
  return new Promise((resolve) => {
    let confirmed = false;
    const body = el("div", "krc-confirm-message", { textContent: message });
    const confirmAction = {
      label: confirmLabel,
      primary: true,
      className: danger ? "is-danger" : "",
      onClick: armed ? null : ({ close }) => { confirmed = true; close(); },
    };
    const modal = openKrcModal({
      node,
      title,
      body,
      width,
      onClose: () => resolve(confirmed),
      actions: [
        { label: cancelLabel, onClick: ({ close }) => close() },
        confirmAction,
      ],
    });
    if (armed && confirmAction.btn) {
      armConfirmButton(confirmAction.btn, {
        armedText: armedLabel,
        armedTitle: "Click again to confirm",
        onConfirm: () => { confirmed = true; modal.close(); },
      });
    }
  });
}

// Small themed message dialog built on openKrcModal (replaces window.alert). Resolves
// once dismissed (OK / backdrop / Escape / ×). For errors and notices the user caused by
// clicking something, so they shouldn't be easy to miss.
export function openKrcAlert({
  node = null,
  title = "KRC NodePack",
  message = "",
  okLabel = "OK",
  width = 360,
} = {}) {
  return new Promise((resolve) => {
    const body = el("div", "krc-confirm-message", { textContent: message });
    openKrcModal({
      node,
      title,
      body,
      width,
      onClose: () => resolve(),
      actions: [{ label: okLabel, primary: true, onClick: ({ close }) => close() }],
    });
  });
}

// Shorthand: krcAlert("Could not save preset.", node).
export function krcAlert(message, node = null) {
  return openKrcAlert({ node, message: String(message ?? "") });
}

function makePanelDraggable(panel, handle) {
  let start = null;
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || event.target.closest?.("button, input, select, textarea, a")) return;
    const rect = panel.getBoundingClientRect();
    start = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    panel.classList.add("is-moving");
    panel.style.position = "fixed";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.width = `${rect.width}px`;
    panel.style.height = `${rect.height}px`;
    panel.style.margin = "0";
    handle.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });

  handle.addEventListener("pointermove", (event) => {
    if (!start || event.pointerId !== start.pointerId) return;
    const margin = 8;
    const nextLeft = Math.max(margin, Math.min(start.left + event.clientX - start.x, window.innerWidth - start.width - margin));
    const nextTop = Math.max(margin, Math.min(start.top + event.clientY - start.y, window.innerHeight - start.height - margin));
    panel.style.left = `${nextLeft}px`;
    panel.style.top = `${nextTop}px`;
  });

  const endDrag = (event) => {
    if (!start || event.pointerId !== start.pointerId) return;
    panel.classList.remove("is-moving");
    handle.releasePointerCapture?.(event.pointerId);
    start = null;
  };
  handle.addEventListener("pointerup", endDrag);
  handle.addEventListener("pointercancel", endDrag);
}
