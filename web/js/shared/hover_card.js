/*
 * KRC hover card: a themed card shown while the pointer is over an anchor. Attached to
 * document.body (so the canvas never clips it), in the anchor's node palette (as
 * floating_menu does), placed below the anchor or above it when there's no room.
 *
 * The card stays open while the pointer is over the anchor or the card, so a long card
 * can be scrolled; leaving both closes it after a short grace (crossing the gap between
 * them doesn't). A click outside the card, a key press, a scroll outside the card, or the
 * anchor leaving the page closes it. Touch has no hover, so no card.
 *
 * Users: the status badges' change list (shared/change_list.js); the search-hint
 * tooltip reuses placeFloating / syncFloatingTheme.
 */
import { floatingPaletteId } from "./node_palette.js";

const SHOW_DELAY_MS = 400;
const LEAVE_GRACE_MS = 200;

export function syncFloatingTheme(anchor, el) {
  const id = floatingPaletteId(anchor.closest("[data-krc-theme]")?.dataset?.krcTheme || "");
  if (id) el.dataset.krcTheme = id;
  else delete el.dataset.krcTheme;
}

// Place `el` (position: fixed) under `anchor`, flipped above when it doesn't fit below,
// kept inside the viewport. align "right" lines the card's right edge up with the anchor's.
export function placeFloating(anchor, el, { align = "left", gap = 6, margin = 8 } = {}) {
  const rect = anchor.getBoundingClientRect();
  const width = el.offsetWidth || 0;
  const height = el.offsetHeight || 0;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  let left = align === "right" ? rect.right - width : rect.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, viewportW - width - margin));
  let top = rect.bottom + gap;
  if (top + height + margin > viewportH && rect.top - gap - height >= margin) {
    top = rect.top - gap - height;
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

/**
 * Attach a hover card to `anchor`. `buildContent()` runs at each show (so it's current)
 * and returns the card's content, or null for no card this time.
 * -> cleanup (removes the listeners and the card).
 */
export function attachHoverCard(anchor, buildContent, { className = "", align = "left", delay = SHOW_DELAY_MS } = {}) {
  if (!anchor) return () => {};
  let card = null;
  let showTimer = 0;
  let hideTimer = 0;

  const inside = (target) => target instanceof Node && (anchor.contains(target) || card?.contains(target));

  const hide = () => {
    clearTimeout(showTimer);
    clearTimeout(hideTimer);
    showTimer = hideTimer = 0;
    document.removeEventListener("pointermove", onDocMove, true);
    document.removeEventListener("pointerdown", onDocDown, true);
    document.removeEventListener("keydown", hide, true);
    window.removeEventListener("scroll", onScroll, true);
    card?.remove();
    card = null;
  };
  // One check while open covers fast exits, the anchor re-rendering away and canvas moves.
  const onDocMove = (event) => {
    if (!anchor.isConnected) return hide();
    if (inside(event.target)) {
      clearTimeout(hideTimer);
      hideTimer = 0;
    } else if (!hideTimer) {
      hideTimer = window.setTimeout(hide, LEAVE_GRACE_MS);
    }
  };
  const onDocDown = (event) => { if (!card?.contains(event.target)) hide(); };
  const onScroll = (event) => { if (!card?.contains(event.target)) hide(); };

  const show = () => {
    showTimer = 0;
    if (!anchor.isConnected) return;
    const content = buildContent();
    if (!content) return;
    card = document.createElement("div");
    card.className = ["krc-hover-card", "krc-floating-menu", className].filter(Boolean).join(" ");
    card.append(content);
    document.body.append(card);
    syncFloatingTheme(anchor, card);
    placeFloating(anchor, card, { align });
    document.addEventListener("pointermove", onDocMove, true);
    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", hide, true);
    window.addEventListener("scroll", onScroll, true);
  };

  const onEnter = (event) => {
    if (event.pointerType === "touch" || card || showTimer) return;
    showTimer = window.setTimeout(show, delay);
  };
  const onLeave = () => {
    if (!card) {
      clearTimeout(showTimer);
      showTimer = 0;
    }
  };
  anchor.addEventListener("pointerenter", onEnter);
  anchor.addEventListener("pointerleave", onLeave);
  return () => {
    hide();
    anchor.removeEventListener("pointerenter", onEnter);
    anchor.removeEventListener("pointerleave", onLeave);
  };
}
