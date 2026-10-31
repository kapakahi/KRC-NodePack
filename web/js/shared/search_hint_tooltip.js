/*
 * KRC search-hint tooltip — a themed, hover-driven tooltip that documents the
 * key:value search DSL (shared/search.js) for the LoRA Loadout / Model Library /
 * Prompt Vault browser search boxes.
 *
 * Why a custom tooltip rather than the native `title` attribute: native tooltips
 * appear only after a ~1s OS delay, ignore the node's palette, and get clipped by
 * the ComfyUI canvas layer. This one is body-portaled (so it escapes the canvas
 * clip), theme-synced to the anchor's node palette (same trick as floating_menu),
 * appears near-instantly on hover, and lays the prefixes out in a real two-column
 * grid.
 *
 * It gets out of the way while you actually type: it shows on mouse hover only
 * (never on focus) and hides the moment the field is focused or edited.
 */
import { floatingPaletteId } from "./node_palette.js";

const SHOW_DELAY_MS = 2000;

function syncTheme(anchor, tip) {
  const id = floatingPaletteId(anchor.closest("[data-krc-theme]")?.dataset?.krcTheme || "");
  if (id) tip.dataset.krcTheme = id;
  else delete tip.dataset.krcTheme;
}

function position(anchor, tip) {
  const margin = 8;
  const gap = 6;
  const rect = anchor.getBoundingClientRect();
  const width = tip.offsetWidth || 0;
  const height = tip.offsetHeight || 0;
  const viewportW = window.innerWidth || document.documentElement.clientWidth || 0;
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;

  let left = rect.left;
  left = Math.min(Math.max(margin, left), Math.max(margin, viewportW - width - margin));

  // Prefer below the field; flip above when there isn't room.
  let top = rect.bottom + gap;
  if (top + height + margin > viewportH && rect.top - gap - height >= margin) {
    top = rect.top - gap - height;
  }
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
}

/**
 * Attach a hover hint tooltip to `anchor`.
 * @param {HTMLElement} anchor        element that triggers + anchors the tooltip (the search wrap)
 * @param {() => Node} buildContent   builds the tooltip's inner DOM (called once, lazily)
 * @param {{ focusEl?: HTMLElement }} opts  element whose focus/input hides the tip (default: anchor)
 * @returns {() => void} cleanup that removes listeners and the tooltip
 */
export function attachHintTooltip(anchor, buildContent, { focusEl = anchor } = {}) {
  if (!anchor) return () => {};
  let tip = null;
  let showTimer = 0;
  let focused = false;

  const build = () => {
    if (tip) return tip;
    tip = document.createElement("div");
    tip.className = "krc-search-hint krc-floating-menu";
    tip.append(buildContent());
    return tip;
  };

  // Catch-all dismissal: a plain mouseleave can be missed (fast exits, the anchor
  // re-rendering under the cursor, canvas repaints), which left the tip stuck with
  // no way to close. While visible, ANY pointerdown anywhere and any key dismisses
  // it — clicking the field also focuses it, clicking elsewhere just closes it.
  const onDocPointerDown = () => hide();
  const onKeyDown = () => hide();

  const hide = () => {
    clearTimeout(showTimer);
    showTimer = 0;
    document.removeEventListener("pointerdown", onDocPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (tip && tip.isConnected) tip.remove();
  };

  const show = () => {
    if (focused) return;
    const el = build();
    if (!el.isConnected) document.body.append(el);
    syncTheme(anchor, el);
    // Measure after it's in the DOM, then place it.
    position(anchor, el);
    document.addEventListener("pointerdown", onDocPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
  };

  const onEnter = () => {
    if (focused) return;
    clearTimeout(showTimer);
    showTimer = window.setTimeout(show, SHOW_DELAY_MS);
  };
  const onLeave = () => hide();
  const onFocus = () => { focused = true; hide(); };
  const onBlur = () => { focused = false; };
  const onScroll = () => hide();

  anchor.addEventListener("mouseenter", onEnter);
  anchor.addEventListener("mouseleave", onLeave);
  focusEl.addEventListener("focusin", onFocus);
  focusEl.addEventListener("focusout", onBlur);
  focusEl.addEventListener("input", hide);
  // Any scroll/zoom shifts the anchor; dismiss rather than track.
  window.addEventListener("scroll", onScroll, true);

  return () => {
    hide();
    anchor.removeEventListener("mouseenter", onEnter);
    anchor.removeEventListener("mouseleave", onLeave);
    focusEl.removeEventListener("focusin", onFocus);
    focusEl.removeEventListener("focusout", onBlur);
    focusEl.removeEventListener("input", hide);
    window.removeEventListener("scroll", onScroll, true);
  };
}

// ── Hint content ─────────────────────────────────────────────────────────────
// Data-driven so the two lineages stay in sync with the real alias tables
// (lora_loadout / model_library constants SEARCH_FIELD_ALIASES; prompt_vault ALIASES).

function buildHint({ intro, rows, foot }) {
  const root = document.createElement("div");

  const title = document.createElement("div");
  title.className = "krc-search-hint-title";
  title.textContent = "Search tips";
  root.append(title);

  const introEl = document.createElement("div");
  introEl.className = "krc-search-hint-intro";
  introEl.textContent = intro;
  root.append(introEl);

  const grid = document.createElement("div");
  grid.className = "krc-search-hint-grid";
  for (const [key, desc] of rows) {
    const k = document.createElement("span");
    k.className = "krc-search-hint-key";
    k.textContent = key;
    const d = document.createElement("span");
    d.className = "krc-search-hint-desc";
    d.textContent = desc;
    grid.append(k, d);
  }
  root.append(grid);

  const footEl = document.createElement("div");
  footEl.className = "krc-search-hint-foot";
  footEl.textContent = foot;
  root.append(footEl);

  return root;
}

const AND_FOOT = "Every term must match (AND); partial and any case. Use \"quotes\" for a phrase:";

// LoRA Loadout + Model Library share one alias table, so one hint serves both.
export function buildModelSearchHint() {
  return buildHint({
    intro: "Type words to match the name, or add a prefix to target a field:",
    rows: [
      ["model:", "base model"],
      ["creator: author:", "author"],
      ["category: cat:", "category"],
      ["folder:", "folder"],
      ["file:", "filename"],
      ["title: name:", "display name"],
      ["tag:", "tags"],
      ["trained: word:", "trigger words"],
      ["badge:", "custom badge"],
      ["version: ver:", "version"],
      ["has: missing:", "thumb, animated, badge, favorite, metadata, file"],
      ["civitai:none", "checked, not on Civitai"],
    ],
    foot: `${AND_FOOT} title:"night city"`,
  });
}

export function buildPromptSearchHint() {
  return buildHint({
    intro: "Type words to match name, category, type, LL preset or kit presets, or add a prefix:",
    rows: [
      ["prompt:", "Prompt A and B text"],
      ["category: cat:", "category"],
      ["title: name:", "name"],
      ["type:", "type (model)"],
      ["preset:", "LL preset"],
      ["badge:", "custom badge"],
      ["has:thumb", "has a thumbnail (missing:thumb, none)"],
    ],
    foot: `${AND_FOOT} prompt:"golden hour"`,
  });
}
