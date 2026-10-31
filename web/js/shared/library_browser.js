import { KRC_BROWSER_LIST_GAP } from "./node_limits.js";
import { browserVirtualTotalHeight } from "./browser_virtualization.js";
import { scheduleFrame } from "./dom.js";
import { attachHintTooltip } from "./search_hint_tooltip.js";
import {
  browserSearchControl,
  browserViewToggle,
  cardColorFilterButton,
  favoriteFilterButton,
  menuSelect,
  nsfwFilterButton,
  refreshButton,
} from "./browser_controls.js";

// Hard ceiling on the viewport height used to size a virtual render pass. The list is
// height-constrained (overflow scroll), so clientHeight is normally the small visible
// area. But mid-re-render — e.g. right after a Civitai fetch swaps the panel, before
// overflow/height is reapplied — clientHeight can momentarily read as the FULL content
// height; without this cap, updateVirtualList would try to build a row for every item in
// one synchronous pass (thousands of cards, some with <video>), freezing the tab. The
// nodes' real max height is ~1771px, so this ceiling never under-renders a legitimate
// viewport — it only defuses the transient blow-up.
const MAX_VIRTUAL_VIEWPORT_PX = 4000;

function scrollbarNudgePx(list) {
  const value = getComputedStyle(list).getPropertyValue("--krc-browser-scrollbar-nudge");
  const nudge = Number.parseFloat(value);
  return Number.isFinite(nudge) && nudge > 0 ? nudge : 0;
}

// ── Layer 2 (partial): the shared virtualized card list ──────────────────────
// The perf-critical windowing core, byte-for-byte identical across LoRA Loadout,
// Model Library and Prompt Vault. It owns NO node state; a `listSource` seam supplies
// everything node-specific:
//   view()          -> current view id (grid | thumb | list) — for metrics + list class
//   listClass()     -> the list element's class for the current view
//   visibleItems()  -> the LIVE filtered+sorted rows, re-read on EVERY update so an
//                      in-place edit that invalidates the node's filter memo shows up
//                      without the old per-card snapshot swap (the badge-flicker fix,
//                      now universal)
//   metrics(view)   -> { rowHeight, columns, bufferRows } (from browserVirtualMetrics)
//   keyOf(item)     -> identity string, for scroll-into-view
//   cardFor(item)   -> the cached card node (the node signature-hashes it)
//   renderEmpty()   -> the empty-state node when there are no rows
//
// OPTIONAL section headers (opt-in — nothing declares these keeps the flat fast path):
//   grouped()            -> true to render section headers between uniform card rows
//   groupOf(item)        -> the group key for an item (consecutive items with the same key
//                           form one cluster; visibleItems() must already be sorted so a group's
//                           items are contiguous)
//   renderGroupHeader(k) -> a full-width header element for group key k (the list adds
//                           .krc-virtual-section-header and positions it absolutely)
//
// Selection is part of each card's cache signature (LL/ML's proven, Safari-smooth
// model), so a selection change rebuilds that one card via cardFor — the list core
// stays selection-agnostic.
// Keyboard navigation for the card list. Opt-in: a source that supplies
// `selectedKey()` (current selection identity) and `selectItem(item)` (select
// without moving DOM focus or self-scrolling) gets arrow-key traversal. Up/Down
// move by a full row (= ±1 in the single-column list/thumb views, a true cycle;
// a vertical step in grid); Left/Right step ±1 for grid completeness. Selection
// stays reachable without a mouse; the list core does the scroll-into-view.
// Installed once per list element (guarded), on the scroll container itself so a
// keydown on any focused descendant card/button still bubbles here.
function installListKeyboardNav(list, source) {
  if (list._krcKeyNavInstalled || !source.selectedKey || !source.selectItem) return;
  list._krcKeyNavInstalled = true;
  // Focusable scroll container (no focus box — the selected card shows the state).
  if (!(list.tabIndex >= 0)) list.tabIndex = 0;
  list.style.outline = "none";
  // Clicking a card hands the list keyboard focus so the arrows work immediately,
  // without a separate Tab. Skip clicks on interactive controls (pin/color/menu
  // buttons and their popovers) so we don't yank focus mid-interaction.
  list.addEventListener("click", (event) => {
    const t = event.target;
    if (t instanceof Element && t.closest("button, input, select, textarea, [contenteditable], [role='menu'], .krc-floating-menu")) return;
    if (document.activeElement !== list && !list.contains(document.activeElement)) list.focus();
  });
  list.addEventListener("keydown", (event) => {
    const columns = Math.max(1, source.metrics(source.view()).columns || 1);
    let delta = 0;
    switch (event.key) {
      case "ArrowDown": delta = columns; break;
      case "ArrowUp": delta = -columns; break;
      case "ArrowRight": delta = 1; break;
      case "ArrowLeft": delta = -1; break;
      default: return;
    }
    const rows = source.visibleItems();
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();   // keep ComfyUI's canvas handlers out of it
    const curKey = source.selectedKey();
    const idx = curKey ? rows.findIndex((item) => source.keyOf(item) === curKey) : -1;
    const next = idx < 0
      ? (delta > 0 ? 0 : rows.length - 1)   // no selection: enter from the matching end
      : Math.min(rows.length - 1, Math.max(0, idx + delta));
    if (next === idx) return;
    const item = rows[next];
    source.selectItem(item);
    scrollVirtualListIntoView(list, source, source.keyOf(item));
  });
}

export function mountVirtualList(list, source) {
  list.className = `${source.listClass()} is-virtualized`;
  installListKeyboardNav(list, source);
  for (const child of list.children) suspendCardMedia(child);
  list.innerHTML = "";
  list._krcVirtual = {
    view: source.view(),
    scrollVersion: (list._krcVirtual?.scrollVersion || 0) + 1,
  };
  if (!source.visibleItems().length) {
    list.classList.remove("is-virtualized");
    list.append(source.renderEmpty());
    return;
  }
  const spacer = document.createElement("div");
  spacer.className = "krc-lora-virtual-spacer";
  list.append(spacer);
  if (!list._krcVirtualScrollInstalled) {
    list._krcVirtualScrollInstalled = true;
    list.addEventListener("scroll", () => {
      scheduleFrame(list, "_krcVirtualFrame", () => updateVirtualList(list, source));
    }, { passive: true });
  }
  updateVirtualList(list, source);
}

// Height of a section header row + the extra gap between clusters, used only by the OPT-IN
// grouped path (a source that declares grouped()/groupOf()/renderGroupHeader()).
const SECTION_HEADER_HEIGHT = 22;

// Avoid repeated writes when the window and dimensions are unchanged.
function setStyle(node, name, value) {
  if (node.style[name] !== value) node.style[name] = value;
}

// Flat and grouped paths share the existing positioning and scrollbar-nudge math.
function positionCard(card, top, column, metrics, ctx) {
  setStyle(card, "top", `${top}px`);
  setStyle(card, "height", `${metrics.rowHeight}px`);
  if (metrics.columns === 1) {
    setStyle(card, "left", "0px");
    setStyle(card, "width", ctx.nudge ? `calc(100% - ${ctx.nudgePx})` : "100%");
  } else {
    setStyle(card, "left", column === 0 ? "0px"
      : (ctx.nudge ? `calc((100% - ${ctx.nudgePx} + ${ctx.listGapPx}) / 2)` : `calc((100% + ${ctx.listGapPx}) / 2)`));
    setStyle(card, "width", ctx.nudge
      ? `calc((100% - ${ctx.nudgePx} - ${ctx.listGapPx}) / 2)`
      : `calc((100% - ${ctx.listGapPx}) / 2)`);
  }
}

function suspendCardMedia(root) {
  for (const video of root.querySelectorAll("video")) {
    if (video._krcSuspendThumbnail) video._krcSuspendThumbnail();
    else video.pause();
  }
}

// Keep overlapping cards attached: removing/reinserting the whole window interrupts
// focus and media even when cardFor returns the same cached elements.
function reconcileCards(spacer, children) {
  const wanted = new Set(children);
  for (const child of Array.from(spacer.children)) {
    if (!wanted.has(child)) { suspendCardMedia(child); child.remove(); }
  }
  let cursor = spacer.firstChild;
  for (const child of children) {
    if (child === cursor) { cursor = cursor.nextSibling; continue; }
    const entering = child.parentNode !== spacer;
    spacer.insertBefore(child, cursor);
    if (entering) {
      for (const video of child.querySelectorAll("video")) video._krcResumeThumbnail?.();
    }
  }
}

// Precompute the sectioned layout for a grouped list: consecutive items are bucketed by
// source.groupOf(); each group is a full-width header row, then its cards laid out `columns` wide
// starting a fresh row. Returns absolutely-positioned entries + the total scroll height. The
// caller renders only the visible window, same as the flat path.
function computeSectionLayout(rows, metrics, source) {
  const rowStride = metrics.rowHeight + KRC_BROWSER_LIST_GAP;
  const entries = [];
  let top = 0;
  let group = null;
  const closeGroup = () => {
    if (!group) return;
    top += Math.ceil(group.count / metrics.columns) * rowStride; // advance past the group's rows
  };
  for (const item of rows) {
    const key = String(source.groupOf(item) ?? "");
    if (!group || group.key !== key) {
      closeGroup();
      if (group) top += KRC_BROWSER_LIST_GAP; // extra breathing room between clusters
      entries.push({ kind: "header", key, top, height: SECTION_HEADER_HEIGHT });
      top += SECTION_HEADER_HEIGHT + KRC_BROWSER_LIST_GAP;
      group = { key, base: top, count: 0 };
    }
    const column = group.count % metrics.columns;
    const rowInGroup = Math.floor(group.count / metrics.columns);
    entries.push({ kind: "card", item, key: source.keyOf(item), top: group.base + rowInGroup * rowStride, column, height: metrics.rowHeight });
    group.count += 1;
  }
  closeGroup();
  return { entries, totalHeight: Math.max(0, top - KRC_BROWSER_LIST_GAP) };
}

export function updateVirtualList(list, source) {
  const state = list?._krcVirtual;
  const spacer = list?.querySelector?.(".krc-lora-virtual-spacer");
  if (!state || !spacer) return;

  const rows = source.visibleItems();
  state.rows = rows;
  const metrics = source.metrics(state.view);
  const rowStride = metrics.rowHeight + KRC_BROWSER_LIST_GAP;
  const viewportHeight = Math.min(list.clientHeight || 1, MAX_VIRTUAL_VIEWPORT_PX);
  const nudge = scrollbarNudgePx(list);
  const ctx = { nudge, nudgePx: `${nudge}px`, listGapPx: `${KRC_BROWSER_LIST_GAP}px` };

  // ── Grouped path (opt-in) ──────────────────────────────────────────────────
  // A source that declares grouped()/groupOf()/renderGroupHeader() gets section headers between
  // uniform card rows. Reuses the same card positioning as the flat path, so cards are identical
  // to the folder browser; only headers are extra. Nothing else in the pack opts in, so the flat
  // path below remains independent of section layout.
  if (source.grouped?.() && typeof source.groupOf === "function") {
    // Only cache sources with an explicit internal invalidation token. Other public
    // API consumers may mutate their arrays in place, so retain their live behavior.
    const token = source._krcSectionLayoutToken?.();
    const signature = `${metrics.rowHeight}:${metrics.columns}`;
    let layout = state.sectionLayout;
    if (token === undefined || !layout || layout.rows !== rows || layout.length !== rows.length
        || layout.token !== token || layout.signature !== signature || layout.groupOf !== source.groupOf
        || layout.keyOf !== source.keyOf) {
      layout = { ...computeSectionLayout(rows, metrics, source), rows, length: rows.length,
        token, signature, groupOf: source.groupOf, keyOf: source.keyOf };
      state.sectionLayout = layout;
    }
    const { entries, totalHeight } = layout;
    state.layout = entries;
    setStyle(spacer, "height", `${totalHeight}px`);
    const buffer = metrics.bufferRows * rowStride;
    const viewTop = list.scrollTop - buffer;
    const viewBottom = list.scrollTop + viewportHeight + buffer;
    const children = [];
    const headers = new Map();
    // Entries are ordered by top and bottom (including same-row grid cards).
    let lo = 0, hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (entries[mid].top + entries[mid].height < viewTop) lo = mid + 1;
      else hi = mid;
    }
    for (let index = lo; index < entries.length && entries[index].top <= viewBottom; index++) {
      const entry = entries[index];
      if (entry.kind === "header") {
        const header = state.sectionHeaders?.get(entry) || source.renderGroupHeader(entry.key);
        headers.set(entry, header);
        if (!header.classList.contains("krc-virtual-section-header")) header.classList.add("krc-virtual-section-header");
        setStyle(header, "top", `${entry.top}px`);
        setStyle(header, "height", `${entry.height}px`);
        children.push(header);
      } else {
        const card = source.cardFor(entry.item);
        positionCard(card, entry.top, entry.column, metrics, ctx);
        children.push(card);
      }
    }
    state.sectionHeaders = headers;
    reconcileCards(spacer, children);
    return;
  }

  // ── Flat path ──────────────────────────────────────────────────
  state.layout = null;
  state.sectionLayout = null;
  state.sectionHeaders = null;
  const totalHeight = browserVirtualTotalHeight(rows.length, metrics);
  setStyle(spacer, "height", `${totalHeight}px`);

  const firstRow = Math.max(0, Math.floor(list.scrollTop / rowStride) - metrics.bufferRows);
  const visibleRows = Math.ceil(viewportHeight / rowStride) + (metrics.bufferRows * 2) + 1;
  const rowCount = Math.ceil(rows.length / metrics.columns);
  const lastRow = Math.min(rowCount - 1, firstRow + visibleRows);
  const firstIndex = firstRow * metrics.columns;
  const lastIndex = Math.min(rows.length - 1, ((lastRow + 1) * metrics.columns) - 1);
  const children = [];

  for (let index = firstIndex; index <= lastIndex; index++) {
    const item = rows[index];
    if (!item) continue;
    const card = source.cardFor(item);
    positionCard(card, Math.floor(index / metrics.columns) * rowStride, index % metrics.columns, metrics, ctx);
    children.push(card);
  }
  reconcileCards(spacer, children);
}

export function scrollVirtualListIntoView(list, source, key) {
  const state = list?._krcVirtual;
  // No virtual state = the list isn't virtual-mounted yet (or at all); virtual-row
  // scroll math wouldn't match real card positions, so bail and let the caller fall
  // back to DOM-based scrollNearest.
  if (!state) return false;
  const rows = state.rows || source.visibleItems();
  if (!rows?.length || key == null || key === "") return false;
  const metrics = source.metrics(state.view);

  // Grouped list: the card's Y comes from the precomputed sectioned layout, not row-index math.
  let rowTop;
  if (state.layout) {
    const entry = state.layout.find((e) => e.kind === "card" && e.key === key);
    if (!entry) return false;
    rowTop = entry.top;
  } else {
    const index = rows.findIndex((item) => source.keyOf(item) === key);
    if (index < 0) return false;
    rowTop = Math.floor(index / metrics.columns) * (metrics.rowHeight + KRC_BROWSER_LIST_GAP);
  }
  const rowBottom = rowTop + metrics.rowHeight;
  if (rowTop < list.scrollTop) {
    list.scrollTop = rowTop;
  } else if (rowBottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = Math.max(0, rowBottom - list.clientHeight);
  }
  updateVirtualList(list, source);
  return true;
}

// ── Layer 2: the browser SHELL ───────────────────────────────────────────────
// Assembles the whole browser panel — panel > header(title|align-left + control
// strip) > optional body wrapper > [search, ...slots] — from a declarative config.
// The header controls are built from `controls` descriptors over the already-shared
// browser_controls primitives (kind-dispatch); everything genuinely node-specific
// (the group rail / facet chips, the mounted list, the footer) is passed in as a
// pre-built slot node. Reproduces LoRA Loadout's and Prompt Vault's structurally
// different panels from one function: LL uses tag "section", a "Browser" title, the
// "krc-browser-actions" strip and no body wrapper; PV uses "div", no title
// (align-left), "krc-header-controls" and a "krc-browser-body" wrapper.
// `select` descriptors historically carried native-<select> classes
// ("krc-browser-select krc-sort-select"); the DOM menuSelect only wants the
// width marker, so keep krc-sort-select and drop the native base class.
function selectControl({ className = "", ...props }) {
  return menuSelect({ ...props, className: /\bkrc-sort-select\b/.test(className) ? "krc-sort-select" : "" });
}

const CONTROL_BUILDERS = {
  select: selectControl,
  favorite: favoriteFilterButton,
  color: cardColorFilterButton,
  nsfw: nsfwFilterButton,
  refresh: refreshButton,
  view: browserViewToggle,
};

function buildControl({ kind, ...props }) {
  const build = CONTROL_BUILDERS[kind];
  return build ? build(props) : null;
}

export function renderLibraryBrowser({
  tag = "section",
  panelClass,
  title = "",
  headerClass = "krc-panel-header",
  actionsClass = "krc-browser-actions",
  controls = [],
  search,
  bodyClass = "",
  slots = [],
  selectionUI = null,
}) {
  const panel = document.createElement(tag);
  panel.className = panelClass;

  const header = document.createElement("div");
  header.className = title ? headerClass : `${headerClass} align-left`;
  if (title) header.innerHTML = `<span>${title}</span>`;
  const actions = document.createElement("div");
  actions.className = actionsClass;
  for (const control of controls) {
    const node = buildControl(control);
    if (node) actions.append(node);
  }
  header.append(actions);

  const { wrap: searchWrap, search: searchInput } = browserSearchControl(search);
  // A hover hint tooltip documenting the key:value search DSL. `search.hint` is a
  // content-builder (see search_hint_tooltip.js); focus/typing on the input hides it.
  if (search?.hint) attachHintTooltip(searchWrap, search.hint, { focusEl: searchInput });
  const content = [searchWrap, ...slots.filter(Boolean)];

  if (bodyClass) {
    const body = document.createElement("div");
    body.className = bodyClass;
    body.append(...content);
    panel.append(header, body);
  } else {
    panel.append(header, ...content);
  }
  selectionUI?.mount(panel);
  return panel;
}
