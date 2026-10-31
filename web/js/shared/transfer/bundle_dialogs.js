/*
 * The KRC bundle's Export and Import dialogs (UNIFIED_BUNDLE_GAMEPLAN.md).
 *
 * Export: a checklist of sections (with counts), a category / bank subset where a section
 * has one, Include linked presets -> one file. Import: pick a file, see what's inside (all
 * ticked), Merge / Overwrite + Keep history, Preview, Import -> a result toast with Undo.
 *
 * Export: POST /krc/bundle/export -> one .zip. Import: the file uploads once
 * (POST /krc/bundle/upload -> a token + the bundle's sections), then Preview / Import send
 * only the token; closing the dialog without importing discards the upload. Every import
 * can be undone (one level): the result toast's Undo and the Portal's Undo last import
 * (confirmUndoLastImport) say what it will put back first.
 */
import { el } from "../dom.js";
import { switchToggle } from "../browser_controls.js";
import { api } from "../../../../scripts/api.js";
import { jsonBodyInit } from "../api.js";
import { krcAlert, krcModalSection, openKrcConfirm, openKrcModal } from "../modal.js";
import { dateStamp, downloadResponseBlob } from "../persistence.js";
import { showToast } from "../toast.js";
import { TRANSFER_PICKERS } from "./kinds.js";
import { pickFiles, publishTransferEvents } from "./runner.js";
import { bundleCountText, bundleSections, countText, knownSections, mergedSectionEvents } from "./bundle_sections.js";

import { loadProfiles, profileControl, profileSnapshot, profileName } from "../../prompt_vault/profiles.js";
import { promptImportControls, transferProfileId } from "../../prompt_vault/profile_transfer.js";

const MODES = [
  { id: "merge", label: "Merge", desc: "Adds what's new and fills only empty fields; your existing edits are kept." },
  { id: "overwrite", label: "Overwrite", danger: true, desc: "What's in the bundle replaces the matching items here." },
];

// A bare switch (its label sits at the row's left) whose state lives in `state[key]`;
// `onChange` after each flip.
function stateSwitch(label, state, key, { title = label, onChange } = {}) {
  return switchToggle({
    active: !!state[key],
    title,
    onClick: (event) => {
      state[key] = !state[key];
      event.currentTarget?.classList.toggle("is-on", state[key]);
      onChange?.();
    },
  });
}

// One custom check item (no native checkbox): a ✓ box + label.
function checkItem(label, checked, onToggle) {
  const item = el("button", `krc-bundle-check${checked ? " is-checked" : ""}`, { type: "button", title: label });
  item.append(el("span", "krc-bundle-check-box", { textContent: checked ? "✓" : "" }), el("span", "krc-bundle-check-label", { textContent: label }));
  item.addEventListener("click", onToggle);
  return item;
}

// Clicking a row's label flips its switch, like a label for a checkbox.
function labelFlips(target, toggle) {
  target.classList.add("is-clickable");
  target.addEventListener("click", () => toggle.click());
}

// A section's line: label + hint on the left, then its count and its switch on the
// right; (export only) its subset picker under it. A `disabled` line (a bundle
// section this machine can't import) shows no switch.
function sectionLine(section, picked, { onChange, subset = null, count = null, hint = null, disabled = false } = {}) {
  const line = el("div", `krc-bundle-section${picked[section.id] && !disabled ? "" : " is-off"}${disabled ? " is-disabled" : ""}`);
  const head = el("div", "krc-bundle-section-head");
  const name = el("div", "krc-bundle-section-name");
  name.append(
    el("span", "krc-bundle-section-label", { textContent: section.label }),
    el("span", "krc-bundle-section-hint", { textContent: hint ?? section.hint ?? "" }),
  );
  head.append(name, el("span", "krc-bundle-section-count", { textContent: count ?? countText(section) }));
  if (!disabled) {
    const toggle = stateSwitch(section.label, picked, section.id, { title: section.hint || section.label, onChange });
    labelFlips(name, toggle);
    head.append(toggle);
  }
  line.append(head);
  if (subset && picked[section.id]) line.append(subset.render());
  return line;
}

// The subset list for a section with a picker (Prompt Vault categories, Word Bank banks):
// "All" or a chosen few. `choices` = [[value, label]].
function subsetPicker(section, choices, chosen, rerender) {
  const noun = section.picker === "category" ? "categories" : "banks";
  return {
    render() {
      const list = el("div", "krc-bundle-subset");
      list.append(checkItem(`All ${noun}`, chosen.all, () => { chosen.all = !chosen.all; rerender(); }));
      if (!chosen.all) {
        if (!choices.length) list.append(el("span", "krc-bundle-subset-empty", { textContent: `No ${noun} yet` }));
        for (const [value, label] of choices) {
          list.append(checkItem(label, chosen.items.has(value), () => {
            if (chosen.items.has(value)) chosen.items.delete(value);
            else chosen.items.add(value);
            rerender();
          }));
        }
      }
      return list;
    },
  };
}

function exportReady(sections, picked, subsets) {
  return sections.some((section) => picked[section.id]
    && (!subsets[section.id] || subsets[section.id].all || subsets[section.id].items.size));
}

// The Export dialog. `only` = section ids to tick (a node's own Export); default all.
// `picks` = { section id: [item values] } to start a subset with (a Prompt Vault category).
// -> { ok } once the dialog closes (ok = a bundle downloaded).
export async function openBundleExport({ node = null, only = null, picks = null, promptProfile = null } = {}) {
  await loadProfiles({ force: true });
  const sections = await bundleSections();
  const picked = Object.fromEntries(sections.map((section) => [section.id, !only || only.includes(section.id)]));
  const options = { includeLinked: true, promptProfile: transferProfileId(promptProfile) };
  const subsets = {};
  const choices = {};
  await Promise.all(sections.filter((section) => section.picker).map(async (section) => {
    const start = picks?.[section.id];
    subsets[section.id] = { all: !start?.length, items: new Set(start || []) };
    choices[section.id] = await TRANSFER_PICKERS[section.picker].load(section.id === "prompt_vault" ? options.promptProfile : undefined).catch(() => []);
  }));

  const list = el("div", "krc-bundle-sections");
  let exported = false;
  let done;
  const closed = new Promise((resolve) => { done = resolve; });
  const exportAction = {
    label: "Export",
    primary: true,
    onClick: async ({ close, btn }) => {
      btn.disabled = true;
      btn.textContent = "Exporting…";
      const ok = await runBundleExport(sections, picked, subsets, options, node);
      exported ||= ok;
      if (ok) close();
      else {
        btn.textContent = "Export";
        btn.disabled = !exportReady(sections, picked, subsets);
      }
    },
  };
  let profileLoad = 0;
  const profilePicker = profileControl({ label: "Prompt profile", follow: false, value: () => options.promptProfile,
    onChange: async id => {
      options.promptProfile = id;
      const generation = ++profileLoad;
      options.loading = true;
      subsets.prompt_vault = { all: true, items: new Set() };
      render();
      const items = await TRANSFER_PICKERS.category.load(id).catch(() => []);
      if (generation !== profileLoad) return;
      choices.prompt_vault = items;
      options.loading = false;
      render();
    } });
  const render = () => {
    const promptSection = sections.find(section => section.id === "prompt_vault");
    if (promptSection) promptSection.count = profileSnapshot().find(profile => profile.id === options.promptProfile)?.promptCount ?? null;
    profilePicker.hidden = !picked.prompt_vault;
    list.replaceChildren(...sections.map((section) => sectionLine(section, picked, {
      onChange: render,
      subset: section.picker ? subsetPicker(section, choices[section.id], subsets[section.id], render) : null,
    })));
    if (exportAction.btn) exportAction.btn.disabled = options.loading || !exportReady(sections, picked, subsets);
  };
  render();

  openKrcModal({
    node,
    title: "Export KRC bundle",
    width: 520,
    body: [
      krcModalSection({ title: "Sections", body: list }),
      krcModalSection({ body: profilePicker }),
      krcModalSection({
        title: "Options",
        body: optionLine("Include linked presets", stateSwitch("Include linked presets", options, "includeLinked"),
          "Prompt Vault prompts bring the LoRA and kit presets they use, even if those sections aren't ticked."),
      }),
    ],
    actions: [{ label: "Cancel", onClick: ({ close }) => close() }, exportAction],
    onClose: () => done({ ok: exported }),
  });
  render();  // the footer buttons exist now: set their state
  return closed;
}

// POST the choice; download the bundle. -> whether it downloaded.
async function runBundleExport(sections, picked, subsets, options, node) {
  const chosen = sections.filter((section) => picked[section.id]);
  const selection = {};
  for (const section of chosen) {
    const subset = subsets[section.id];
    if (subset && !subset.all) {
      selection[section.id] = { [section.picker === "category" ? "categories" : "banks"]: [...subset.items] };
    }
  }
  if (chosen.some(section => section.id === "prompt_vault")) selection.prompt_vault = { ...selection.prompt_vault, profileId: options.promptProfile };
  const body = { sections: chosen.map((section) => section.id), selection, includeLinked: !!options.includeLinked };
  console.log(`[KRC Transfer] bundle export: start (${body.sections.join(", ")})`);
  let response;
  try {
    response = await api.fetchApi("/krc/bundle/export", jsonBodyInit("POST", body));
  } catch (err) {
    console.warn(`[KRC Transfer] bundle export: FAILED (${String(err?.message || err)})`);
    krcAlert("Could not export the bundle. Check the ComfyUI server log.", node);
    return false;
  }
  if (!response.ok) {
    let error = `HTTP ${response.status}`;
    try { error = (await response.json())?.error || error; } catch { /* not JSON */ }
    console.warn(`[KRC Transfer] bundle export: FAILED (${error})`);
    krcAlert(`Could not export the bundle: ${error}`, node);
    return false;
  }
  const ok = await downloadResponseBlob(response, `krc_bundle_${dateStamp()}.zip`);
  if (ok) {
    console.log("[KRC Transfer] bundle export: downloaded");
    showToast(`Exported ${chosen.length} section${chosen.length === 1 ? "" : "s"}.`);
  }
  return ok;
}

// An option's line: label + description on the left, its switch on the right.
function optionLine(label, control, desc) {
  const line = el("div", "krc-bundle-option");
  const text = el("div", "krc-bundle-option-text");
  text.append(el("span", "krc-bundle-section-label", { textContent: label }), el("div", "krc-bundle-option-desc", { textContent: desc }));
  labelFlips(text, control);
  line.append(text, control);
  return line;
}

function modeCards(state, onChange) {
  const cards = el("div", "krc-bundle-modes");
  for (const mode of MODES) {
    const card = el("button", `krc-modal-option krc-bundle-mode${state.mode === mode.id ? " is-selected" : ""}${mode.danger ? " is-danger" : ""}`, { type: "button" });
    card.append(
      el("div", "krc-modal-option-label", { textContent: mode.label }),
      el("div", "krc-modal-option-desc", { textContent: mode.desc }),
    );
    card.addEventListener("click", () => {
      state.mode = mode.id;
      onChange();
    });
    cards.append(card);
  }
  return cards;
}

// Summary -> the Preview table's cells.
function skipText(summary) {
  if (!summary.skipped) return "0";
  const reasons = Object.entries(summary.reasons || {}).map(([reason, count]) => `${count} ${reason}`);
  return reasons.length ? reasons.join(", ") : String(summary.skipped);
}

function previewTable(sections, preview) {
  const table = el("div", "krc-bundle-preview");
  const head = el("div", "krc-bundle-preview-row is-head");
  head.append(...["Section", "Adds", "Updates", "Same", "Skips"].map((text) => el("span", "", { textContent: text })));
  table.append(head);
  for (const section of sections) {
    const summary = preview[section.id];
    if (!summary) continue;
    const row = el("div", "krc-bundle-preview-row");
    row.append(
      el("span", "krc-bundle-preview-name", { textContent: section.label, title: section.label }),
      el("span", "", { textContent: String(summary.added || 0) }),
      el("span", "", { textContent: String(summary.updated || 0) }),
      el("span", "is-muted", { textContent: String(summary.unchanged || 0) }),
      el("span", summary.skipped ? "is-skipped" : "", { textContent: skipText(summary) }),
    );
    table.append(row);
    if (summary.removed !== undefined) table.append(el("div", "krc-options-description", {
      textContent: `${section.label}: ${summary.removed} existing saved prompt${summary.removed === 1 ? "" : "s"} will no longer be present after replacement.`,
    }));
  }
  return table;
}

async function postBundle(path, body) {
  try {
    const response = await api.fetchApi(path, body instanceof FormData ? { method: "POST", body } : jsonBodyInit("POST", body));
    let json = null;
    try { json = await response.json(); } catch { json = null; }
    if (!response.ok || !json?.ok) return { ok: false, error: json?.error || `HTTP ${response.status}` };
    return { ok: true, ...json };
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}

// The Import dialog: pick a .zip (or take the one dropped: `file`), upload it once, choose
// what to bring in. `only` = section ids to tick (a node's own Import). `sources` as in the
// runner (a node skips its own echo). -> { ok, result } once imported, { ok: false } otherwise.
export async function openBundleImport({ node = null, only = null, sources = null, file: given = null, promptProfile = null } = {}) {
  const [file] = given ? [given] : await pickFiles({ accept: ".zip,application/zip" });
  if (!file) return { ok: false, cancelled: true };
  console.log(`[KRC Transfer] bundle import: uploading (${file.size} bytes)`);
  return new Promise((resolve) => {
    let settled = false;
    let token = "";
    let writing = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (!value.ok && token) postBundle("/krc/bundle/discard", { token });
      resolve(value);
    };
    const status = el("div", "krc-bundle-preview-hint", { textContent: "Reading the bundle…" });
    const content = el("div", "krc-bundle-import");
    content.append(status);
    const modal = openKrcModal({
      node,
      title: `Import "${file.name}"`,
      canClose: () => !writing,
      width: 600,
      body: [content],
      actions: [{ label: "Cancel", onClick: ({ close }) => close() }],
      onClose: () => finish({ ok: false, cancelled: true }),
    });
    const form = new FormData();
    form.append("bundle", file, file.name);
    Promise.all([postBundle("/krc/bundle/upload", form), knownSections(), loadProfiles({ force: true })]).then(([upload, known]) => {
      if (settled) {
        if (upload.ok) postBundle("/krc/bundle/discard", { token: upload.token });
        return;
      }
      if (!upload.ok) {
        console.warn(`[KRC Transfer] bundle import: FAILED upload (${upload.error})`);
        status.textContent = `Couldn't read this bundle: ${upload.error}`;
        status.classList.add("is-error");
        return;
      }
      token = upload.token;
      console.log(`[KRC Transfer] bundle import: uploaded (${upload.sections.map((entry) => entry.id).join(", ")})`);
      renderImport({ modal, content, file, upload, known, only, node, sources, finish, promptProfile: transferProfileId(promptProfile), setWriting: value => { writing = value; } });
    });
  });
}

function renderImport({ modal, content, file, upload, known, only, node, sources, finish, promptProfile, setWriting }) {
  const byId = new Map(known.map((section) => [section.id, section]));
  const entries = upload.sections.map((entry) => ({
    entry,
    section: byId.get(entry.id) || { id: entry.id, label: entry.id, hint: "", unit: "item", events: [] },
    importable: entry.known && byId.has(entry.id),
  }));
  const picked = Object.fromEntries(entries.map(({ entry, importable }) => [entry.id, importable && (!only || only.includes(entry.id))]));
  const state = { mode: "merge", history: true, preview: null, busy: false };

  const promptControls = promptImportControls({ id: promptProfile,
    name: upload.sections.find(entry => entry.id === "prompt_vault")?.profile?.name,
    onChange: () => { state.preview = null; render(); } });
  const profileSection = krcModalSection({ title: "Prompt profile", body: promptControls.element });
  const list = el("div", "krc-bundle-sections");
  const modeCell = el("div");
  const previewCell = el("div", "krc-bundle-preview-cell");
  const optionCell = optionLine("Keep history", stateSwitch("Keep history", state, "history", { onChange: () => { state.preview = null; render(); } }),
    "Brings the bundle's dates and usage counts along. Off: imported items are dated now, with no usage.");
  const chosen = () => entries.filter(({ entry, importable }) => importable && picked[entry.id]).map(({ entry }) => entry.id);
  const request = () => ({ token: upload.token, sections: chosen(), mode: state.mode, history: !!state.history,
    fileName: file.name, ...(chosen().includes("prompt_vault") ? { promptProfile: { ...promptControls.state } } : {}) });

  const foot = el("div", "krc-modal-foot");
  const cancel = el("button", "krc-modal-btn", { type: "button", textContent: "Cancel" });
  const previewBtn = el("button", "krc-modal-btn", { type: "button", textContent: "Preview" });
  const importBtn = el("button", "krc-modal-btn-primary", { type: "button", textContent: "Import" });
  foot.append(cancel, previewBtn, importBtn);
  cancel.addEventListener("click", () => modal.close());

  const render = () => {
    list.replaceChildren(...entries.map(({ entry, section, importable }) => sectionLine(section, picked, {
      onChange: () => { state.preview = null; render(); },
      count: bundleCountText(entry.counts),
      hint: !importable ? "Not on this machine: can't be imported here" : entry.linkedOnly ? "Only the presets the prompts use" : section.hint,
      disabled: !importable,
    })));
    modeCell.replaceChildren(modeCards(state, () => { state.preview = null; render(); }));
    previewCell.replaceChildren(state.preview
      ? previewTable(entries.map(({ section }) => section), state.preview)
      : el("div", "krc-bundle-preview-hint", {
        textContent: "Preview shows what each section would add, update or skip. Nothing changes until you import.",
      }));
    profileSection.hidden = !picked.prompt_vault;
    promptControls.element.inert = !!state.busy;
    list.inert = !!state.busy;
    modeCell.inert = !!state.busy;
    otherModeSection.hidden = !chosen().some(id => id !== "prompt_vault");
    const any = chosen().length > 0 && (!picked.prompt_vault || promptControls.valid());
    cancel.disabled = state.busy === "import" || state.busy === "confirm";
    previewBtn.disabled = state.busy || !any;
    importBtn.disabled = state.busy || !any;
    importBtn.classList.toggle("is-danger", (chosen().some(id => id !== "prompt_vault") && state.mode === "overwrite") || (picked.prompt_vault && promptControls.state.action === "replace"));
    importBtn.textContent = state.busy === "import" ? "Importing…" : (picked.prompt_vault && promptControls.state.action === "replace") || (chosen().some(id => id !== "prompt_vault") && state.mode === "overwrite") ? "Import (overwrite)" : "Import";
    previewBtn.textContent = state.busy === "preview" ? "Checking…" : "Preview";
  };

  previewBtn.addEventListener("click", async () => {
    state.busy = "preview";
    render();
    const body = request();
    const result = await postBundle("/krc/bundle/preview", body);
    state.busy = false;
    if (!result.ok) krcAlert(`Couldn't preview the import: ${result.error}`, node);
    else if (JSON.stringify(body) === JSON.stringify(request())) state.preview = result.sections;
    render();
  });

  importBtn.addEventListener("click", async () => {
    if (state.busy) return;
    const body = request();
    if (body.promptProfile?.action === "replace") {
      state.busy = "confirm";
      render();
      const confirmed = await openKrcConfirm({ node, title: "Replace prompt profile?",
        message: `Replace every prompt and category in “${profileName(body.promptProfile.id)}” with this bundle? Workflow references to removed prompts will become missing. Undo last import can restore them.`,
        confirmLabel: "Replace profile", danger: true, armed: true, width: 520 });
      if (!confirmed) { state.busy = false; render(); return; }
    }
    state.busy = "import";
    setWriting(true);
    render();
    console.log(`[KRC Transfer] bundle import: sending (${body.mode}, ${body.sections.join(", ")})`);
    const result = await postBundle("/krc/bundle/import", body);
    setWriting(false);
    state.busy = false;
    if (!result.ok) {
      console.warn(`[KRC Transfer] bundle import: FAILED (${result.error})`);
      krcAlert(`Couldn't import the bundle: ${result.error}`, node);
      render();
      return;
    }
    console.log("[KRC Transfer] bundle import: ok");
    finish({ ok: true, result });
    modal.close();
    const imported = entries.map(({ section }) => section).filter((section) => body.sections.includes(section.id));
    const events = mergedSectionEvents(imported);
    for (const [index, section] of imported.entries()) {
      if (events[index].length) publishTransferEvents(`bundle ${section.id}`, events[index], sources);
      await section.after?.();
    }
    showImportResult(file.name, body.sections.length, node, sources);
  });

  const otherModeSection = krcModalSection({ title: "Other sections: mode", body: modeCell });
  content.replaceChildren(
    krcModalSection({ title: "In this bundle", body: list }),
    profileSection,
    otherModeSection,
    krcModalSection({ title: "Options", body: optionCell }),
    krcModalSection({ title: "Preview", body: previewCell }),
  );
  modal.foot?.remove();
  modal.panel.append(foot);
  render();
}

function showImportResult(fileName, count, node, sources) {
  showToast(`Imported ${count} section${count === 1 ? "" : "s"} from "${fileName}".`, {
    duration: 10000,
    action: { label: "Undo", onClick: () => confirmUndoLastImport({ node, sources }) },
  });
}

// "5 min ago" style for the undo line and dialog.
export function agoText(ms, now = Date.now()) {
  const minutes = Math.max(0, Math.round((now - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// -> the last import that can be undone ({ createdMs, sections, mode, fileName, changesSince }) or null.
export async function fetchUndoInfo() {
  try {
    const response = await api.fetchApi("/krc/bundle/undo", { cache: "no-store" });
    const body = response.ok ? await response.json() : null;
    return body?.undo || null;
  } catch {
    return null;
  }
}

// Undo last import: say what it puts back (and how many later edits there it reverts), then
// do it and tell open nodes. -> { ok }.
export async function confirmUndoLastImport({ node = null, sources = null } = {}) {
  const [last, known] = await Promise.all([fetchUndoInfo(), knownSections()]);
  if (!last) {
    krcAlert("There's no import to undo.", node);
    return { ok: false };
  }
  const byId = new Map(known.map((section) => [section.id, section]));
  const labels = (last.sections || []).map((id) => byId.get(id)?.label || id);
  const since = Number(last.changesSince) || 0;
  const ok = await openKrcConfirm({
    node,
    title: "Undo last import?",
    message: `This puts back what the import of "${last.fileName || "a bundle"}" (${agoText(last.createdMs)}) changed `
      + `in: ${labels.join(", ")}, thumbnails included.`
      + (since ? `\n\n${since} change${since === 1 ? "" : "s"} made there since then will be undone too.` : ""),
    confirmLabel: "Undo import",
    danger: true,
    width: 420,
  });
  if (!ok) return { ok: false };
  console.log(`[KRC Transfer] bundle undo: start (${(last.sections || []).join(", ")})`);
  const result = await postBundle("/krc/bundle/undo", {});
  if (!result.ok) {
    console.warn(`[KRC Transfer] bundle undo: FAILED (${result.error})`);
    krcAlert(`Couldn't undo the import: ${result.error}`, node);
    return { ok: false };
  }
  console.log("[KRC Transfer] bundle undo: ok");
  for (const id of result.sections || []) {
    const section = byId.get(id);
    if (!section) continue;
    publishTransferEvents(`bundle undo ${id}`, section.events, sources);
    await section.after?.();
  }
  showToast("The import was undone.");
  return { ok: true };
}
