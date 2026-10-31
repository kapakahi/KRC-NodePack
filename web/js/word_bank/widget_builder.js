// KRC Word Bank — DOM widget builder.
// Builds the full node UI (preset row + preset actions on top, field rows
// in the middle, and the add/randomize/auto/options row at the bottom) into
// `wrap` and wires all interaction back into node state + the preset store.
// Sets node._wbGetRows so the entry file can flush row DOM before serialise.

import { el } from "../shared/dom.js";
import { applyNodePalette } from "../shared/node_palette.js";
import { I_RAND } from "./constants.js";
import { loadState, saveState } from "./state.js";
import { createPresetControls } from "./preset_controls.js";
import { openWordBankOptionsModal } from "./options_modal.js";
import { createRowControls } from "./row_controls.js";
import { clearBankEntryCache, fetchBankNames } from "./api.js";
import { KRC_SYNC_EVENTS, isOwnSyncEvent, subscribeKrcSync } from "../shared/sync_bus.js";

export function populateWidget(node, wrap, bankNames) {
  wrap.innerHTML = "";

  // Mutable working copy — grows when the user imports .txt banks at runtime.
  let banks = Array.isArray(bankNames) ? bankNames.slice() : [];
  const setBanks = (nextBanks) => {
    banks = Array.isArray(nextBanks) ? nextBanks : [];
    return banks;
  };

  const state = loadState(node);

  // Restore any saved per-node palette onto the root.
  applyNodePalette(node, wrap);

  // ── field rows ──
  const rowsEl = el("div", "wb-rows");

  let presetControls;
  const rowControls = createRowControls({
    node,
    rowsEl,
    getBanks: () => banks,
    setBanks,
    getPresetControls: () => presetControls,
  });

  presetControls = createPresetControls({
    node,
    rowsEl,
    makeRow: rowControls.makeRow,
    reassignOcc: rowControls.reassignOcc,
    rowsFromDOM: rowControls.rowsFromDOM,
  });

  wrap.append(presetControls.presetRow, presetControls.presetActions);
  wrap.appendChild(rowsEl);

  // ── bottom action row: add · randomize · auto (equal width) + ⚙ (far right) ──
  const bottomRow = el("div", "wb-bottom-row");
  const addBtn  = el("button", "wb-add"); addBtn.textContent = "+ add field";
  const rallBtn = el("button", "wb-rall"); rallBtn.innerHTML = I_RAND + " randomize all";
  const autoBtn = el("button", "wb-auto-btn" + (state.autoSeed ? " active" : ""));
  autoBtn.textContent = "Auto Randomize";

  const optionsBtn  = el("button", "wb-options-btn");
  optionsBtn.append(el("span", "krc-gear-glyph"));
  optionsBtn.title = "Options";
  optionsBtn.setAttribute("aria-label", "Options");

  bottomRow.append(addBtn, rallBtn, autoBtn, optionsBtn);
  wrap.appendChild(bottomRow);

  node.__wbStats = {
    banks: () => banks,
    presetCache: [],
    rowsFromDOM: rowControls.rowsFromDOM,
  };

  // ── options modal (⚙): node-unique .txt import + shared EXPORT / IMPORT ──
  optionsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openWordBankOptionsModal({
      node,
      root: wrap,
      getBanks: () => banks,
      setBanks,
      rebuildRowCategories: rowControls.rebuildRowCategories,
      presetControls,
      refreshRowHandles: rowControls.reassignOcc,
    });
  });

  // ── restore saved rows ──
  rowControls.restoreRows(state.rows);

  // ── another node (or the KRC Portal) created / renamed / deleted / imported banks:
  // refetch the list and rebuild this node's pickers, following a rename's id change
  // and clearing a deleted bank. Re-populating the widget replaces the subscription. ──
  node._wbUnsubscribeBanks?.();
  node._wbUnsubscribeBanks = subscribeKrcSync(KRC_SYNC_EVENTS.WORDBANK_BANKS_CHANGED, async (event) => {
    if (isOwnSyncEvent(event, node?.id)) return;
    const { oldId = "", newId = "", deletedId = "" } = event?.detail || {};
    clearBankEntryCache();
    setBanks(await fetchBankNames(true));
    rowControls.rebuildRowCategories({ oldId, newId, deletedId });
  });
  if (!node._wbBanksCleanupHooked) {
    node._wbBanksCleanupHooked = true;
    const prevOnRemoved = node.onRemoved;
    node.onRemoved = function () {
      node._wbUnsubscribeBanks?.();
      node._wbUnsubscribeBanks = null;
      return prevOnRemoved ? prevOnRemoved.apply(this, arguments) : undefined;
    };
  }

  // ── auto-randomize toggle ──
  autoBtn.addEventListener("click", () => {
    const s = loadState(node); s.autoSeed = !s.autoSeed;
    autoBtn.classList.toggle("active", s.autoSeed);
    saveState(node, s);
  });

  // ── add row ──
  addBtn.addEventListener("click", () => rowControls.addRow());

  // ── randomize all (unlocked) ──
  rallBtn.addEventListener("click", () => rowControls.randomizeAll());

  // ── pre-serialize hook ──
  node._wbGetRows = rowControls.rowsFromDOM;

  // ── populate the preset dropdown from the server, restoring the saved
  // selection (dropdown only — rows already came from node state, so a
  // modified-but-unsaved set stays put and the Modified badge is accurate) ──
  presetControls.reloadPresets(loadState(node).activePresetId || "");
}
