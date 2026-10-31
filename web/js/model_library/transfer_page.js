/*
 * Import and Export — the KRC Portal's home-menu page on the Info Panel side
 * (info_page.js), UNIFIED_BUNDLE_GAMEPLAN.md: the KRC bundle (Export… / Import… / Undo last
 * import, shared/transfer/bundle_dialogs.js), a history line per bundle section (its last
 * export and import), and the one file outside the bundle, a Word Bank .txt
 * (shared/transfer/kinds.js, with its bank picker).
 *
 * The buttons run with no node, so every open node hears an import. Node Options dialogs
 * carry their own sections' EXPORT / IMPORT (shared/transfer/node_transfer_row.js). The
 * dates come from the server's transfer history (actions from any surface count); they
 * reload when the page opens and after each action here.
 *
 * renderInfo() rebuilds this page on every panel render, so its state (history, picker
 * lists and choices, busy lines) lives on the controller, and loads happen only on open
 * and after actions — never from render.

 */
import { el } from "../shared/dom.js";
import { showToast } from "../shared/toast.js";
import { menuSelect } from "../shared/browser_controls.js";
import { ACTION_EXPORT, ACTION_IMPORT } from "../shared/actions.js";
import { krcIoButton } from "../shared/modal.js";
import { TRANSFER_PICKERS, WORD_BANK_TEXT_KIND, fetchTransferHistory, transferKind } from "../shared/transfer/kinds.js";
import { exportTransfer, importTransfer } from "../shared/transfer/runner.js";
import { agoText, confirmUndoLastImport, fetchUndoInfo, openBundleExport, openBundleImport } from "../shared/transfer/bundle_dialogs.js";
import { bundleSections } from "../shared/transfer/bundle_sections.js";
import { infoPageSection } from "./info_page.js";

export const TRANSFER_PAGE = "transfer";

const IMPORT_MODE_WORDS = {
  merge: "merged",
  overwrite: "overwrote",
};

const DAY_MS = 24 * 60 * 60 * 1000;

// "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", else "Sep 12" (+ year
// when it isn't this year). The exact local time goes in the tooltip.
function relativeDate(ms, now = Date.now()) {
  const diff = Math.max(0, now - ms);
  if (diff < 60 * 1000) return "just now";
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} min ago`;
  const date = new Date(ms);
  const today = new Date(now);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (ms >= startOfToday) return `${Math.floor(diff / 3600000)} h ago`;
  if (ms >= startOfToday - DAY_MS) return "yesterday";
  const days = Math.ceil((startOfToday - ms) / DAY_MS);
  if (days < 7) return `${days} days ago`;
  const options = { month: "short", day: "numeric" };
  if (date.getFullYear() !== today.getFullYear()) options.year = "numeric";
  return date.toLocaleDateString(undefined, options);
}

function dateSpan(prefix, ms, extras) {
  if (!ms) return el("span", "krc-transfer-date is-never", { textContent: `${prefix} never` });
  const note = extras.filter(Boolean).join(", ");
  return el("span", "krc-transfer-date", {
    textContent: `${prefix} ${relativeDate(ms)}${note ? ` (${note})` : ""}`,
    title: new Date(ms).toLocaleString(),
  });
}

export const transferPageMethods = {
  openTransferPage() {
    this.transferState ||= { history: null, choices: {}, picks: {}, busy: new Set() };
    this.openInfoPage(TRANSFER_PAGE);
    this.reloadTransferPage();
  },

  // Fetch the dates and the picker lists, then repaint if the page is still open.
  async reloadTransferPage({ pickers = true } = {}) {
    const state = this.transferState;
    const loads = [
      fetchTransferHistory().then((history) => { state.history = history; }),
      bundleSections().then((sections) => { state.sections = sections; }).catch(() => {}),
      fetchUndoInfo().then((last) => { state.undo = last; }),
    ];
    if (pickers) {
      for (const [picker, source] of Object.entries(TRANSFER_PICKERS)) {
        loads.push(source.load().then((choices) => {
          state.choices[picker] = choices;
          // Drop a choice that no longer exists (renamed / deleted since).
          if (state.picks[picker] && !choices.some(([value]) => value === state.picks[picker])) {
            state.picks[picker] = "";
          }
        }).catch(() => {}));
      }
    }
    await Promise.all(loads);
    if (this.infoPage === TRANSFER_PAGE) this.refreshInfo();
  },

  async runTransferAction(entry, action) {
    const state = this.transferState;
    if (state.busy.has(entry.kind)) return;
    // Only an export holds the line busy (it's a server build + download). An import
    // waits on the file picker and its dialog, which a user may simply abandon.
    if (action === "export") {
      state.busy.add(entry.kind);
      this.refreshInfo();
    }
    let ok = false;
    try {
      if (action === "export") {
        const detail = entry.picker ? state.picks[entry.picker] || "" : "";
        const detailName = entry.picker
          ? (state.choices[entry.picker] || []).find(([value]) => value === detail)?.[1] || detail
          : "";
        ({ ok } = await exportTransfer(entry.kind, { detail, detailName }));
      } else {
        ({ ok } = await importTransfer(entry.kind, { node: this.node || null }));
      }
    } finally {
      state.busy.delete(entry.kind);
    }
    // An import can add a category / bank; an export only moves the date.
    if (ok) await this.reloadTransferPage({ pickers: action === "import" && !!entry.picker });
    else if (this.infoPage === TRANSFER_PAGE) this.refreshInfo();
  },

  transferLine(entry) {
    const state = this.transferState;
    const busy = state.busy.has(entry.kind);
    const line = el("div", `krc-transfer-line${busy ? " is-busy" : ""}`);
    line.dataset.kind = entry.kind;

    const head = el("div", "krc-transfer-line-head");
    const name = el("div", "krc-transfer-line-name");
    name.append(
      el("span", "krc-transfer-line-label", { textContent: entry.label }),
      el("span", "krc-transfer-line-hint", { textContent: entry.hint || "" }),
    );
    head.append(name);

    const controls = el("div", "krc-transfer-line-controls");
    let exportReady = true;
    if (entry.picker) {
      const source = TRANSFER_PICKERS[entry.picker];
      const choices = state.choices[entry.picker] || [];
      const value = state.picks[entry.picker] || "";
      exportReady = !!value;
      const picker = menuSelect({
        className: "krc-transfer-picker",
        title: source.placeholder,
        options: [["", choices.length ? source.placeholder : "None yet"], ...choices],
        value,
        align: "right",
        onChange: (next) => {
          state.picks[entry.picker] = next;
          this.refreshInfo();
        },
      });
      picker.disabled = busy || !choices.length;
      controls.append(picker);
    }
    controls.append(
      krcIoButton({
        action: ACTION_EXPORT,
        title: exportReady ? `Export ${entry.hint || entry.label}` : `Choose a ${entry.picker} to export`,
        disabled: busy || !exportReady,
        onClick: () => this.runTransferAction(entry, "export"),
      }),
      krcIoButton({
        action: ACTION_IMPORT,
        title: `Import ${entry.hint || entry.label}`,
        disabled: busy,
        onClick: () => this.runTransferAction(entry, "import"),
      }),
    );
    head.append(controls);

    const dates = el("div", "krc-transfer-dates");
    const history = state.history;
    if (history === null) {
      dates.append(el("span", "krc-transfer-date is-never", { textContent: "Exported — · Imported —" }));
    } else {
      const record = history[entry.kind] || {};
      dates.append(
        dateSpan("Exported", record.lastExportMs, [record.lastExportDetail ? `"${record.lastExportDetail}"` : ""]),
        el("span", "krc-transfer-date-sep", { textContent: "·" }),
        dateSpan("Imported", record.lastImportMs, [
          record.lastImportDetail ? `"${record.lastImportDetail}"` : "",
          IMPORT_MODE_WORDS[record.lastImportMode] || "",
        ]),
      );
    }

    line.append(head, dates);
    return line;
  },

  // The KRC bundle card: Export… / Import… and Undo last import.
  bundleCard() {
    const card = el("div", "krc-transfer-line krc-transfer-bundle");
    const head = el("div", "krc-transfer-line-head");
    const name = el("div", "krc-transfer-line-name");
    name.append(
      el("span", "krc-transfer-line-label", { textContent: "KRC bundle" }),
      el("span", "krc-transfer-line-hint", { textContent: "Any mix of libraries, presets and prompts in one .zip (or drop one here)" }),
    );
    const controls = el("div", "krc-transfer-line-controls");
    controls.append(
      krcIoButton({
        action: ACTION_EXPORT,
        title: "Choose what to export",
        onClick: async () => { await openBundleExport({ node: this.node || null }); this.reloadTransferPage({ pickers: false }); },
      }),
      krcIoButton({
        action: ACTION_IMPORT,
        title: "Choose a bundle to import",
        onClick: async () => {
          const { ok } = await openBundleImport({ node: this.node || null });
          if (ok) this.reloadTransferPage();
        },
      }),
    );
    head.append(name, controls);

    // The last import that can be undone (one level), or "Nothing to undo".
    const last = this.transferState.undo;
    const undo = el("div", "krc-transfer-undo");
    const undoButton = el("button", "krc-options-reset", { type: "button", textContent: "Undo last import" });
    undoButton.disabled = !last;
    undoButton.addEventListener("click", async () => {
      const { ok } = await confirmUndoLastImport({ node: this.node || null });
      if (ok) this.reloadTransferPage();
    });
    undo.append(
      el("span", `krc-transfer-date${last ? "" : " is-never"}`, {
        textContent: last ? `Last import: "${last.fileName || "a bundle"}", ${agoText(last.createdMs)}` : "Nothing to undo",
        title: last ? new Date(last.createdMs).toLocaleString() : "",
      }),
      undoButton,
    );
    card.append(head, undo);
    return card;
  },

  // One line per section: its last export and import.
  sectionHistoryLine(section) {
    const line = el("div", "krc-transfer-line krc-transfer-history-line");
    const record = this.transferState.history?.[section.id] || {};
    const dates = el("div", "krc-transfer-dates");
    if (this.transferState.history === null) {
      dates.append(el("span", "krc-transfer-date is-never", { textContent: "Exported — · Imported —" }));
    } else {
      dates.append(
        dateSpan("Exported", record.lastExportMs, []),
        el("span", "krc-transfer-date-sep", { textContent: "·" }),
        dateSpan("Imported", record.lastImportMs, [IMPORT_MODE_WORDS[record.lastImportMode] || ""]),
      );
    }
    line.append(el("span", "krc-transfer-line-label", { textContent: section.label }), dates);
    return line;
  },

  // Drop a KRC bundle (.zip) anywhere on the page to import it (only file drags count, so a
  // card dragged across the Portal is ignored).
  installBundleDrop(panel) {
    const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");
    let depth = 0;
    panel.addEventListener("dragenter", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      panel.classList.add("is-bundle-drop");
    });
    panel.addEventListener("dragover", (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    });
    panel.addEventListener("dragleave", (event) => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) panel.classList.remove("is-bundle-drop");
    });
    panel.addEventListener("drop", async (event) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.stopPropagation();
      depth = 0;
      panel.classList.remove("is-bundle-drop");
      const file = Array.from(event.dataTransfer.files || []).find((item) => /\.zip$/i.test(item.name));
      if (!file) {
        showToast("Drop a KRC bundle (.zip) to import it.");
        return;
      }
      const { ok } = await openBundleImport({ node: this.node || null, file });
      if (ok) this.reloadTransferPage();
    });
  },

  renderTransferPage() {
    this.transferState ||= { history: null, choices: {}, picks: {}, busy: new Set() };
    const { panel, body } = this.infoPageShell("Import and Export", "krc-transfer-page");
    this.installBundleDrop(panel);
    body.classList.add("krc-options-host"); // the shared Undo button style
    body.append(
      infoPageSection("", this.bundleCard()),
      infoPageSection("History", (this.transferState.sections || []).map((section) => this.sectionHistoryLine(section))),
      infoPageSection("Word Bank", this.transferLine(transferKind(WORD_BANK_TEXT_KIND))),
    );
    return panel;
  },
};
