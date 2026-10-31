/*
 * KRC floating popup menu — shared open/position/close machinery for the small
 * body-appended dropdown menus (the card-color picker, the compact browser
 * sort / name-mode selects).
 *
 * Why a shared helper: a menu appended to <body> lives OUTSIDE its node's
 * data-krc-theme subtree, so it would fall back to the global palette (only ever
 * the one on :root) and ignore the node's own per-node theme. We copy the
 * anchor's nearest themed ancestor onto the menu so the dropdown matches its
 * surroundings; stamping data-krc-theme on the menu makes the :where([data-krc-
 * theme]) block in design_tokens.css re-derive the solid --krc-* tokens on it.
 * Native maps to Gray (floatingPaletteId) because the menu floats over the page,
 * not over the node's own canvas color.
 *
 * One menu is open at a time (module singleton); it closes on any outside
 * pointerdown. Callers build their own menu element + option children and style
 * them; this module only owns show/hide/position/theme.
 */
import { floatingPaletteId } from "./node_palette.js";

let openMenu = null;

export function hasFloatingMenu() {
  return Boolean(openMenu);
}

export function closeFloatingMenu() {
  openMenu?.close();
  openMenu = null;
}

function syncMenuTheme(anchor, menu) {
  const id = floatingPaletteId(anchor.closest("[data-krc-theme]")?.dataset?.krcTheme || "");
  if (id) menu.dataset.krcTheme = id;
  else delete menu.dataset.krcTheme;
}

function positionMenu(anchor, menu, align, gap) {
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = menu.offsetWidth || 0;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  let left = align === "right" ? rect.right - width : rect.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, viewportW - width - margin));
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(rect.bottom + gap)}px`;
}

// Open `menu` under `anchor`, or close it if it is the one already open (so a
// second click on the anchor toggles). Returns true when it ends up open.
// `positionAnchor` overrides which element the menu is placed against (defaults to the
// toggle anchor) — e.g. a card notch menu toggles from the small notch button but opens
// flush below the whole card. `gap` is the px offset below that anchor (0 = native
// dropdown feel, flush to the card).
export function toggleFloatingMenu(anchor, menu, { align = "left", onClose = null, positionAnchor = anchor, gap = 4 } = {}) {
  const wasOpen = openMenu?.menu === menu && !menu.hidden;
  closeFloatingMenu();
  if (wasOpen) return false;

  if (!menu.isConnected) document.body.append(menu);
  // Shared marker so body-appended floating menus are recognizable as "part of" a
  // host surface (e.g. the library portal's click-outside handler ignores them, so
  // picking a color/badge doesn't dismiss the portal).
  menu.classList.add("krc-floating-menu");
  syncMenuTheme(anchor, menu);
  menu.hidden = false;
  positionMenu(positionAnchor, menu, align, gap);

  const onDocPointerDown = (event) => {
    if (event.target === anchor || anchor.contains(event.target) || menu.contains(event.target)) return;
    closeFloatingMenu();
  };
  openMenu = {
    menu,
    close: () => {
      document.removeEventListener("pointerdown", onDocPointerDown, true);
      menu.hidden = true;
      menu.remove();
      onClose?.();
    },
  };
  // Defer the outside-close listener so the click that opened us doesn't close it.
  setTimeout(() => document.addEventListener("pointerdown", onDocPointerDown, true), 0);
  return true;
}
