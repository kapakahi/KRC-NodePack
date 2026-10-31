// KRC Word Bank — Options modal, word-bank management, and import/export tools.

import { menuSelect } from "../shared/browser_controls.js";
import { el } from "../shared/dom.js";
import { openKrcModal, krcAlert } from "../shared/modal.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { buildNodePaletteField } from "../shared/node_palette.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES } from "../shared/sync_bus.js";
import { exportTransfer, importTransfer } from "../shared/transfer/runner.js";
import { nodeTransferRow } from "../shared/transfer/node_transfer_row.js";
import { openTextEntryDialog } from "../shared/text_entry.js";
import { loadState, saveState } from "./state.js";
import {
  clearBankEntryCache,
  fetchBankNames,
  createBank,
  renameBank,
  deleteBank,
} from "./api.js";

function makeModalButton(label, title, onClick, className = "") {
  const btn = el("button", `wb-modal-btn ${className}`.trim(), { type: "button", textContent: label });
  if (title) btn.title = title;
  btn.addEventListener("click", onClick);
  return btn;
}

export async function promptCreateBank(defaultName = "", { node = null } = {}) {
  const raw = await openTextEntryDialog({
    node,
    title: "New word bank",
    label: "Word bank",
    value: defaultName,
    placeholder: "word bank name",
    confirmTitle: "Create word bank",
  });
  if (!raw) return "";
  const result = await createBank(raw, { source: node?.id });
  if (!result?.ok || !result.id) {
    krcAlert(result?.error || "Could not create word bank.", node);
    return null;
  }
  return result;
}

function bankId(bank) {
  return typeof bank === "string" ? bank : String(bank?.id || "");
}

function bankName(bank) {
  return typeof bank === "string" ? bank : String(bank?.name || "");
}

export function openWordBankOptionsModal({
  node,
  root,
  getBanks,
  setBanks,
  rebuildRowCategories,
  presetControls,
  refreshRowHandles,
}) {
  const body = el("div", "wb-options-panel");
  const bankSection = el("section", "wb-options-section");
  bankSection.appendChild(el("div", "wb-options-title", { textContent: "Word Banks" }));

  const bankSelect = menuSelect({
    className: "krc-modal-select",
    title: "Word bank",
    onChange: () => refreshModalButtons(),
  });
  const refillBankSelect = (value = bankSelect.value || "") => {
    const banks = getBanks();
    bankSelect.setOptions(
      [["", "— select bank —"], ...banks.map((bank) => [bankId(bank), bankName(bank)])],
      banks.some(bank => bankId(bank) === value) ? value : "",
    );
    refreshModalButtons();
  };

  const refreshBanksEverywhere = async ({ select = "", oldId = "", newId = "", deletedId = "" } = {}) => {
    setBanks(await fetchBankNames(true));
    rebuildRowCategories({ oldId, newId, deletedId });
    refillBankSelect(select || newId || "");
  };

  const createBtn = makeModalButton("Create", "Create a new empty word bank", async () => {
    const name = await promptCreateBank("", { node });
    if (!name) return;
    await refreshBanksEverywhere({ select: name.id });
  });
  const renameBtn = makeModalButton("Rename", "Rename selected word bank", async () => {
    const oldId = bankSelect.value;
    const oldName = bankSelect.selectedLabel;
    if (!oldId) return;
    const next = await openTextEntryDialog({
      node,
      title: "Rename word bank",
      label: "Word bank",
      value: oldName,
      placeholder: "word bank name",
      confirmTitle: "Rename word bank",
      validate: (candidate) => (
        getBanks().some(bank => bankId(bank) !== oldId && bankName(bank) === candidate) ? "A word bank with that name already exists." : ""
      ),
    });
    if (!next || next === oldName) return;
    const res = await renameBank(oldId, next, { source: node?.id });
    if (!res?.ok) { krcAlert(res?.error || "Could not rename word bank.", node); return; }
    await presetControls.reloadPresets(presetControls.value());
    presetControls.broadcastPresetsChanged(KRC_SYNC_LANES.STRUCTURE);
    await refreshBanksEverywhere({ oldId, newId: res.id, select: res.id });
  });
  const deleteBtn = makeModalButton("Delete", "Delete selected word bank", async () => {
    // armConfirmButton replaces this click handler below.
  }, "is-delete");
  const importBtn = makeModalButton("Import .txt", "Add word banks from .txt files", () => doImportTxt(() => refreshBanksEverywhere({ select: bankSelect.value })));
  const exportBtn = makeModalButton("Export .txt", "Download selected word bank as a raw text file", () => {
    const id = bankSelect.value;
    if (!id) return;
    exportTransfer("word_bank.bank", { detail: id, detailName: bankSelect.selectedLabel || id });
  });

  function refreshModalButtons() {
    const has = !!bankSelect.value;
    renameBtn.disabled = deleteBtn.disabled = exportBtn.disabled = !has;
  }
  armConfirmButton(deleteBtn, {
    restoreText: "Delete",
    restoreTitle: "Delete selected word bank",
    onConfirm: async () => {
      const id = bankSelect.value;
      if (!id) return;
      const ok = await deleteBank(id, { source: node?.id });
      if (!ok) { krcAlert("Could not delete word bank.", node); return; }
      await refreshBanksEverywhere({ deletedId: id, select: "" });
    },
  });

  const bankActions = el("div", "wb-options-grid");
  bankActions.append(createBtn, renameBtn, deleteBtn, importBtn, exportBtn);
  bankSection.append(bankSelect, bankActions);

  // Banks + presets as a KRC bundle section; single .txt banks stay in the bank actions above.
  const bundleSection = el("section", "wb-options-section");
  bundleSection.appendChild(nodeTransferRow({ node, sections: ["word_bank"], label: "word banks and presets",
    onImported: () => reloadBanks() }));

  const tokenSection = el("section", "wb-options-section");
  tokenSection.appendChild(el("div", "wb-options-title", { textContent: "Tags" }));
  const tokenSelect = menuSelect({
    className: "krc-modal-select",
    title: "Token syntax used by copy buttons and Word Bank replacement.",
    value: loadState(node).tokenSyntax || "angle",
    options: [
      ["angle", "<Lighting Style>"],
      ["brace", "{{Lighting Style}}"],
      ["bracket", "[[camera angle]]"],
    ],
    onChange: (value) => {
      const s = loadState(node);
      s.tokenSyntax = value || "angle";
      saveState(node, s);
      refreshRowHandles?.();
    },
  });
  tokenSection.append(tokenSelect);

  const appearanceSection = el("section", "wb-options-section");
  appearanceSection.appendChild(el("div", "wb-options-title", { textContent: "Appearance" }));
  appearanceSection.appendChild(buildNodePaletteField({ node, root }));

  body.append(bankSection, bundleSection, tokenSection, appearanceSection);
  openKrcModal({
    node,
    title: "Word Bank options",
    body,
    width: 520,
  });
  refillBankSelect();

  // .txt import / export run through the shared runner (shared/transfer/), the same flow
  // the KRC Portal's Import and Export page uses. It broadcasts the banks change to
  // sibling Word Bank nodes (this node's echo is skipped) and shows the skipped-files
  // summary; this node refreshes itself here.
  const transferOptions = {
    node,
    sources: { [KRC_SYNC_EVENTS.WORDBANK_BANKS_CHANGED]: node?.id },
  };

  async function reloadBanks() {
    clearBankEntryCache();
    setBanks(await fetchBankNames(true));   // force refresh past the cache
    rebuildRowCategories();
  }

  async function doImportTxt(afterImport = null) {
    const { ok, result } = await importTransfer("word_bank.bank", transferOptions);
    if (!ok) return;
    await reloadBanks();
    await afterImport?.(result);
  }
}
