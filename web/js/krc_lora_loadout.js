import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { applyLibraryUsage } from "./lora_loadout/panel_data.js";
import { LIBRARY_USAGE_EVENT } from "./shared/library_usage.js";
import { hiddenWidgetDefaults, MIN_NODE_SIZE } from "./lora_loadout/constants.js";
import { attachPanel } from "./lora_loadout/node_attach.js";
import { applyNodeTheme, ensureWidget, markDirty } from "./lora_loadout/helpers.js";
import { newNodeShowsNsfw } from "./shared/global_settings.js";

// Live use counts from the per-run counter (utils/library/run_usage.py).
api.addEventListener(LIBRARY_USAGE_EVENT, (event) => {
  if (["loras"].includes(event?.detail?.kind)) applyLibraryUsage(event.detail.usage);
});

const STALE_FULL_HEIGHT_THRESHOLD = Math.round(MIN_NODE_SIZE[1] * 1.55);
const USER_HEIGHT_PROPERTY = "llNodeHeight";

function normalizeConfiguredSize(node, surface, { hasSavedSize = false } = {}) {
  if (surface === "mini") return;
  if (hasSavedSize) return;
  const currentHeight = Number(node.size?.[1]);
  if (!Number.isFinite(currentHeight) || currentHeight <= STALE_FULL_HEIGHT_THRESHOLD) return;
  const userHeight = Number(node.properties?.[USER_HEIGHT_PROPERTY]);
  const hasExplicitUserHeight = Number.isFinite(userHeight) && Math.abs(userHeight - currentHeight) <= 2;
  if (hasExplicitUserHeight) return;
  const width = Math.max(node.size?.[0] || MIN_NODE_SIZE[0], MIN_NODE_SIZE[0]);
  node.size = [width, MIN_NODE_SIZE[1]];
  node.setSize?.(node.size);
  node.__krcLoraDomHeightController?.stamp?.(node.size[1]);
  markDirty(node);
}

app.registerExtension({
  name: "KRC.LoraLoadout",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    // "KRC LoRA Loadout" is the compact node (surface "mini"), "KRC LoRA Loadout EX" the one
    // with the built-in browser (surface "full").
    const isLoraLoadoutEx = nodeData.name === "KRC LoRA Loadout EX";
    const isLoraLoadout = nodeData.name === "KRC LoRA Loadout";
    if (!isLoraLoadoutEx && !isLoraLoadout) {
      return;
    }
    const surface = isLoraLoadout ? "mini" : "full";

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

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const result = onExecuted?.apply(this, arguments);
      this.__krcLoraPanel?.applyTriggeredPresetUi(message);
      this.__krcLoraPanel?.applyMissingLoraUi(message);
      this.__krcLoraPanel?.applyPresetLinkUi(message);
      return result;
    };

    // Wiring or unwiring the preset input changes the link indicator.
    const onConnectionsChange = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const result = onConnectionsChange?.apply(this, arguments);
      // Not while a workflow loads: applying then would mark it dirty.
      if (app.configuringGraph) this.__krcLoraPanel?.refreshPresetLink?.();
      else this.__krcLoraPanel?.syncFromPresetLink?.();
      return result;
    };
  },
});
