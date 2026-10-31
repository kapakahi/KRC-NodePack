/*
 * KRC Prompt Vault — prompt boxes.
 * Prompt boxes: Find / Replace, the Prompt A / B inline controls (copy, clear, prompt input,
 * append, swap), the A / B split and its divider, and the text box builder.
 * Mixed onto PMRedesign.prototype via Object.assign.
 */
import { armConfirmButton } from "../shared/confirm_action.js";
import { el } from "./dom.js";

// Minimum height (px) for each prompt box, and the divider's drag floor — tuned
// so at least ~3 lines of the 12px/Inter textarea stay visible above the inline
// controls (header ~19px + 3 lines ~44px + 31px padding).
const PROMPT_MIN_PX = 100;

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wholeWordReplaceResult(text, findText, replaceText) {
  const source = String(text || "");
  const find = String(findText || "");
  if (!find) return { text: source, count: 0 };
  let count = 0;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_])(${escapeRegExp(find)})(?=$|[^A-Za-z0-9_])`, "g");
  const next = source.replace(pattern, (_match, lead) => {
    count += 1;
    return `${lead}${replaceText || ""}`;
  });
  return { text: next, count };
}

export const promptBoxMethods = {
  renderReplaceTools() {
    const d = this.draft || {};
    const wrap = el("div", "krc-replace-tools");
    const find = el("input", "krc-input krc-replace-find", { value: d.replaceFind || "", placeholder: "Find" });
    const repl = el("input", "krc-input krc-replace-with", { value: d.replaceWith || "", placeholder: "Replace" });
    find.addEventListener("input", () => {
      if (!this.draft) return;
      this.draft.replaceFind = find.value;
      this.draftChanged();
    });
    repl.addEventListener("input", () => {
      if (!this.draft) return;
      this.draft.replaceWith = repl.value;
      this.draftChanged();
    });

    const actions = el("div", "krc-replace-actions");
    const apply = el("button", "krc-action-button krc-replace-apply", {
      textContent: "REPLACE",
      title: "Replace matching whole words.",
      type: "button",
    });
    apply.addEventListener("click", () => this.applyPromptReplace());
    actions.append(apply);
    const feedback = el("div", "krc-replace-feedback", { textContent: this._replaceFeedbackText || "" });
    feedback.setAttribute("aria-live", "polite");
    if (this._replaceFeedbackText) {
      feedback.classList.add("is-visible");
    }
    this._pmReplaceFeedbackEl = feedback;
    wrap.append(this.fieldLabel("Find / Replace"), find, repl, actions, feedback);
    return wrap;
  },

  applyPromptReplace() {
    if (!this.draft) return;
    const find = this.draft.replaceFind || "";
    if (!find) {
      this.showReplaceFeedback("No find text");
      return;
    }
    const resultA = wholeWordReplaceResult(this.draft.prompt || "", find, this.draft.replaceWith || "");
    const includePromptB = this.replacePromptBEnabled?.();
    const resultB = includePromptB
      ? wholeWordReplaceResult(this.draft.promptB || "", find, this.draft.replaceWith || "")
      : { text: this.draft.promptB || "", count: 0 };
    const count = resultA.count + (includePromptB ? resultB.count : 0);
    if (!count) {
      this.showReplaceFeedback("0 words replaced");
      return;
    }
    this.draft.prompt = resultA.text;
    if (includePromptB) this.draft.promptB = resultB.text;
    const f = this._pmEditFields;
    if (f?.prompt) f.prompt.value = resultA.text;
    if (includePromptB && f?.promptB) f.promptB.value = resultB.text;
    this.draftChanged();
    this.showReplaceFeedback(`${count} word${count === 1 ? "" : "s"} replaced`);
  },

  showReplaceFeedback(message) {
    this._replaceFeedbackText = message || "";
    const node = this._pmReplaceFeedbackEl || this.root?.querySelector(".krc-replace-feedback");
    if (!node) return;
    window.clearTimeout(this._replaceFeedbackTimer);
    node.textContent = this._replaceFeedbackText;
    node.classList.remove("is-fading");
    node.classList.toggle("is-visible", !!this._replaceFeedbackText);
    if (!this._replaceFeedbackText) return;
    this._replaceFeedbackTimer = window.setTimeout(() => {
      const current = this._pmReplaceFeedbackEl || node;
      current.classList.add("is-fading");
      this._replaceFeedbackTimer = window.setTimeout(() => {
        this._replaceFeedbackText = "";
        const latest = this._pmReplaceFeedbackEl || current;
        latest.textContent = "";
        latest.classList.remove("is-visible", "is-fading");
      }, 260);
    }, 5000);
  },

  promptBoxControls(ta, onInput) {
    const wrap = el("div", "krc-prompt-controls");
    const copy = el("button", "krc-icon-button is-compact krc-prompt-tool", { textContent: "⧉", title: "Copy", type: "button" });
    copy.addEventListener("click", (e) => { e.stopPropagation(); this.copyText(ta.value); });
    const clear = el("button", "krc-icon-button is-compact krc-prompt-tool krc-prompt-clear", { textContent: "×", title: "Clear prompt", type: "button" });
    armConfirmButton(clear, {
      armedText: "✕",
      armedTitle: "Click again to clear",
      restoreText: "×",
      restoreTitle: "Clear prompt",
      timeout: 2200,
      stopPropagation: true,
      shouldArm: () => !!ta.value,
      onConfirm: () => {
        ta.value = "";
        onInput("");
        this.draftChanged();
        ta.focus();
      },
    });
    wrap.append(clear, copy);   // clear on top, copy below (top-right column)
    return wrap;
  },

  promptAControls() {
    const wrap = el("div", "krc-prompt-a-controls");
    const undo = el("button", "krc-inline-action is-icon krc-undo-button", {
      textContent: "↺", title: "Undo edit (Prompt A/B, LL preset, notes)", type: "button",
    });
    undo.disabled = !this.canUndoEdit?.();
    undo.addEventListener("click", (e) => { e.stopPropagation(); this.undoEdit(); });
    const redo = el("button", "krc-inline-action is-icon krc-redo-button", {
      textContent: "↻", title: "Redo edit", type: "button",
    });
    redo.disabled = !this.canRedoEdit?.();
    redo.addEventListener("click", (e) => { e.stopPropagation(); this.redoEdit(); });
    wrap.append(undo, redo);
    return wrap;
  },

  promptBControls() {
    const wrap = el("div", "krc-prompt-b-controls");
    // The Prompt Input pill is a node-runtime feature (receive a prompt from a
    // workflow run) — meaningless detached, so suppress it in the library modal.
    if (this.surface !== "detached") wrap.append(this.promptInputControl());
    wrap.append(this.promptBAppendButton(), this.promptBSwapButton());
    return wrap;
  },

  promptInputControl() {
    const wrap = el("div", "krc-prompt-input-pill");
    const input = el("button", "krc-inline-action krc-prompt-input-toggle" + (this.promptInputEnabled?.() ? " is-on" : ""), {
      textContent: "INPUT",
      title: "Enable prompt input connector. Use with LLM or other text output nodes.",
      type: "button",
    });
    input.setAttribute("aria-pressed", this.promptInputEnabled?.() ? "true" : "false");
    input.addEventListener("click", () => {
      const next = !this.promptInputEnabled?.();
      this.setPromptInputEnabled?.(next);
      input.classList.toggle("is-on", next);
      input.setAttribute("aria-pressed", next ? "true" : "false");
    });
    const target = this.promptInputTarget?.() || "A";
    const targetBtn = el("button", "krc-inline-action krc-prompt-input-target", {
      textContent: target,
      title: `Prompt input target: Prompt ${target}`,
      type: "button",
    });
    targetBtn.addEventListener("click", () => {
      const next = this.promptInputTarget?.() === "A" ? "B" : "A";
      this.setPromptInputTarget?.(next);
      targetBtn.textContent = next;
      targetBtn.title = `Prompt input target: Prompt ${next}`;
    });
    wrap.append(input, targetBtn);
    return wrap;
  },

  promptBAppendButton() {
    const append = el("button", "krc-inline-action is-append" + (this.draft?.appendPromptB ? " is-on" : ""), {
      textContent: "Append",
      title: this.draft?.appendPromptB ? "Prompt B appends after Prompt A" : "Append Prompt B after Prompt A",
      type: "button",
    });
    append.addEventListener("click", () => {
      if (!this.draft) return;
      this.draft.appendPromptB = !this.draft.appendPromptB;
      this.draftChanged();
      this.syncEditFieldsToDom();   // in place: no thumbnail remount / replay
    });
    return append;
  },

  promptBSwapButton() {
    const swap = el("button", "krc-inline-action", { textContent: "Swap", title: "Swap Prompt A and Prompt B text", type: "button" });
    swap.addEventListener("click", () => this.swapPromptAB());
    return swap;
  },

  swapPromptAB() {
    if (!this.draft) return;
    const a = this.draft.prompt || "";
    this.draft.prompt = this.draft.promptB || "";
    this.draft.promptB = a;
    if (this.promptInputDisableOnSwap?.()) {
      this.setPromptInputEnabled?.(false);
    }
    this.draftChanged();
    // Update the fields in place (as undo / redo does): a panel rebuild would remount the
    // thumbnail, and a video thumbnail would play again.
    this.syncEditFieldsToDom();
  },

  // Prompt A / B split ratio (A's fraction of the shared height), persisted per
  // node. Default 0.645 reproduces the original 1fr : 0.55fr design bias.
  promptSplitRatio() {
    const r = Number(this.node?.properties?.pmPromptSplit);
    return (r > 0.05 && r < 0.95) ? r : 0.645;
  },

  applyPromptSplit() {
    const els = this._pmSplitEls;
    if (!els) return;
    els.right.style.gridTemplateRows = this.promptSplitRows(this.promptSplitRatio());
    this.watchPromptSplit();
  },

  // Layout sizes (offset px: unaffected by canvas zoom) for the A/B split. `total` is
  // what Prompt A + B would share WITHOUT kit preset rows, `extra` the kit rows' height
  // (incl. their gap). The stored ratio always refers to `total`, so turning a kit row
  // on / off never moves the user's split. null before the panel is laid out.
  promptSplitMetrics() {
    const els = this._pmSplitEls;
    if (!els?.right?.isConnected) return null;
    const height = els.right.clientHeight;
    if (!height) return null;
    const cs = getComputedStyle(els.right);
    const gap = parseFloat(cs.rowGap || cs.gap || "0") || 0;
    const llHeight = els.ll?.offsetHeight || 0;
    const stackHeight = els.presets?.offsetHeight || llHeight;
    return {
      total: Math.max(0, height - llHeight - gap * 2),
      extra: Math.max(0, stackHeight - llHeight),
    };
  },

  // grid-template-rows for ratio r. Without kit rows: today's fr split. With them, their
  // height comes out of Prompt A only: B keeps (1 - r) of the no-row total. The fr
  // weights are those target heights, so the free space divides exactly that way (and
  // still scales between re-measures).
  promptSplitRows(r) {
    const plain = `auto minmax(${PROMPT_MIN_PX}px, ${r}fr) minmax(${PROMPT_MIN_PX}px, ${1 - r}fr)`;
    if (!this._pmSplitEls?.kitRows?.length) return plain;
    const m = this.promptSplitMetrics();
    if (!m || !m.total) return plain;
    const a = Math.max(1, r * m.total - m.extra);
    const b = Math.max(1, (1 - r) * m.total);
    return `auto minmax(${PROMPT_MIN_PX}px, ${a}fr) minmax(${PROMPT_MIN_PX}px, ${b}fr)`;
  },

  // Kit rows make the split depend on measured sizes: re-apply it whenever the column
  // or the preset stack resizes (node resize, first layout). One observer per panel.
  watchPromptSplit() {
    this._pmSplitObserver?.disconnect();
    this._pmSplitObserver = null;
    const els = this._pmSplitEls;
    if (!els?.kitRows?.length || typeof ResizeObserver === "undefined") return;
    let last = "";
    const observer = new ResizeObserver(() => {
      if (!els.right.isConnected) {
        observer.disconnect();
        return;
      }
      if (els.right.classList.contains("is-split-dragging")) return;
      const rows = this.promptSplitRows(this.promptSplitRatio());
      if (rows === last) return;
      last = rows;
      els.right.style.gridTemplateRows = rows;
    });
    observer.observe(els.right);
    observer.observe(els.presets);
    this._pmSplitObserver = observer;
  },

  // The subtle draggable line between Prompt A and Prompt B. Dragging adjusts the
  // fr ratio live; the final ratio is persisted on release.
  renderPromptDivider() {
    const divider = el("div", "krc-prompt-divider");
    divider.title = "Drag to resize Prompt A / Prompt B";
    divider.addEventListener("pointerdown", (e) => {
      const els = this._pmSplitEls;
      if (!els) return;
      e.preventDefault();
      e.stopPropagation();
      divider.classList.add("is-dragging");
      divider.setPointerCapture(e.pointerId);

      // Work in layout px (offset sizes); the pointer moves in screen px, so divide by
      // the canvas zoom. With kit rows, `extra` is their height: Prompt A is `extra`
      // shorter than the ratio says, Prompt B exactly as tall (promptSplitRows).
      const m = this.promptSplitMetrics();
      const rightRect = els.right.getBoundingClientRect();
      const scale = (els.right.clientHeight && rightRect.height / els.right.clientHeight) || 1;
      const total = m?.total || 0;
      const extra = els.kitRows?.length ? (m?.extra || 0) : 0;
      const available = total - extra;              // what Prompt A + B share now
      const startAH = els.a.offsetHeight;
      const startY = e.clientY;
      const MIN_PX = PROMPT_MIN_PX;
      let pending = null;
      els.right.classList.add("is-split-dragging");

      const onMove = (ev) => {
        if (available <= MIN_PX * 2) return;
        const na = Math.max(MIN_PX, Math.min(available - MIN_PX, startAH + (ev.clientY - startY) / scale));
        pending = (na + extra) / total;
        els.right.style.gridTemplateRows = this.promptSplitRows(pending);
      };
      const onUp = () => {
        divider.classList.remove("is-dragging");
        els.right.classList.remove("is-split-dragging");
        try { divider.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        divider.removeEventListener("pointermove", onMove);
        divider.removeEventListener("pointerup", onUp);
        if (pending != null) {
          this.node.properties ||= {};
          this.node.properties.pmPromptSplit = pending;
        }
      };
      divider.addEventListener("pointermove", onMove);
      divider.addEventListener("pointerup", onUp);
    });
    return divider;
  },

  textBox(label, value, onInput, { large = false, notes = false, controls = null, middle = null } = {}) {
    const wrap = el("div", "krc-text-field" + (large ? " is-large" : "") + (notes ? " is-notes" : ""));
    const inner = el("div", "krc-prompt-wrap");
    const ta = el("textarea", `krc-textarea ${large ? "krc-prompt" : "krc-description"} has-prompt-controls`);
    ta.value = value || "";
    ta.addEventListener("input", () => { onInput(ta.value); this.draftChanged(); });
    inner.append(ta, this.promptBoxControls(ta, onInput));
    wrap.append(this.fieldHeader(label, controls, middle), inner);
    return wrap;
  },
};
