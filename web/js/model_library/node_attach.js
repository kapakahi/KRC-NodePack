import { app } from "../../../scripts/app.js";
import { DOM_MIN_HEIGHT, hiddenWidgetDefaults, MAX_NODE_SIZE, MINI_NODE_SIZE, MIN_NODE_SIZE } from "./constants.js";
import {
  applyMinimumNodeSize,
  createDomHeightController,
  applyNodeTheme,
  bindNodeShellSizeClamp,
  ensureStylesheet,
  ensureWidget,
  forceNodeSize,
  installResizeClamp,
  promoteDomWidget,
  restoreDomWidgetLayout,
  suspendDomWidgetLayout,
} from "./helpers.js";
import { debounce, stopCanvasWheel } from "../shared/dom.js";
import { startPanelWhenReady } from "../shared/panel_startup.js";
import { LoraStackerPanel } from "./panel.js";


const USER_NODE_HEIGHT_PROPERTY = "mlNodeHeight";


function initialDomHeightForSurface(surface) {
  return DOM_MIN_HEIGHT;
}


function initialNodeHeightForAttach(node) {
  if (node.__krcLoraSurface === "mini") return null;
  const userHeight = Number(node.properties?.[USER_NODE_HEIGHT_PROPERTY]);
  if (Number.isFinite(userHeight)) return userHeight;
  const currentHeight = Number(node.size?.[1]);
  return Number.isFinite(currentHeight) ? currentHeight : MIN_NODE_SIZE[1];
}


function clampInitialNodeSize(node) {
  const targetHeight = initialNodeHeightForAttach(node);
  if (!targetHeight) return;
  const targetWidth = Math.min(Math.max(node.size?.[0] || MIN_NODE_SIZE[0], MIN_NODE_SIZE[0]), MAX_NODE_SIZE[0]);
  node.size = [targetWidth, targetHeight];
  node.setSize?.(node.size);
}


function applyAndForceMinimumNodeSize(node, requestedSize = node.size) {
  const before = Array.isArray(node.size) ? `${node.size[0]}x${node.size[1]}` : "";
  applyMinimumNodeSize(node, requestedSize);
  const after = Array.isArray(node.size) ? `${node.size[0]}x${node.size[1]}` : "";
  if (before !== after) {
    forceNodeSize(node, node.size, { dirty: false });
  }
}


function rememberUserNodeHeight(node) {
  if (node.__krcLoraSurface === "mini" || node.__krcLoraBooting) return;
  const height = Number(node.size?.[1]);
  if (!Number.isFinite(height)) return;
  node.properties ||= {};
  node.properties[USER_NODE_HEIGHT_PROPERTY] = height;
}


export function attachPanel(node, options = {}) {
  if (node.__krcLoraPanel) {
    node.__krcLoraPanel.rehydrateFromNode();
    return;
  }

  node.__krcLoraSurface = options.surface || "full";
  node.__krcLoraBooting = true;
  const stylesReady = ensureStylesheet();
  applyNodeTheme(node);
  Object.entries(hiddenWidgetDefaults(node.__krcLoraSurface)).forEach(([name, value]) => ensureWidget(node, name, value));
  installResizeClamp(node);
  clampInitialNodeSize(node);
  applyAndForceMinimumNodeSize(node);

  const supportsDomWidget = typeof node.addDOMWidget === "function";
  const panel = new LoraStackerPanel(node, { surface: node.__krcLoraSurface, deferInit: supportsDomWidget });
  node.__krcLoraPanel = panel;

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    node.__krcCancelPanelStartup?.();
    node.__krcCancelPanelStartup = null;
    node.__krcLoraShellSizeClampCleanup?.();
    node.__krcLoraShellSizeClampCleanup = null;
    node.__krcLoraRestoreDomHeight = null;
    node.__krcLoraPendingRestoreSize = null;
    node.__krcLoraRestoreDomWidgetLayout?.();
    node.__krcLoraRestoreDomWidgetLayout = null;
    node.__krcLoraCancelInteractiveResize?.();
    node.__krcLoraCancelInteractiveResize = null;
    node.__krcLoraFinalizeResize?.cancel?.();
    node.__krcLoraFinalizeResize = null;
    panel.destroy();
    return onRemoved?.apply(this, arguments);
  };

  if (supportsDomWidget) {
    const domWidget = node.addDOMWidget("krc_model_library_ui", "div", panel.root, {
      serialize: false,
      hideOnZoom: false,
      getMinHeight: () => DOM_MIN_HEIGHT,
      getValue: () => "",
      setValue: () => {},
    });
    // Node 2.0: float the DOM widget above the hidden backing widgets so they
    // don't leave a deadspace band above the panel.
    promoteDomWidget(node, domWidget);
    node.__krcLoraShellSizeClampCleanup = bindNodeShellSizeClamp(panel.root, node, {
      className: node.__krcLoraSurface === "mini" ? "krc-ml-mini-shell" : "krc-ml-shell",
      maxSize: node.__krcLoraSurface === "mini" ? MINI_NODE_SIZE : MAX_NODE_SIZE,
    });
    // Node 2.0: keep wheel over the UI from zooming the canvas so inner lists scroll.
    stopCanvasWheel(panel.root);
    // Node 2.0: the frontend sizes the DOM widget from the ELEMENT's measured
    // height, so keep a definite element height and feed it to the inner layout.
    // Full LoRA Loadout can grow with manual node resize; Mini is stack-only with
    // a popup browser, so it stays locked to its fixed size.
    if (node.__krcLoraSurface !== "mini") {
      const minDomHeight = initialDomHeightForSurface(node.__krcLoraSurface);
      const domHeightController = createDomHeightController(node, panel.root, {
        minNodeHeight: MIN_NODE_SIZE[1],
        maxNodeHeight: MAX_NODE_SIZE[1],
        minDomHeight,
        domWidget,
      });
      node.__krcLoraDomHeightController = domHeightController;
      node.__krcLoraRestoreDomHeight = (size = node.size) => {
        const restoredSize = Array.isArray(size) ? size : (Array.isArray(node.size) ? node.size : MIN_NODE_SIZE);
        applyAndForceMinimumNodeSize(node, restoredSize);
        domHeightController.stamp(node.size?.[1]);
      };
      if (node.__krcLoraPendingRestoreSize) {
        node.__krcLoraRestoreDomHeight(node.__krcLoraPendingRestoreSize);
        node.__krcLoraPendingRestoreSize = null;
      }
      domWidget.computeSize = () => [
        node.size?.[0] ?? MIN_NODE_SIZE[0],
        domHeightController.domHeightForNodeHeight(node.size?.[1]),
      ];
      let pendingInteractiveHeight = null;
      let interactiveStampFrame = null;
      const flushInteractiveStamp = () => {
        interactiveStampFrame = null;
        const height = pendingInteractiveHeight;
        pendingInteractiveHeight = null;
        domHeightController.stamp(height ?? node.size?.[1], { interactive: true });
      };
      const scheduleInteractiveStamp = (height) => {
        pendingInteractiveHeight = height;
        if (interactiveStampFrame) return;
        interactiveStampFrame = requestAnimationFrame(flushInteractiveStamp);
      };
      const finalizeResize = debounce(() => {
        if (interactiveStampFrame) {
          cancelAnimationFrame(interactiveStampFrame);
          interactiveStampFrame = null;
          pendingInteractiveHeight = null;
        }
        restoreDomWidgetLayout(node, domWidget);
        domHeightController.stamp(node.size?.[1]);
        panel.scheduleBrowserViewportUpdateAfterResize?.();
        rememberUserNodeHeight(node);
      }, 140);
      node.__krcLoraCancelInteractiveResize = () => {
        if (!interactiveStampFrame) return;
        cancelAnimationFrame(interactiveStampFrame);
        interactiveStampFrame = null;
        pendingInteractiveHeight = null;
      };
      node.__krcLoraFinalizeResize = finalizeResize;
      node.__krcLoraRestoreDomWidgetLayout = () => restoreDomWidgetLayout(node, domWidget);
      let lastForcedSize = null;
      const prevResize = node.onResize;
      node.onResize = function (size) {
        if (this.__krcForcingSize) return prevResize?.apply(this, arguments);
        const requestedWidth = Array.isArray(size) ? size[0] : this.size?.[0];
        const requestedHeight = Array.isArray(size) ? size[1] : this.size?.[1];
        if (app.canvas?.resizing_node === this) {
          suspendDomWidgetLayout(this, domWidget);
        }
        const result = prevResize?.apply(this, arguments);
        applyMinimumNodeSize(this, size);
        const wasClamped = requestedWidth !== this.size?.[0] || requestedHeight !== this.size?.[1];
        const forcedSize = `${this.size?.[0]}x${this.size?.[1]}`;
        if (wasClamped && forcedSize !== lastForcedSize) {
          forceNodeSize(this, this.size, { dirty: false });
          lastForcedSize = forcedSize;
        } else if (!wasClamped) {
          lastForcedSize = null;
        }
        scheduleInteractiveStamp(size?.[1] ?? this.size?.[1]);
        finalizeResize();
        return result;
      };
    } else {
      domWidget.computeSize = () => [MINI_NODE_SIZE[0], DOM_MIN_HEIGHT];
    }
    node.__krcCancelPanelStartup = startPanelWhenReady(panel, {
      stylesReady,
      isReady: () => Boolean(node.__krcLoraConfigured || node.__krcLoraCreateSettled || !node.graph),
      onSettled: () => { node.__krcLoraBooting = false; },
    });
  } else {
    node.addCustomWidget({
      name: "krc_model_library_ui",
      type: "custom",
      serialize: false,
      draw(ctx, _node, width, y) {
        ctx.save();
        ctx.fillStyle = "#7B75C4";
        ctx.fillRect(0, y, width, 620);
        ctx.fillStyle = "#FFFFFF";
        ctx.font = "18px sans-serif";
        ctx.fillText("KRC Model Library custom DOM widget requires ComfyUI DOM widget support.", 18, y + 42);
        ctx.restore();
      },
      computeSize: () => [MIN_NODE_SIZE[0], DOM_MIN_HEIGHT],
    });
    Promise.resolve(stylesReady).then(() => {
      panel.start();
      node.__krcLoraBooting = false;
    });
  }
}
