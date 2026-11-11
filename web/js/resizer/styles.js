import { ensureSharedStylesheets, ensureStylesheet, installCanvasDragSelectionGuard } from "./krc.js";

const STYLE_VERSION = "1.0.36-shared-1677";

export function injectStyles() {
    installCanvasDragSelectionGuard();
    // NodePack's shared sheets first (from wherever NodePack is installed), then ours.
    const shared = ensureSharedStylesheets();
    const own = ensureStylesheet("krc-resizer-style", "../krc_resizer.css", import.meta.url, { version: STYLE_VERSION, ready: true });
    return Promise.all([shared, own]).then(([, link]) => link);
}
