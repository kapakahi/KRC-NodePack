import {
  KRC_BROWSER_GRID_CARD_HEIGHT,
  KRC_BROWSER_GRID_COLUMNS,
  KRC_BROWSER_LIST_CARD_HEIGHT,
  KRC_BROWSER_LIST_GAP,
  KRC_BROWSER_VIRTUAL_BUFFER_ROWS,
  KRC_THUMB_LIST_CARD_HEIGHT,
} from "./node_limits.js";

export function browserVirtualMetrics(view, {
  listGap,
  listCardHeight,
  thumbCardHeight,
  gridCardHeight,
  gridColumns,
  bufferRows,
  listExtraBufferRows = 0,
  gridExtraBufferRows = 0,
} = {}) {
  const isGrid = view === "grid";
  return {
    columns: isGrid ? gridColumns : 1,
    rowHeight: isGrid ? gridCardHeight : (view === "list" ? listCardHeight : thumbCardHeight),
    bufferRows: bufferRows + (isGrid ? gridExtraBufferRows : listExtraBufferRows),
    listGap,
  };
}

export function browserVirtualTotalHeight(itemCount, metrics) {
  const rows = Math.ceil(itemCount / metrics.columns);
  return rows ? (rows * metrics.rowHeight) + ((rows - 1) * metrics.listGap) : 0;
}

// The standard KRC card metrics for a view (the sizes every KRC browser uses), for a
// ListSource's metrics(view): what a pack's Portal mode passes (public API 1.14).
export function krcBrowserMetrics(view) {
  return browserVirtualMetrics(view, {
    listGap: KRC_BROWSER_LIST_GAP,
    listCardHeight: KRC_BROWSER_LIST_CARD_HEIGHT,
    thumbCardHeight: KRC_THUMB_LIST_CARD_HEIGHT,
    gridCardHeight: KRC_BROWSER_GRID_CARD_HEIGHT,
    gridColumns: KRC_BROWSER_GRID_COLUMNS,
    bufferRows: KRC_BROWSER_VIRTUAL_BUFFER_ROWS,
  });
}
