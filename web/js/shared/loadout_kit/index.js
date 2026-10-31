// Loadout Kit (Card API Layer 2): build a card-stack node from a kit descriptor.
//
//   registerLoadout({
//     nodeType: "KRC RefMod Loadout",   // the Python node's type name
//     kit: "refmod_loadout",            // the Python LoadoutKit id
//     noun: "RefMod",                   // labels: "RefMods" header, "Missing RefMod", ...
//     hiddenWidgets: { token_budget: 0 },  // the node's own inputs the kit should hide
//     header: { right: (ctx) => element }, // optional; re-called after every stack change
//   });
//
// Call it once when the extension loads (before node defs register). Fields, source and
// slot count come from the Python kit — fetched when the first node is created, after
// ComfyUI has called INPUT_TYPES — so JS and Python can't drift and pack load order
// doesn't matter. Resolves to true when the node type was hooked.
import { app } from "../../../../scripts/app.js";
import { applyNodeCanvasColors } from "../node_palette.js";
import { bindNodeShellSizeClamp, promoteDomWidget } from "../widgets.js";
import { ensureStylesheet, SHARED_STYLE_VERSION } from "../stylesheets.js";
import { stopCanvasWheel } from "../dom.js";
import { ensureStylesheet as ensureLoraLoadoutStylesheet } from "../../lora_loadout/helpers.js";
import { startPanelWhenReady } from "../panel_startup.js";
import { createKitContext } from "./kit_context.js";
import { createKitPanel } from "./panel.js";
import { registerKitNodeType } from "../loadout_presets.js";

const KIT_STYLE_VERSION = "1";

// LL's sheet (preset panel + slot cards) + the kit's own (stack geometry + field strip).
function ensureKitStylesheets() {
  return Promise.all([
    ensureLoraLoadoutStylesheet(),
    ensureStylesheet("krc-loadout-kit-css", "./loadout_kit.css", import.meta.url, {
      version: `${SHARED_STYLE_VERSION}.${KIT_STYLE_VERSION}`,
      ready: true,
    }),
  ]);
}

// The kit's DOM panel is added after the descriptor arrives and then promoted to the front
// of node.widgets, so the order ComfyUI saves widgets_values in is not the order the
// widgets exist in when a reload writes them back (positionally, before the panel). The
// values came back shifted (e.g. the trigger switch reading "" = off). Every kit write
// also lands in node.properties under the widget's name, which reloads by name: so after a
// configure, put each hidden widget back from its property, and reset a value of the wrong
// type that has none to its default.
function restoreHiddenWidgetsByName(node, kit) {
  const props = node.properties || {};
  for (const [name, fallback] of Object.entries(kit.hiddenWidgets)) {
    const widget = kit.ensureWidget(node, name, fallback);
    if (!widget) continue;
    if (props[name] !== undefined) widget.value = props[name];
    else if (typeof widget.value !== typeof fallback) widget.value = fallback;
  }
}

// Mirror every hidden widget into node.properties once, so each one saves by name too.
// Only after a configure (or for a fresh drop): seeding before it would leave defaults that
// the restore above would then trust over an older workflow's real values.
function seedHiddenWidgetProperties(node, kit) {
  node.properties ||= {};
  for (const name of Object.keys(kit.hiddenWidgets)) {
    if (node.properties[name] !== undefined) continue;
    const widget = (node.widgets || []).find((w) => w?.name === name);
    if (widget) node.properties[name] = widget.value;
  }
}

function seedAutoPresetDefault(node, kit) {
  const widget = kit.ensureWidget(node, "auto_preset_link", true);
  if (node.properties?.auto_preset_link !== undefined || widget.value === true) return;
  widget.value = true;
  const index = node.widgets?.indexOf(widget) ?? -1;
  if (index >= 0 && Array.isArray(node.widgets_values)) node.widgets_values[index] = true;
}

// LL mini's attach path: a fixed-size node whose DOM widget is the preset panel + stack.
// Widgets are set at once; the size (from the slot count) and the panel follow when the
// kit's descriptor is in.
function attachKitPanel(node, kit) {
  if (node.__krcKitPanel) {
    node.__krcKitPanel.rehydrateFromNode();
    return;
  }
  if (node.__krcKitAttaching) return;
  node.__krcKitAttaching = true;
  // The shared sizing helpers lock a "mini" node to its fixed size.
  node.__krcLoraSurface = "mini";
  node.__krcKitBooting = true;
  applyNodeCanvasColors(node);
  Object.entries(kit.hiddenWidgets).forEach(([name, value]) => kit.ensureWidget(node, name, value));
  seedAutoPresetDefault(node, kit);

  // A node deleted before its descriptor arrives must not be mounted afterwards.
  const onRemovedEarly = node.onRemoved;
  node.onRemoved = function () {
    node.__krcKitRemoved = true;
    return onRemovedEarly?.apply(this, arguments);
  };

  kit.ensureDescriptor().then((ok) => {
    if (!ok) {
      if (!kit.warned) {
        kit.warned = true;
        console.warn(`[KRC Loadout ${kit.id}] no Python kit "${kit.id}" is registered; ${kit.nodeType} keeps its plain widgets`);
      }
      node.__krcKitAttaching = false;
      return;
    }
    if (node.__krcKitRemoved) return;
    mountKitPanel(node, kit);
  });
}

function mountKitPanel(node, kit) {
  kit.sizing.installResizeClamp(node);
  kit.sizing.applyMinimumNodeSize(node);
  const stylesReady = ensureKitStylesheets();
  const supportsDomWidget = typeof node.addDOMWidget === "function";
  const panel = createKitPanel(node, kit, { deferInit: supportsDomWidget });
  node.__krcKitPanel = panel;

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    node.__krcCancelPanelStartup?.();
    node.__krcCancelPanelStartup = null;
    node.__krcKitShellSizeClampCleanup?.();
    node.__krcKitShellSizeClampCleanup = null;
    panel.destroy();
    return onRemoved?.apply(this, arguments);
  };

  if (!supportsDomWidget) {
    node.addCustomWidget({
      name: "loadout_kit_panel",
      type: "custom",
      serialize: false,
      draw(ctx, _node, width, y) {
        ctx.save();
        ctx.fillStyle = "#7B75C4";
        ctx.fillRect(0, y, width, kit.domHeight);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "18px sans-serif";
        ctx.fillText(`${kit.title} requires ComfyUI DOM widget support.`, 18, y + 42);
        ctx.restore();
      },
      computeSize: () => [kit.size[0], kit.domHeight],
    });
    Promise.resolve(stylesReady).then(() => {
      panel.start();
      node.__krcKitBooting = false;
    });
    return;
  }

  const domWidget = node.addDOMWidget("loadout_kit_panel", "div", panel.root, {
    serialize: false,
    hideOnZoom: false,
    getValue: () => "",
    setValue: () => {},
  });
  // Node 2.0: float the DOM widget above the hidden backing widgets.
  promoteDomWidget(node, domWidget);
  node.__krcKitShellSizeClampCleanup = bindNodeShellSizeClamp(panel.root, node, {
    className: "krc-ll-mini-shell",
    maxSize: kit.size,
  });
  // Node 2.0: keep wheel over the UI from zooming the canvas.
  stopCanvasWheel(panel.root);
  domWidget.computeSize = () => [kit.size[0], kit.domHeight];
  // The widget can land after configure (the descriptor arrives async): re-lock the size.
  kit.sizing.applyMinimumNodeSize(node);
  node.__krcCancelPanelStartup = startPanelWhenReady(panel, {
    stylesReady,
    isReady: () => Boolean(node.__krcKitConfigured || node.__krcKitCreateSettled || !node.graph),
    onSettled: () => { node.__krcKitBooting = false; },
  });
}

const registered = new Set();

export async function registerLoadout(options = {}) {
  const nodeType = String(options.nodeType || "");
  const kitId = String(options.kit || "");
  const tag = `[KRC Loadout ${kitId || "?"}]`;
  if (!nodeType || !kitId) {
    console.warn(`${tag} registerLoadout needs { nodeType, kit }`);
    return false;
  }
  if (registered.has(nodeType)) {
    console.warn(`${tag} ${nodeType} is already registered`);
    return false;
  }
  registered.add(nodeType);
  registerKitNodeType(nodeType, kitId);   // Prompt Vault's preset sync finds these nodes
  ensureKitStylesheets();

  app.registerExtension({
    name: `KRC.LoadoutKit.${kitId}`,
    beforeRegisterNodeDef(nodeTypeClass, nodeData) {
      if (nodeData.name !== nodeType) return;
      const kit = createKitContext({ ...options, nodeType, kit: kitId }, nodeData);

      const onNodeCreated = nodeTypeClass.prototype.onNodeCreated;
      nodeTypeClass.prototype.onNodeCreated = function () {
        const result = onNodeCreated?.apply(this, arguments);
        // Graph restores call onConfigure synchronously right after this, so a microtask
        // lands after it: no configure means a fresh drop, and boot can proceed.
        queueMicrotask(() => {
          this.__krcKitCreateSettled = true;
          if (!this.__krcKitConfigured) seedHiddenWidgetProperties(this, kit);   // fresh drop
        });
        attachKitPanel(this, kit);
        return result;
      };

      const onConfigure = nodeTypeClass.prototype.onConfigure;
      nodeTypeClass.prototype.onConfigure = function () {
        const result = onConfigure?.apply(this, arguments);
        this.__krcKitConfigured = true;
        applyNodeCanvasColors(this);
        restoreHiddenWidgetsByName(this, kit);
        seedHiddenWidgetProperties(this, kit);
        this.__krcKitPanel?.rehydrateFromNode();
        return result;
      };

      const onExecuted = nodeTypeClass.prototype.onExecuted;
      nodeTypeClass.prototype.onExecuted = function (message) {
        const result = onExecuted?.apply(this, arguments);
        this.__krcKitPanel?.applyTriggeredPresetUi(message);
        this.__krcKitPanel?.applyMissingUi(message);
        this.__krcKitPanel?.applyPresetLinkUi(message);
        return result;
      };

      // Wiring or unwiring the preset input changes the link indicator.
      const onConnectionsChange = nodeTypeClass.prototype.onConnectionsChange;
      nodeTypeClass.prototype.onConnectionsChange = function () {
        const result = onConnectionsChange?.apply(this, arguments);
        // Not while a workflow loads: applying then would mark it dirty.
        if (app.configuringGraph) this.__krcKitPanel?.refreshPresetLink?.();
        else this.__krcKitPanel?.syncFromPresetLink?.();
        return result;
      };
    },
  });
  return true;
}
