import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import {
  bindNodeShellSizeClamp,
  createDomHeightController,
  ensureHiddenWidget,
  findWidget,
  forceNodeSize,
  hideWidgets,
  promoteDomWidget,
  restoreDomWidgetLayout,
  suspendDomWidgetLayout,
} from "./shared/widgets.js";
import { applyNodeCanvasColors } from "./shared/node_palette.js";
import { newNodeShowsNsfw } from "./shared/global_settings.js";
import { debounce } from "./shared/dom.js";
import { PMRedesign, applyPromptUsage } from "./prompt_vault/controller.js";
import { injectStyle } from "./prompt_vault/styles.js";
import { DOM_MIN_HEIGHT, MAX_NODE_SIZE, NODE_TYPE, MIN_NODE_SIZE } from "./prompt_vault/constants.js";
import { el, stopCanvasWheel } from "./prompt_vault/dom.js";
import { registerLibraryProvider } from "./shared/library_modal.js";
import { createPromptProvider } from "./prompt_vault/modal_provider.js";
import { registerExportMeta } from "./shared/palette_export.js";
import { promptProfileExportMeta } from "./prompt_vault/profiles.js";

// Each Prompt Vault node's profile in API-format exports (ext/v1 "prompts.profiles.meta").
registerExportMeta(promptProfileExportMeta);

// Register the shared library modal's "prompts" provider at load, so any opener
// (Config Switcher prompt fields, a toolbar button) can summon it and the
// Models⇄Prompts toggle lights up.
registerLibraryProvider({ id: "prompts", label: "Prompts", order: 1, create: createPromptProvider });

// Live "Used N times": the per-run counter pushes new totals on Queue Prompt. One
// listener for the page; applyPromptUsage patches every mounted vault (and the Portal's).
api.addEventListener("krc-prompt-usage", (event) => applyPromptUsage(event?.detail?.usage, event?.detail?.profileId));

/*
 * KRC Prompt Vault — LoRA Loadout design language.
 * Two-column DOM-widget UI (Browser + Info Panel) over the shared
 * /krc/prompt-vault data store. Binds to the canonical node id
 * "KRC Prompt Vault".
 */

// Fixed DOM-widget height floor for the Node 2.0 height contract (see the
// getMinHeight on the DOM widget). ~= the min node height minus the node's
// title/slot chrome; a constant so it never feeds back into node.size.
const PV_DOM_MIN_HEIGHT = DOM_MIN_HEIGHT;

function applyMinimumNodeSize(node, requestedSize = node.size) {
  const width = Math.min(Math.max(requestedSize?.[0] || 0, MIN_NODE_SIZE[0]), MAX_NODE_SIZE[0]);
  const height = Math.min(Math.max(requestedSize?.[1] || 0, MIN_NODE_SIZE[1]), MAX_NODE_SIZE[1]);
  node.size = [width, height];
  node.min_size = MIN_NODE_SIZE;
  node.max_size = MAX_NODE_SIZE;
}

function parseJsonObject(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// ── Extension ───────────────────────────────────────────────────────────
app.registerExtension({
  name: "KRC.PromptVault",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_TYPE) return;
    injectStyle();

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const node = this;

      applyNodeCanvasColors(node); // fixed dark node chrome
      // A new node's NSFW eye starts at the global default; a restore overwrites it.
      node.properties ||= {};
      node.properties.pmShowNSFW = newNodeShowsNsfw();

      // Hide the backing widgets — the DOM UI drives them.
      ensureHiddenWidget(node, "prompt_b", "");
      ensureHiddenWidget(node, "append_prompt_b", false);
      ensureHiddenWidget(node, "replace_find", "");
      ensureHiddenWidget(node, "replace_with", "");
      ensureHiddenWidget(node, "replace_prompt_b", false);
      ensureHiddenWidget(node, "clear_lora_when_missing", false);
      ensureHiddenWidget(node, "prompt_input_enabled", false);
      ensureHiddenWidget(node, "prompt_input_target", "A");
      ensureHiddenWidget(node, "prompt_input_disable_on_swap", false);
      ensureHiddenWidget(node, "prompt_input_rejected", "");
      ensureHiddenWidget(node, "prompt_input_rejected_target", "A");
      ensureHiddenWidget(node, "pm_draft", "");
      ensureHiddenWidget(node, "kit_presets", "");
      ensureHiddenWidget(node, "prompt_id", "");
      hideWidgets(node, [
        "category", "name", "text", "ll_preset", "prompt_b", "append_prompt_b",
        "replace_find", "replace_with", "replace_prompt_b", "clear_lora_when_missing",
        "prompt_input_enabled", "prompt_input_target", "prompt_input_disable_on_swap",
        "prompt_input_rejected", "prompt_input_rejected_target", "pm_draft", "kit_presets", "prompt_id",
      ]);

      const root = el("div", "krc-node krc-pm krc-solo-widget");
      const domWidget = node.addDOMWidget("krc_pv_ui", "div", root, {
        serialize: false,
        hideOnZoom: false,
        getMinHeight: () => PV_DOM_MIN_HEIGHT,
      });
      // Node 2.0: override computeSize so the frontend doesn't measure the tall
      // prompt list and let the node run away. Height is derived from the clamped
      // node size minus the calibrated Vue chrome/hidden-widget offset.
      let domHeightController = null;
      domWidget.computeSize = () => [
        node.size?.[0] ?? MIN_NODE_SIZE[0],
        domHeightController?.domHeightForNodeHeight(node.size?.[1]) ?? PV_DOM_MIN_HEIGHT,
      ];
      // Node 2.0: float the DOM widget above the hidden backing widgets so they
      // don't leave a deadspace band (or leak multiline textareas) above the UI.
      promoteDomWidget(node, domWidget);
      const cleanupShellSizeClamp = bindNodeShellSizeClamp(root, node, {
        className: "krc-pm-shell",
        maxSize: MAX_NODE_SIZE,
      });
      applyMinimumNodeSize(node, Array.isArray(node.size) ? node.size : MIN_NODE_SIZE);

      // Node 2.0 also sizes from the element's measured height, so stamp a
      // definite pixel height plus --krc-dom-h for the inner CSS grid.
      domHeightController = createDomHeightController(node, root, {
        minNodeHeight: MIN_NODE_SIZE[1],
        maxNodeHeight: MAX_NODE_SIZE[1],
        minDomHeight: PV_DOM_MIN_HEIGHT,
        domWidget,
        node2DomTrim: 16,
      });
      node._pmRestoreDomHeight = (size = node.size) => {
        const restoredSize = Array.isArray(size) ? size : (Array.isArray(node.size) ? node.size : MIN_NODE_SIZE);
        applyMinimumNodeSize(node, restoredSize);
        domHeightController?.stamp(node.size?.[1]);
      };
      // Node 2.0: keep wheel over the UI from zooming the canvas so the inner
      // lists (prompt list, category chips) scroll natively.
      stopCanvasWheel(root);
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
        node._pmCtrl?.scheduleVirtualPromptViewportUpdate?.();
      }, 140);
      let lastForcedSize = null;

      const origOnResize = node.onResize;
      node.onResize = function (size) {
        if (this.__krcForcingSize) return origOnResize ? origOnResize.apply(this, arguments) : undefined;
        const requestedWidth = Array.isArray(size) ? size[0] : this.size?.[0];
        const requestedHeight = Array.isArray(size) ? size[1] : this.size?.[1];
        if (app.canvas?.resizing_node === this) {
          suspendDomWidgetLayout(this, domWidget);
        }
        const result = origOnResize ? origOnResize.apply(this, arguments) : undefined;
        if (Array.isArray(size)) {
          size[0] = Math.min(Math.max(size[0], MIN_NODE_SIZE[0]), MAX_NODE_SIZE[0]);
          size[1] = Math.min(Math.max(size[1], MIN_NODE_SIZE[1]), MAX_NODE_SIZE[1]);
        }
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

      const ctrl = new PMRedesign(node, root);
      node._pmCtrl = ctrl;

      // Initial render + data load (deferred so widgets exist). onConfigure
      // (below) is the authoritative restore path for saved workflows; this
      // is only a fallback for brand-new nodes (nothing to restore) or the
      // rare case onConfigure fired before ctrl existed.
      node._pmInitialFrame = requestAnimationFrame(() => {
        node._pmInitialFrame = null;
        node._pmRestoreDomHeight?.(node._pmPendingRestoreSize || node.size);
        node._pmPendingRestoreSize = null;
        ctrl.render();
        // onConfigure is the authoritative restore path for saved workflows and
        // it restores the dirty draft. If it already ran, DON'T run the fallback
        // below: reload().then(select(saved)) would reselect the clean saved
        // record and clobber the just-restored unsaved edits (this is the bug
        // where modified prompts vanished on reload / workflow switch).
        if (node._pmConfigureRestored) return;
        const pending = node._pmPendingRestore;
        node._pmPendingRestore = null;
        if (pending && (pending.category || pending.activeCategory)) {
          ctrl.restoreSelection(pending.category, pending.name, pending.activeCategory, pending.draft, pending.hasStoredDraft);
        } else {
          ctrl.reload(false).then(() => {
            const cat = ctrl.widgets.category?.value, name = ctrl.widgets.name?.value;
            if (cat && name) { const it = ctrl.findByKey(ctrl.keyOf(cat, name)); if (it) ctrl.select(it); }
          });
        }
      });

      const promptInputFromEvent = (event) => {
        const detail = event?.detail || {};
        if (String(detail.node) !== String(node.id)) return null;
        const ui = detail.output || detail.outputs || detail.ui || {};
        const value = ui?.krc_prompt_input;
        const target = ui?.krc_prompt_input_target;
        const text = Array.isArray(value) ? String(value[0] || "") : String(value || "");
        const targetValue = Array.isArray(target) ? String(target[0] || "") : String(target || "");
        return text ? { text, target: targetValue === "B" ? "B" : "A" } : null;
      };
      const onExecuted = (event) => {
        const input = promptInputFromEvent(event);
        if (input) {
          node._pmCtrl?.applyPromptInputFromRun?.(input.text, input.target);
        }
      };

      // Note: a completed run no longer forces a library reload. Same-page saves
      // sync siblings live via publishPromptLibrary; genuine out-of-band changes
      // (bulk import, future write-node / Editor) arrive on the PROMPTS_CHANGED
      // sync-bus lane, which the controller subscribes to and refreshes targeted.
      api.addEventListener("executed", onExecuted);
      const origRemoved = node.onRemoved;
      node.onRemoved = function () {
        if (node._pmInitialFrame) {
          cancelAnimationFrame(node._pmInitialFrame);
          node._pmInitialFrame = null;
        }
        cleanupShellSizeClamp?.();
        node.__krcNodeShellSizeClampCleanup = null;
        node._pmRestoreDomHeight = null;
        node._pmPendingRestoreSize = null;
        restoreDomWidgetLayout(node, domWidget);
        if (interactiveStampFrame) {
          cancelAnimationFrame(interactiveStampFrame);
          interactiveStampFrame = null;
          pendingInteractiveHeight = null;
        }
        finalizeResize.cancel?.();
        node._pmCtrl?.destroy?.();
        api.removeEventListener("executed", onExecuted);
        return origRemoved?.apply(this, arguments);
      };

      return r;
    };

    // LiteGraph applies saved properties/widgets_values to the node before
    // calling onConfigure, so this is the earliest point the saved selection
    // is guaranteed available — reading it later from a queued rAF (as
    // onNodeCreated does) can race ahead of configure() on some graph-load
    // paths. Prefer node.properties over the live widget .value: properties
    // are a plain serialized bag restored verbatim by configure(), whereas a
    // combo widget's .value can be normalized/reset by the frontend when its
    // saved value doesn't match that widget's current options list.
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (info) {
      const r = onConfigure?.apply(this, arguments);
      const node = this;
      const props = node.properties || {};
      const draftWidget = findWidget(node, "pm_draft");
      const widgetDraft = parseJsonObject(draftWidget?.value);
      const storedDraft = props.pmDraft && typeof props.pmDraft === "object" ? props.pmDraft : widgetDraft?.draft;
      // A real persisted draft (vs. the fresh-node fallback below) means the
      // user was editing — either a New/unsaved prompt or edits to a saved one.
      // When no saved record matches on restore, this flag tells the controller
      // to bring the draft back as an editing buffer instead of the empty state.
      const hasStoredDraft = !!storedDraft;
      const draft = storedDraft && typeof storedDraft === "object" ? storedDraft : {
        category: props.category ?? findWidget(node, "category")?.value,
        name: props.name ?? findWidget(node, "name")?.value,
        prompt: props.text ?? findWidget(node, "text")?.value,
        llPreset: props.ll_preset ?? findWidget(node, "ll_preset")?.value,
        promptB: props.prompt_b ?? findWidget(node, "prompt_b")?.value,
        appendPromptB: props.append_prompt_b ?? findWidget(node, "append_prompt_b")?.value,
      };
      const cat = props.pmOrigCategory || widgetDraft?.origCategory || draft.category;
      const name = props.pmOrigName || widgetDraft?.origName || draft.name;
      const activeCategory = props.pmActiveCategory;
      const restoredSize = Array.isArray(info?.size) ? info.size : (Array.isArray(node.size) ? node.size : MIN_NODE_SIZE);
      if (node._pmCtrl) {
        node._pmRestoreDomHeight?.(restoredSize);
        requestAnimationFrame(() => {
          if (!node._pmCtrl?.root?.isConnected) return;
          node._pmRestoreDomHeight?.(restoredSize);
          node._pmCtrl?.scheduleVirtualPromptViewportUpdate?.();
        });
        // Mark that the authoritative restore ran so the onNodeCreated fallback
        // frame won't reselect the clean saved record over the dirty draft. If
        // that frame is still pending, cancel it and render now instead.
        node._pmConfigureRestored = true;
        node._pmCtrl.restoreBrowserState?.(props);
        if (node._pmInitialFrame) {
          cancelAnimationFrame(node._pmInitialFrame);
          node._pmInitialFrame = null;
          node._pmCtrl.render();
        }
        node._pmCtrl.restoreSelection(cat, name, activeCategory, draft, hasStoredDraft);
      } else {
        node._pmPendingRestoreSize = restoredSize;
        node._pmPendingRestore = { category: cat, name, activeCategory, draft, hasStoredDraft };
      }
      return r;
    };
  },
});
