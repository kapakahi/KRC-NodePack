import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { applyLibraryUsage } from "./model_library/panel_data.js";
import { LIBRARY_USAGE_EVENT } from "./shared/library_usage.js";
import { hiddenWidgetDefaults, MAX_NODE_SIZE, MIN_NODE_SIZE } from "./model_library/constants.js";
import { attachPanel } from "./model_library/node_attach.js";
import { applyNodeTheme, ensureWidget, markDirty } from "./model_library/helpers.js";
import { newNodeShowsNsfw } from "./shared/global_settings.js";
import { PORTAL_HOME_ID, registerLibraryProvider } from "./shared/library_modal.js";
import { createModelProvider } from "./model_library/modal_provider.js";
import { createHomeProvider } from "./model_library/home_provider.js";

// Live use counts from the per-run counter (utils/library/run_usage.py).
api.addEventListener(LIBRARY_USAGE_EVENT, (event) => {
  if (["models", "loras"].includes(event?.detail?.kind)) applyLibraryUsage(event.detail.usage);
});

// Register the shared library modal's "models" provider at load (independent of
// whether a Model Library node exists in the graph), so any opener — LL mini's
// Browse, later Config Switcher / a toolbar button — can summon it.
registerLibraryProvider({ id: "models", label: "Models", order: 0, create: createModelProvider });
// The Portal's Home (the header's house button, no tab): the KRC menu cards + the Home page.
registerLibraryProvider({ id: PORTAL_HOME_ID, label: "Home", order: -1, hidden: true, create: createHomeProvider });

const STALE_FULL_HEIGHT_THRESHOLD = Math.round(MIN_NODE_SIZE[1] * 1.55);
const USER_HEIGHT_PROPERTY = "mlNodeHeight";

function normalizeConfiguredSize(node, surface, { hasSavedSize = false } = {}) {
  if (surface === "mini") return;
  const currentHeight = Number(node.size?.[1]);
  const userHeight = Number(node.properties?.[USER_HEIGHT_PROPERTY]);
  const hasExplicitUserHeight = Number.isFinite(userHeight) && Math.abs(userHeight - currentHeight) <= 2;
  if (hasSavedSize && hasExplicitUserHeight) return;
  if (!Number.isFinite(currentHeight)) return;
  if (!hasSavedSize && currentHeight <= STALE_FULL_HEIGHT_THRESHOLD) return;
  const width = Math.min(Math.max(node.size?.[0] || MIN_NODE_SIZE[0], MIN_NODE_SIZE[0]), MAX_NODE_SIZE[0]);
  node.size = [width, MIN_NODE_SIZE[1]];
  node.setSize?.(node.size);
  node.__krcLoraDomHeightController?.stamp?.(node.size[1]);
  markDirty(node);
}

app.registerExtension({
  name: "KRC.ModelLibrary",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    const isModelLibrary = nodeData.name === "KRC Model Library";
    if (!isModelLibrary) {
      return;
    }
    const surface = "full";

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      onNodeCreated?.apply(this, arguments);
      // Graph restores call onConfigure synchronously right after this, so a
      // microtask lands after it: if no configure came, this is a fresh drop
      // and the boot gate can proceed immediately instead of waiting for it.
      queueMicrotask(() => { this.__krcLoraCreateSettled = true; });
      // A new node's NSFW eye starts at the global default; a restore overwrites it.
      ensureWidget(this, "show_nsfw", false).value = newNodeShowsNsfw();
      attachPanel(this, { surface });
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const result = onConfigure?.apply(this, arguments);
      this.__krcLoraConfigured = true;
      applyNodeTheme(this);
      Object.entries(hiddenWidgetDefaults(surface)).forEach(([name, value]) => ensureWidget(this, name, value));
      const restoredSize = Array.isArray(info?.size) ? info.size : (Array.isArray(this.size) ? this.size : MIN_NODE_SIZE);
      normalizeConfiguredSize(this, surface, { hasSavedSize: Array.isArray(info?.size) });
      if (surface !== "mini") {
        if (this.__krcLoraRestoreDomHeight) {
          this.__krcLoraRestoreDomHeight(restoredSize);
          requestAnimationFrame(() => {
            if (!this.__krcLoraPanel?.root?.isConnected) return;
            this.__krcLoraRestoreDomHeight?.(restoredSize);
            this.__krcLoraPanel?.scheduleBrowserViewportUpdateAfterResize?.();
          });
        } else {
          this.__krcLoraPendingRestoreSize = restoredSize;
        }
      }
      this.__krcLoraPanel?.rehydrateFromNode();
      return result;
    };
  },
});
