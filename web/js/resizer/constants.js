export const NODE_CLASS = "KRC Resizer";
export const API_PREFIX = "/krc/resizer";   // the node's own routes (nodes/krc_resizer.py)
export const PREVIEW_SIZE = 350;  // square preview foundation
export const CONTROL_W = 270;
export const FIXED_DOM_W = PREVIEW_SIZE + CONTROL_W + 10;
export const FIXED_DOM_H = 430;
export const NODE_FRAME_W = 21;
export const FIXED_NODE_W = FIXED_DOM_W + NODE_FRAME_W - 2;
// The classic node height: NodePack's classicNodeHeight (node_shell.js resizerSizeBounds).
export const MARGIN = 22;    // canvas margin around source frame (px)
export const GRID = 16;      // quantisation grid (source px)
export const MIN_SOURCE_OVERLAP = 1;   // minimum source/crop intersection (source px)
export const DEFAULT_FPS = 24;


// Default footprints for the two ComfyUI renderers; all resizing uses these bounds.
export const NODE2_CHROME_W = 24;
export const NODE2_CHROME_H = 132;
export const MAX_SIZE_FACTOR = 3;
