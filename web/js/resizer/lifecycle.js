import { api } from "../../../scripts/api.js";
import { GRID } from "./constants.js";
import { fetchInfo } from "./api.js";
import { centerSelectionInView, render } from "./render.js";
import { applyFrameData } from "./frame_data.js";
import {
    applyMP,
    applyNoSelect,
    defaultOut,
    fitAspectInsideSource,
    initLayout,
    restoreCropFromWidgets,
    syncOutToAR,
} from "./geometry.js";
import { createState, selectedFrameCount } from "./state.js";
import { buildUI } from "./ui_builder.js";
import { wireInteractions } from "./interactions.js";
import {
  applyNodeCanvasColors,
  applyNodePalette,
  domSummary,
  imageStatsFromElements,
  installKrcStatsAggregator,
  roughJsonBytes,
} from "./krc.js";
import {
    configureResizableDomWidget,
    clampResizerSize,
    createSizeEnforcer,
    getManagedWidgets,
    hideManagedWidgets,
    removeManagedInputs,
} from "./node_shell.js";
import { setupLayoutObserver } from "./layout_observer.js";
import { wireDisable } from "./disable_control.js";
import {
    restoreFrameSelFromWidgets,
    setArLocked,
    syncWidgets,
    updateFrameSelUI,
    updatePadColorUI,
} from "./ui_state.js";

const mountedResizers = new Set();

function connectedResizers() {
    const nodes = Array.from(mountedResizers).filter((node) => node?._resizerCtx?.dom?.root?.isConnected);
    for (const node of mountedResizers) {
        if (!node?._resizerCtx?.dom?.root?.isConnected) mountedResizers.delete(node);
    }
    return nodes;
}

function frameImageStats(dom) {
    const img = dom?.frameImg;
    const src = img?.currentSrc || img?.src || "";
    const kind = src.startsWith("data:")
        ? "data"
        : src.startsWith("blob:")
            ? "blob"
            : src
                ? "remote"
                : "empty";
    return {
        kind,
        srcChars: src.length,
        decodedBytesEstimate: kind === "data"
            ? Math.round(Math.max(src.length - src.indexOf(",") - 1, 0) * 0.75)
            : null,
        naturalW: img?.naturalWidth || 0,
        naturalH: img?.naturalHeight || 0,
        clientW: img?.clientWidth || 0,
        clientH: img?.clientHeight || 0,
        displayed: img ? getComputedStyle(img).display !== "none" : false,
    };
}

function installResizerStatsHook() {
    if (typeof window === "undefined" || window.krcResizerMemoryStats) return;
    window.krcResizerMemoryStats = () => {
        const nodes = connectedResizers();
        const detail = nodes.map((node) => {
            const { st, dom, widgets } = node._resizerCtx || {};
            const widgetValues = {};
            for (const [name, widget] of Object.entries(widgets || {})) {
                widgetValues[name] = widget?.value;
            }
            const root = dom?.root;
            const allImageStats = imageStatsFromElements(root?.querySelectorAll?.("img") || []);
            return {
                nodeId: node.id,
                stateBytes: roughJsonBytes(st),
                widgetBytes: roughJsonBytes(widgetValues),
                hasFrameData: !!st?.hasFrameData,
                hasPreviewImage: !!st?.hasPreviewImage,
                frameCount: st?.frameCount || 0,
                selectedFrameCount: typeof selectedFrameCount === "function" ? selectedFrameCount(st || {}) : 0,
                rawW: st?.rawW || 0,
                rawH: st?.rawH || 0,
                srcW: st?.srcW || 0,
                srcH: st?.srcH || 0,
                viewFrame: st?.viewFrame || 0,
                frameMode: st?.frameMode || "",
                mediaSig: st?.mediaSig || 0,
                frameImg: frameImageStats(dom),
                dom: domSummary(root),
                images: allImageStats,
            };
        });
        return {
            nodes: detail.length,
            totals: {
                stateBytes: detail.reduce((sum, item) => sum + (item.stateBytes || 0), 0),
                widgetBytes: detail.reduce((sum, item) => sum + (item.widgetBytes || 0), 0),
                frameImgSrcChars: detail.reduce((sum, item) => sum + (item.frameImg?.srcChars || 0), 0),
                frameImgDecodedBytesEstimate: detail.reduce((sum, item) => sum + (item.frameImg?.decodedBytesEstimate || 0), 0),
                dataUrls: detail.reduce((sum, item) => sum + (item.images?.dataUrls || 0), 0),
                blobUrls: detail.reduce((sum, item) => sum + (item.images?.blobUrls || 0), 0),
                images: detail.reduce((sum, item) => sum + (item.images?.images || 0), 0),
                domElements: detail.reduce((sum, item) => sum + (item.dom?.elements || 0), 0),
            },
            dom: {
                resizerNodes: document.querySelectorAll(".krc-resizer").length,
                images: document.querySelectorAll(".krc-resizer img").length,
            },
            detail,
        };
    };
    installKrcStatsAggregator();
}

export function installResizerNode(nodeType) {
    installResizerStatsHook();
    const origOnNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
        const result = origOnNodeCreated?.apply(this, arguments);
        const node = this;
        applyNodeCanvasColors(node); // fixed dark node chrome
        node.resizable = true;

        const widgets = getManagedWidgets(node);
        removeManagedInputs(node);

        // Build the canvas widget.
        const st  = createState();
        const dom = buildUI();

        const domWidget = node.addDOMWidget("krc_resizer_canvas", "customvideo", dom.root, {
            serialize: false,
            hideOnZoom: false,
        });

        const enforceSize = createSizeEnforcer(node, dom);
        configureResizableDomWidget(domWidget, node, dom);
        enforceSize();

        // Place canvas widget first; hide all canvas-managed widgets from native UI.
        hideManagedWidgets(node, domWidget);

        // Latch crop_state at onConfigure time so the rAF callback always has
        // the post-restore value.  Without this, the double-rAF can fire before
        // node.configure() runs the positional widget restore in some loading
        // paths, leaving crop_state.value as the empty default.
        // Also apply pad/custom color immediately so that even if the rAF fires
        // first, st.padColor and st.customPadColor are already correct by the time
        // any downstream code reads them.
        const origOnConfigure = node.onConfigure;
        node.onConfigure = function (info) {
            if (Array.isArray(info?.size)) {
                info.size = clampResizerSize(info.size, dom.root, node);
            }
            if (origOnConfigure) origOnConfigure.call(this, info);
            const hasSavedWidgets = Array.isArray(info?.widgets_values) && info.widgets_values.some(v => v !== "" && v != null);
            if (hasSavedWidgets) {
                if (widgets.cropState)   st._latchedCropState   = widgets.cropState.value;
                if (widgets.padColor)   { st.padColor         = widgets.padColor.value;   st._latchedPadColor   = undefined; }
                if (widgets.customPadColor) { st.customPadColor       = widgets.customPadColor.value; st._latchedCustomPadColor = undefined; }
                restoreFrameSelFromWidgets(st, widgets);
                st._fromWorkflow = true;   // loaded from saved data → don't auto-fit on first frames
            }
            // Re-stamp the per-node palette now that node.properties is restored.
            // wireInteractions' initial stamp runs from a double-rAF that can fire
            // before configure, otherwise leaving the DOM on the global palette
            // (most visible when the node is set to Native → reverts to default).
            applyNodePalette(node, dom.root);
            requestAnimationFrame(() => {
                enforceSize();
            });
        };

        // Deferred init so the DOM widget has been laid out and has a real width.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const nodeId = String(node.id);

                // Attempt layout now. This may fail (return false) if the node is
                // offscreen and ComfyUI has not given the DOM widget a real width yet.
                // If it fails, we do NOT return early — interactions and the
                // Layout observation is always wired so offscreen nodes can
                // complete initialization the first time they become visible.
                if (initLayout(st, dom.wrap)) {
                    // Use the value latched at onConfigure time if available.
                    if (st._fromWorkflow) {
                        restoreCropFromWidgets(st, widgets, st._latchedCropState);
                    }
                    st._latchedCropState = undefined;
                    // Restore pad color state from saved widget values.
                    if (st._latchedPadColor)   { st.padColor   = st._latchedPadColor;   st._latchedPadColor   = undefined; }
                    if (st._latchedCustomPadColor) { st.customPadColor = st._latchedCustomPadColor; st._latchedCustomPadColor = undefined; }
                    updatePadColorUI(st, dom);
                    if (st._fromWorkflow) {
                        restoreFrameSelFromWidgets(st, widgets);
                    }
                    setArLocked(st, dom, st.arLocked);
                    if (st.resMode === "mp") {
                        applyMP(st);
                    } else if (st.outW < GRID || st.outH < GRID) {
                        const d = defaultOut(st); st.outW = d.w; st.outH = d.h;
                    } else if (st.resLocked && !st.noSelect) {
                        fitAspectInsideSource(st, st.outW / st.outH);
                        setArLocked(st, dom, true);
                    } else {
                        syncOutToAR(st);
                    }
                    if (st.noSelect) applyNoSelect(st);
                    centerSelectionInView(st, dom);
                }

                // Always wire interactions and layout observation so nodes that
                // start offscreen become fully functional once visible.
                wireInteractions(st, dom, widgets, node, nodeId);
                const unwireDisable = wireDisable(node, dom);
                render(st, dom);
                updateFrameSelUI(st, dom);
                syncWidgets(st, widgets, node);
                enforceSize();
                const layoutObserver = setupLayoutObserver(st, dom, widgets);

                let refreshFrameDataPromise = null;
                const refreshFrameData = () => {
                    if (!dom.root.isConnected) return null;
                    if (refreshFrameDataPromise) return refreshFrameDataPromise;
                    refreshFrameDataPromise = (async () => {
                        const data = await fetchInfo(nodeId);
                        if (data && dom.root.isConnected) applyFrameData(data, true, st, dom, widgets, node, nodeId);
                    })().finally(() => {
                        refreshFrameDataPromise = null;
                    });
                    return refreshFrameDataPromise;
                };

                // Re-display frames as soon as this Resizer node has cached them,
                // so a global queue run can show the preview while downstream nodes
                // are still working. The generic ComfyUI events remain fallbacks.
                const onPreviewReady = (event) => {
                    const readyNode = event?.detail?.node_id;
                    if (String(readyNode) === nodeId) refreshFrameData();
                };
                const onExecuted = (event) => {
                    const executedNode = event?.detail?.node;
                    if (String(executedNode) === nodeId) refreshFrameData();
                };
                const onExecutionSuccess = () => refreshFrameData();
                api.addEventListener("krc-resizer-preview-ready", onPreviewReady);
                api.addEventListener("executed", onExecuted);
                api.addEventListener("execution_success", onExecutionSuccess);
                node._resizerCleanup = () => {
                    unwireDisable();
                    api.removeEventListener("krc-resizer-preview-ready", onPreviewReady);
                    api.removeEventListener("executed", onExecuted);
                    api.removeEventListener("execution_success", onExecutionSuccess);
                    layoutObserver?.disconnect();
                    const frameSrc = dom.frameImg?.src || "";
                    if (frameSrc.startsWith("blob:")) {
                        URL.revokeObjectURL(frameSrc);
                        dom.frameImg.removeAttribute("src");
                    }
                };

                // Also try to recover frames cached from a prior server session.
                refreshFrameData();
            });
        });

        // Cleanup.
        const origOnRemoved = node.onRemoved;
        node.onRemoved = function () {
            const stopPlayback = node._resizerStopPlayback;
            const cleanup = node._resizerCleanup;
            node._resizerShellClamp?.();
            node._resizerShellClamp = null;
            node._resizerStopPlayback = null;
            node._resizerCleanup = null;
            stopPlayback?.();
            cleanup?.();
            mountedResizers.delete(node);
            if (origOnRemoved) origOnRemoved.call(this);
        };

        node._resizerCtx = { st, dom, widgets };
        mountedResizers.add(node);
        return result;
    };
}
