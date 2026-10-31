// KRC Word Bank — row factory, category dropdowns, occurrence handles, and row actions.

import { el } from "../shared/dom.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { copyText } from "../shared/clipboard.js";
import { I_RAND, I_ULOCK, I_LOCK } from "./constants.js";
import {
  randomWord,
  fetchBankNames,
  fetchBankEntries,
  insertBankEntry,
  removeBankEntry,
} from "./api.js";
import { loadState, saveState } from "./state.js";
import { resizeNode } from "./layout.js";
import { promptCreateBank } from "./options_modal.js";
import { krcAlert } from "../shared/modal.js";

const CREATE_BANK_VALUE = "__krc_create_bank__";

function formatToken(label, syntax = "angle") {
  if (syntax === "brace") return `{{${label}}}`;
  if (syntax === "bracket") return `[[${label}]]`;
  return `<${label}>`;
}

function tokenLabel(category, occ = 1) {
  const label = String(category || "").replace(/_/g, " ");
  return occ >= 2 ? `${label}#${occ}` : label;
}

function bankId(bank) {
  return typeof bank === "string" ? bank : String(bank?.id || "");
}

function bankName(bank) {
  return typeof bank === "string" ? bank : String(bank?.name || "");
}

function findBank(banks, ref) {
  const value = String(ref || "");
  if (!value) return null;
  return (banks || []).find(bank => bankId(bank) === value || bankName(bank) === value) || null;
}

// A row's bank picker (shared searchable select; replaced the native <select>). It is
// kept on the row element, so anything holding a row reads `rowBank(row).value`.
export function rowBank(row) {
  return row?._wbBank || null;
}

export function createRowControls({
  node,
  rowsEl,
  getBanks,
  setBanks,
  getPresetControls,
}) {
  const updateModified = () => getPresetControls()?.updateModified?.();

  // Fill a row's bank picker from the current bank list, selecting `selected` (or none
  // if that bank is gone). A reused bank's selected entry carries its #N handle as a
  // badge, so the closed field reads `name #N` and the list keeps plain names.
  function fillBankOptions(row, selected) {
    const picker = rowBank(row);
    if (!picker) return;
    const banks = getBanks();
    const selectedBank = findBank(banks, selected);
    const value = selectedBank ? bankId(selectedBank) : "";
    const occ = parseInt(row.dataset.occ, 10);
    picker.setOptions([
      { name: "— none —", value: "", muted: true },
      ...banks.map((bank) => ({
        name: bankName(bank),
        value: bankId(bank),
        badge: bankId(bank) === value && occ >= 2 ? `#${occ}` : "",
      })),
      { name: "+ create bank...", value: CREATE_BANK_VALUE },
    ], value);
  }

  // The selected bank's display name ("" for none).
  function rowBankName(row) {
    return bankName(findBank(getBanks(), rowBank(row)?.value)) || "";
  }

  function rebuildRowCategories({ oldId = "", newId = "", deletedId = "" } = {}) {
    for (const row of rowsEl.children) {
      const picker = rowBank(row);
      if (!picker) continue;
      let cur = picker.value;
      if (oldId && newId && cur === oldId) cur = newId;
      if (deletedId && cur === deletedId) cur = "";
      fillBankOptions(row, cur);
      checkMissing(row);
    }
    reassignOcc();   // a bank going missing can free/collide occ numbers
    const s = loadState(node); s.rows = rowsFromDOM(); saveState(node, s);
  }

  // Rows reusing the same bank get a stable per-row occurrence number so a
  // prompt can address each draw separately: occ 1 -> <category>, occ >= 2 ->
  // <category#N>. Existing rows keep their number; a row needing one claims the
  // smallest free integer for its category (so a freed slot is reused). Numbers
  // never renumber on delete/reorder, keeping prompt handles deterministic.
  function reassignOcc() {
    const used = new Map();   // category -> Set of occ numbers already taken
    for (const r of rowsEl.children) {
      const cat = rowBank(r)?.value ?? "";
      if (!cat) { r.dataset.occ = ""; updateRowHandle(r); continue; }
      if (!used.has(cat)) used.set(cat, new Set());
      const taken = used.get(cat);
      let occ = parseInt(r.dataset.occ, 10);
      if (!Number.isInteger(occ) || occ < 1 || taken.has(occ)) {
        occ = 1;
        while (taken.has(occ)) occ += 1;
      }
      taken.add(occ);
      r.dataset.occ = String(occ);
      updateRowHandle(r);
    }
  }

  // Refresh a row's handle: the closed-field #N display and the copy button's
  // <...>-wrapped clipboard token (bare name for occ 1, name#N for duplicates).
  function updateRowHandle(row) {
    fillBankOptions(row, rowBank(row)?.value);
    const btn = row.querySelector(".wb-copy");
    if (!btn) return;
    const cat = rowBank(row)?.value ?? "";
    const name = rowBankName(row);
    const occ = parseInt(row.dataset.occ, 10);
    if (!cat) {
      btn.dataset.token = "";
      btn.disabled = true;
      btn.title = "Pick a bank to copy its <placeholder>";
      return;
    }
    const label = tokenLabel(name, occ);
    const token = formatToken(label, loadState(node).tokenSyntax);
    btn.disabled = false;
    btn.dataset.token = token;
    btn.title = `Copy ${token}`;
  }

  async function checkMissing(row) {
    const picker = rowBank(row);
    const inp = row.querySelector("input[type=text]");
    const addWordBtn = row.querySelector(".wb-word-add");
    if (!picker || !inp) return;
    const category = picker.value;
    const value = inp.value.trim();
    const token = `${category}\n${value}`;
    row.dataset.missingCheck = token;
    if (!category || !value || category === CREATE_BANK_VALUE) {
      row.classList.remove("missing-word");
      addWordBtn?.classList.remove("is-added");
      inp.title = "";
      return;
    }
    const entries = await fetchBankEntries(category);
    if (row.dataset.missingCheck !== token) return;
    const exists = entries.some(item => String(item).trim().toLowerCase() === value.toLowerCase());
    row.classList.toggle("missing-word", !exists);
    addWordBtn?.classList.toggle("is-added", exists);
    inp.title = exists ? "" : "Not in selected word bank. Press + to insert it.";
  }

  function clearMissing(row) {
    const inp = row.querySelector("input[type=text]");
    const addWordBtn = row.querySelector(".wb-word-add");
    row.classList.remove("missing-word");
    addWordBtn?.classList.remove("is-added");
    if (inp) inp.title = "";
  }

  function makeRow({ category = "", categoryId = "", value = "", locked = false, occ = "" } = {}) {
    const row = el("div", "wb-row" + (locked ? " locked" : ""));
    if (occ !== "" && occ != null) row.dataset.occ = String(occ);

    const knownBank = findBank(getBanks(), categoryId || category);
    const sel = createSearchableSelect({
      placeholder: "— none —",
      searchPlaceholder: "Search banks...",
      emptyText: "No banks found.",
      buttonTitle: "Word bank",
      ariaLabel: "Word bank",
      fixedMenu: true,
      menuWidth: 220,
      onSelect: () => onBankSelected(),
    });
    sel.el.classList.add("wb-cat");
    row._wbBank = sel;
    // Unknown/missing category (e.g. a preset referencing a deleted bank) ->
    // fall back to none and blank the value; keep the row itself.
    fillBankOptions(row, knownBank ? categoryId || category : "");
    if (!knownBank) value = "";

    // Single-glyph copy button (shared krc-copy-button design), between the bank
    // dropdown and value. Puts the row's <placeholder> handle on the clipboard so
    // the user can paste the exact syntax, including the #N, into a prompt.
    const copyBtn = el("button", "krc-icon-button krc-copy-button wb-copy", {
      type: "button", textContent: "⧉",
    });
    copyBtn.addEventListener("click", async () => {
      const token = copyBtn.dataset.token;
      if (!token) return;
      if (await copyText(token)) {
        const prev = copyBtn.title;
        copyBtn.title = "Copied!";
        setTimeout(() => { copyBtn.title = prev; }, 900);
      }
    });

    const valInp = el("input", "wb-val");
    valInp.type = "text"; valInp.value = value; valInp.placeholder = "— pick or type —";

    const addWordBtn = el("button", "wb-btn wb-word-add"); addWordBtn.title = "Insert into word bank"; addWordBtn.textContent = "+";
    const delWordBtn = el("button", "wb-btn wb-word-remove"); delWordBtn.title = "Remove from word bank"; delWordBtn.textContent = "-";
    const rBtn = el("button", "wb-btn"); rBtn.title = "Randomize"; rBtn.innerHTML = I_RAND;
    const lBtn = el("button", "wb-btn" + (locked ? " lk" : ""));
    lBtn.title = locked ? "Locked" : "Unlocked"; lBtn.innerHTML = locked ? I_LOCK : I_ULOCK;
    const xBtn = el("button", "wb-btn rm"); xBtn.title = "Remove"; xBtn.textContent = "✕";

    row.append(sel.el, copyBtn, valInp, addWordBtn, delWordBtn, rBtn, lBtn, xBtn);

    const commit = ({ check = true } = {}) => {
      const s = loadState(node);
      s.rows = rowsFromDOM();
      saveState(node, s);
      updateModified();
      if (check) checkMissing(row);
    };

    // Only a category change can alter occ numbering, so renumber here, never on
    // value keystrokes. The change releases this row's old occ so it re-claims a
    // fresh (smallest-free) number for the newly selected bank.
    async function onBankSelected() {
      if (sel.value === CREATE_BANK_VALUE) {
        const fallback = valInp.value.trim().replace(/\s+/g, "_").slice(0, 32);
        const created = await promptCreateBank(fallback, { node });
        setBanks(await fetchBankNames(true));
        rebuildRowCategories();
        fillBankOptions(row, created?.id || "");
        if (created?.id && valInp.value.trim()) await insertBankEntry(created.id, valInp.value.trim());
      }
      row.dataset.occ = "";
      reassignOcc();
      commit();
    }
    valInp.addEventListener("input", commit);

    rBtn.addEventListener("click", async () => {
      valInp.value = await randomWord(sel.value, valInp.value);
      commit({ check: false });
      await checkMissing(row);
    });

    addWordBtn.addEventListener("click", async () => {
      const value = valInp.value.trim();
      if (!value) return;
      let category = sel.value;
      if (!category) {
        const created = await promptCreateBank(value.replace(/\s+/g, "_").slice(0, 32), { node });
        category = created?.id || "";
        if (!category) return;
        setBanks(await fetchBankNames(true));
        rebuildRowCategories();
        fillBankOptions(row, category);
        row.dataset.occ = "";
        reassignOcc();
        commit();
      }
      const res = await insertBankEntry(category, value);
      if (!res?.ok) { krcAlert(res?.error || "Could not insert word.", node); return; }
      await checkMissing(row);
    });

    armConfirmButton(delWordBtn, {
      armedText: "-",
      armedTitle: "Click again to remove from bank",
      restoreText: "-",
      restoreTitle: "Remove from word bank",
      onConfirm: async () => {
        const value = valInp.value.trim();
        const category = sel.value;
        if (!category || !value) return;
        const res = await removeBankEntry(category, value);
        if (!res?.ok) { krcAlert(res?.error || "Could not remove word.", node); return; }
        if (res.removed) valInp.value = "";
        commit();
        await checkMissing(row);
      },
    });

    lBtn.addEventListener("click", () => {
      const lk = row.classList.toggle("locked");
      lBtn.classList.toggle("lk", lk);
      lBtn.innerHTML = lk ? I_LOCK : I_ULOCK;
      lBtn.title = lk ? "Locked" : "Unlocked";
      commit();
    });

    armConfirmButton(xBtn, {
      armedText: "✕",
      armedTitle: "Click again to remove",
      restoreText: "✕",
      restoreTitle: "Remove",
      onConfirm: () => {
        row.remove();
        const s = loadState(node);
        s.rows = rowsFromDOM();
        saveState(node, s);
        resizeNode(node, rowsEl.children.length);
        updateModified();
      },
    });

    checkMissing(row);
    return row;
  }

  function rowsFromDOM() {
    return [...rowsEl.children].map(r => ({
      categoryId: rowBank(r)?.value ?? "",
      category: rowBankName(r),
      value:    r.querySelector("input[type=text]")?.value ?? "",
      locked:   r.classList.contains("locked"),
      occ:      parseInt(r.dataset.occ, 10) || 1,
    }));
  }

  function restoreRows(rows) {
    for (const rd of rows) rowsEl.appendChild(makeRow(rd));
    reassignOcc();   // number restored rows (assigns occ to legacy state, fills gaps)
  }

  function addRow() {
    rowsEl.appendChild(makeRow());   // new rows start at "-- none --"
    reassignOcc();
    const s = loadState(node); s.rows = rowsFromDOM();
    saveState(node, s);
    resizeNode(node, rowsEl.children.length);
    updateModified();
  }

  async function randomizeAll() {
    const unlocked = [...rowsEl.children].filter(r => !r.classList.contains("locked"));
    await Promise.all(unlocked.map(async r => {
      const picker = rowBank(r);
      const i = r.querySelector("input[type=text]");
      if (picker && i) {
        i.value = await randomWord(picker.value, i.value);
        clearMissing(r);
      }
    }));
    const s = loadState(node); s.rows = rowsFromDOM();
    saveState(node, s);
    updateModified();
  }

  return {
    makeRow,
    reassignOcc,
    rebuildRowCategories,
    rowsFromDOM,
    restoreRows,
    addRow,
    randomizeAll,
  };
}
