// KRC Word Bank — node sizing math derived from the current row count.

import { ROW_H, TOP_CHROME, BOTTOM_CHROME, PAD, FOOTER_GUTTER, MIN_W } from "./constants.js";

const NODE2_CHROME_H = 54;

export function calcHeight(rowCount) {
  return TOP_CHROME + Math.max(rowCount, 0) * ROW_H + BOTTOM_CHROME + PAD + FOOTER_GUTTER;
}

export function calcNodeHeight(rowCount) {
  return calcHeight(rowCount) + NODE2_CHROME_H;
}

export function resizeNode(node, rowCount) {
  node.setSize([Math.max(node.size?.[0] ?? MIN_W, MIN_W), calcNodeHeight(rowCount)]);
}
