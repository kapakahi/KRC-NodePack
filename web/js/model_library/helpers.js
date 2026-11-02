export { stopCanvasEvents } from "../shared/dom.js";
import {
  bindNodeShellSizeClamp,
  markDirty,
  findWidget,
  createDomHeightController,
  makeWidgetAccessors,
  promoteDomWidget,
  restoreDomWidgetLayout,
  forceNodeSize,
  suspendDomWidgetLayout,
} from "../shared/widgets.js";
import { applyNodeCanvasColors } from "../shared/node_palette.js";
import { makeNodeSizing } from "../shared/node_limits.js";
import { ensureStylesheet as ensureSharedStylesheet } from "../shared/stylesheets.js";
import { HIDDEN_WIDGETS, MAX_NODE_HEIGHT, MAX_NODE_WIDTH, MINI_NODE_SIZE, MIN_NODE_SIZE } from "./constants.js";

const STYLE_VERSION = "1.4.5-ui117-shared-1671";

export function ensureStylesheet() {
  return ensureSharedStylesheet("krc-model-library-clone-css", "../krc_model_library.css", import.meta.url, { version: STYLE_VERSION, ready: true });
}

export {
  createDomHeightController,
  bindNodeShellSizeClamp,
  markDirty,
  findWidget,
  forceNodeSize,
  promoteDomWidget,
  restoreDomWidgetLayout,
  suspendDomWidgetLayout,
};

export const { ensureWidget, widgetValue, setWidgetValue } = makeWidgetAccessors(HIDDEN_WIDGETS);

export const { minimumNodeSize, applyMinimumNodeSize, installResizeClamp } = makeNodeSizing({
  minSize: MIN_NODE_SIZE,
  miniSize: MINI_NODE_SIZE,
  maxWidth: MAX_NODE_WIDTH,
  maxHeight: MAX_NODE_HEIGHT,
});

export function applyNodeTheme(node) {
  applyNodeCanvasColors(node); // fixed dark node chrome
}
