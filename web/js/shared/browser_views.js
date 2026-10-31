// Canonical browser-view tokens, shared by every node's view toggle so the list
// and its order can't drift between nodes. "thumb-list" is the canonical name of
// the thumbnail view; "thumb" is kept below only as a legacy-value alias.
export const BROWSER_VIEWS = ["grid", "list", "thumb-list"];
export const DEFAULT_BROWSER_VIEW = "thumb-list";
const BROWSER_VIEW_SET = new Set(BROWSER_VIEWS);

// Coerce a stored/legacy view value to a valid token (legacy "thumb" → default).
export function sanitizeBrowserView(value, fallback = DEFAULT_BROWSER_VIEW) {
  return BROWSER_VIEW_SET.has(value) ? value : fallback;
}

export const BROWSER_VIEW_CLASSES = {
  grid: "is-grid",
  list: "is-list",
  thumb: "is-thumb", // legacy alias for values persisted before the reconcile
  "thumb-list": "is-thumb",
};

export const BROWSER_VIEW_LABELS = {
  grid: "Grid view",
  list: "List view",
  thumb: "Thumbnail list view",
  "thumb-list": "Thumbnail list view",
};

export function browserViewClass(view) {
  return BROWSER_VIEW_CLASSES[view] || BROWSER_VIEW_CLASSES.thumb;
}

export function browserViewTitle(view) {
  return BROWSER_VIEW_LABELS[view] || BROWSER_VIEW_LABELS.thumb;
}

// `listThumbs` (list view only) adds krc-list-thumbs, which un-hides the
// optional tiny left-aligned thumbnail via components.css.
export function browserListClass(view, { listThumbs = false } = {}) {
  return `krc-lora-list ${browserViewClass(view)}${listThumbs ? " krc-list-thumbs" : ""}`;
}

export function browserViewOptions(views) {
  return views.map((view) => ({
    value: view,
    iconClass: browserViewClass(view),
    title: browserViewTitle(view),
  }));
}
