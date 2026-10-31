/*
 * KRC palette registry — the single list of available color palettes.
 *
 * Shared by the global theme setting (krc_theme.js, applied to :root) and the
 * per-node palette switcher (shared/node_palette.js, applied to a node's .krc-node
 * root). Each palette's colors live in CSS: the default in
 * shared/design_tokens.css, alternates in shared/themes.css, each scoped by
 * [data-krc-theme="<id>"].
 *
 * To add a palette: define its block in themes.css, then add an { id, label }
 * entry here — both the global setting and every per-node switcher pick it up.
 */

// id "default" is the base purple palette (design_tokens.css). Selecting it
// globally means "no attribute on :root"; selecting it per-node explicitly
// forces the default palette on that node even under a themed :root.
export const DEFAULT_ID = "default";

// Palette a fresh install / new user starts on (the global setting's default).
// Distinct from DEFAULT_ID above, which is the attribute-less base purple palette.
export const DEFAULT_PALETTE_ID = "gray";

// Display order for the theme setting + per-node switcher (presentational only;
// the fresh-install default is DEFAULT_PALETTE_ID, not the first entry). Blue is
// first display choice; Native (passthrough) sorts last.
export const PALETTES = [
  { id: "blue", label: "KRC Blue" },
  { id: "default", label: "KRC Purple" },
  { id: "red", label: "KRC Red" },
  { id: "yellow", label: "KRC Yellow" },
  { id: "gray", label: "KRC Gray" },
  { id: "dark", label: "KRC Dark" },
  { id: "high-contrast", label: "KRC High Contrast" },
  { id: "native", label: "Native" },
];

// "native" makes the KRC DOM translucent so the node's own ComfyUI/LiteGraph
// color shows through, and (via node_palette.js) leaves the canvas chrome to
// LiteGraph/the user instead of forcing the fixed dark.
export const NATIVE_ID = "native";

// The KRC Portal floats over the page with no node colour behind it, so it never uses
// Native: its palette list leaves Native out, and following a Native global palette
// gives it this one.
export const PORTAL_NATIVE_FALLBACK_ID = "gray";

// The Portal palette choices: follow the global palette ("") or any palette but Native.
export function portalPaletteOptions() {
  return [["", "Global (default)"], ...PALETTES.filter((palette) => palette.id !== NATIVE_ID).map((palette) => [palette.id, palette.label])];
}

// The palette the Portal actually uses for a stored choice: the choice itself, else the
// global palette (unstamped), except Native, which becomes Gray.
export function portalPaletteId(choice = "") {
  const id = choice === NATIVE_ID ? "" : String(choice || "");
  if (id) return id;
  return _globalPaletteId === NATIVE_ID ? PORTAL_NATIVE_FALLBACK_ID : "";
}

// The active GLOBAL palette id, mirrored here (set by krc_theme.js) so the
// per-node canvas logic can compute a node's effective palette without reaching
// into the ComfyUI settings API.
let _globalPaletteId = DEFAULT_ID;
export function getGlobalPalette() {
  return _globalPaletteId;
}
export function setGlobalPalette(id) {
  _globalPaletteId = id || DEFAULT_ID;
}
