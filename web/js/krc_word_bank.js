import { app } from "../../scripts/app.js";
import { el, stopCanvasWheel } from "./shared/dom.js";
import { hideWidget, promoteDomWidget } from "./shared/widgets.js";
import { EXT_NAME, NODE_TYPE, MIN_W } from "./word_bank/constants.js";
import { fetchBankNames, randomWord } from "./word_bank/api.js";
import { loadState, saveState } from "./word_bank/state.js";
import { injectStyle } from "./word_bank/styles.js";
import { calcHeight, calcNodeHeight, resizeNode } from "./word_bank/layout.js";
import { populateWidget } from "./word_bank/widget_builder.js";
import { rowBank } from "./word_bank/row_controls.js";
import { applyNodeCanvasColors } from "./shared/node_palette.js";
import { installWordBankStatsHook, registerWordBankNode, unregisterWordBankNode } from "./word_bank/memory_stats.js";

// ── Extension ─────────────────────────────────────────────────────────────────

app.registerExtension({
  name: EXT_NAME,

  setup() {
    installWordBankStatsHook();
    const origQueue = app.queuePrompt?.bind(app);
    if (typeof origQueue !== "function") return;
    app.queuePrompt = async function (...args) {
      const wbNodes = (app.graph?._nodes ?? []).filter(
        n => (n.comfyClass ?? n.type) === NODE_TYPE
      );
      await Promise.all(wbNodes.map(async node => {
        if (!loadState(node).autoSeed || !node.__wbWrap) return;
        const rows = [...node.__wbWrap.querySelectorAll(".wb-row")];
        await Promise.all(rows.map(async row => {
          if (row.classList.contains("locked")) return;
          const picker = rowBank(row);
          const inp = row.querySelector("input[type=text]");
          if (picker && inp) {
            inp.value = await randomWord(picker.value, inp.value);
            row.classList.remove("missing-word");
            inp.title = "";
          }
        }));
        if (node._wbGetRows) {
          const s = loadState(node);
          s.rows = node._wbGetRows();
          saveState(node, s);
        }
      }));
      return origQueue(...args);
    };
  },

  async nodeCreated(node) {
    // New ComfyUI Vue frontend uses node.comfyClass; old frontend uses node.type.
    const nodeClass = node.comfyClass ?? node.type ?? "";
    if (nodeClass !== NODE_TYPE) return;

    injectStyle();

    applyNodeCanvasColors(node); // fixed dark node chrome

    // Hide the state_json backing widget (shared recipe: hidden + type="hidden"
    // + computeSize, and hides the DOM element for multiline carriers). It stays
    // in node.widgets and still serializes as the hidden data carrier.
    hideWidget(node.widgets?.find(w => w.name === "state_json"));

    // Create DOM container and call addDOMWidget SYNCHRONOUSLY —
    // must happen before any await or LiteGraph ignores the widget.
    const wrap = el("div", "krc-node wb-wrap krc-solo-widget");
    wrap.style.minHeight = "60px";
    wrap.innerHTML = `<div class="wb-loading">Loading word banks…</div>`;

    if (typeof node.addDOMWidget !== "function") {
      console.warn("[KRC Word Bank] node.addDOMWidget is not available on this node");
      return;
    }

    // Node 2.0: the Vue @comfyorg/litegraph frontend reserves "customtext" for
    // its own multiline-textarea widget and does NOT render a DOM element for it,
    // so the Word Bank UI never appeared. A unique arbitrary type (like Config
    // Switcher's "ddp-ui") renders the DOM element as-is. No registration
    // is required — the type string is stored on the widget and nothing else.
    const domWidget = node.addDOMWidget("wb_ui", "wb-ui", wrap, {
      getValue()     { return ""; },
      setValue()     {},
      getMinHeight() {
        const rows = wrap.querySelectorAll(".wb-row").length;
        return calcHeight(rows);
      },
    });

    // Node 2.0: float the DOM widget above the (now hidden) state_json backing
    // widget so it doesn't reserve a deadspace band above the UI.
    promoteDomWidget(node, domWidget);
    // Node 2.0: keep wheel over the UI from zooming the canvas. WordBank grows to
    // fit its rows (no inner scroll), so this just consumes the event over the
    // node — harmless, and consistent with the other KRC DOM nodes.
    stopCanvasWheel(wrap);

    let removed = false;
    const prevOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      removed = true;
      unregisterWordBankNode(node);
      return prevOnRemoved ? prevOnRemoved.apply(this, arguments) : undefined;
    };

    // ── 3. Fetch banks async, then populate ──
    const bankNames = await fetchBankNames();
    if (removed) return;
    populateWidget(node, wrap, bankNames);
    node.__wbWrap = wrap;
    registerWordBankNode(node);

    const initialRows = loadState(node).rows.length;
    resizeNode(node, initialRows);

    // Enforce a minimum size so the node can't be dragged small enough to clip /
    // wrap / overlap its controls (which destroys the UI). Width floors at MIN_W;
    // height floors at the layout height for the current row count. Growing is
    // always allowed — only shrinking is clamped.
    const origOnResize = node.onResize;
    node.onResize = function (size) {
      const rows = wrap.querySelectorAll(".wb-row").length;
      size[0] = Math.max(size[0], MIN_W);
      size[1] = Math.max(size[1], calcNodeHeight(rows));
      return origOnResize ? origOnResize.apply(this, arguments) : undefined;
    };

    // Flush DOM state into node.properties before every serialise/queue run.
    // When auto-seed is on, generate a fresh seed so state_json changes and
    // ComfyUI doesn't serve a cached result.
    const origSerialize = node.serialize?.bind(node);
    node.serialize = function () {
      if (node._wbGetRows) {
        const s = loadState(node);
        s.rows = node._wbGetRows();
        saveState(node, s);
      }
      return origSerialize ? origSerialize() : {};
    };
  },
});
