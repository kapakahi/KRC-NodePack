import { app } from "../../scripts/app.js";
import { openLibraryModal } from "./shared/library_modal.js";
import { ensureStylesheet, SHARED_STYLE_VERSION } from "./shared/stylesheets.js";

// Adds a global "KRC Portal" entry to the canvas (empty-background) right-click
// menu, so the shared library portal can be opened from anywhere without a KRC
// node in the graph. Same behavior as the BROWSE button in the LoRA Loadout mini
// panel and the Config Switcher node (Config Switcher's, specifically: the model
// library at all types) — there is no node context here to narrow the scope.
//
// Surface is the background menu ONLY (getCanvasMenuOptions); node context menus
// are intentionally left untouched.
app.registerExtension({
  name: "KRC.BrowserMenu",
  setup() {
    // Patch via the live canvas instance's constructor so we bind to whichever
    // LGraphCanvas the frontend actually uses (classic or Vue @comfyorg/litegraph),
    // rather than relying on a global name.
    const LGraphCanvas = app?.canvas?.constructor || globalThis.LGraphCanvas;
    const proto = LGraphCanvas?.prototype;
    if (!proto || proto._krcBrowserMenuPatched) return;
    proto._krcBrowserMenuPatched = true;

    // The green BROWSE pill (Config Switcher's .krc-browse-button) is a ::before on
    // the row, keyed by the option's className (krc_browser_menu.css). Some setups
    // sanitize menu labels and strip inline styles, so the label stays plain text;
    // if className is ever dropped, the row still reads "KRC Portal".
    ensureStylesheet("krc-browser-menu", "./krc_browser_menu.css", import.meta.url, { version: SHARED_STYLE_VERSION });

    const original = proto.getCanvasMenuOptions;
    proto.getCanvasMenuOptions = function (...args) {
      const options = original ? original.apply(this, args) : [];
      options.push(null); // separator
      options.push({
        content: "KRC Portal",
        className: "krc-portal-menu-entry",
        // As the toolbar BROWSE: the last view, whatever tab (else Models, all types).
        callback: () => openLibraryModal({ provider: "models", scope: "all", resume: { tabs: "any" } }),
      });
      return options;
    };
  },
});
