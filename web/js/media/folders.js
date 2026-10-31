// Media folders as a chip strip (GAMEPLAN.md section 1), Prompt Vault style, from NodePack's
// shared chip pieces (API 1.16), in one of two views (the toolbar's I / O button, never
// both): Input = ALL, Unsorted, the upload folders, "+"; Output = ALL, Unsorted (what Media
// Output saves with its folder on Default), the output folders, "+" (a new output folder). Folders: pinned first, bold; a card colour; a lock glyph when
// protected from Delete. The selected chip filters the cards and, in Input, is where uploads
// go (ALL / Unsorted -> Unsorted). A folder chip's › notch opens the shared
// inline editor in place of the strip: rename, Delete (armed; its items move to Unsorted),
// PURGE (armed twice, as Prompt Vault's: the folder AND its items), pin, colour, PROTECT
// (the global Delete never deletes its items). Media cards dropped on a chip move there.
import { chipEditor, chipStripShell, createCardColorButton, pinActionButton, plainChip, splitChip } from "./krc.js";
import { installMediaDropTarget } from "./drag.js";
import { mediaApi } from "./api.js";

export const ALL_FOLDERS = "__all__";
export const INPUT_VIEW = "input";
export const OUTPUT_VIEW = "output";
export const UNSORTED = "__unsorted__";
const NEW_FOLDER = "__new__";
const TAG = "[KRC Media]";

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);

// The folder id an upload / a move uses for a chip value ("" = Unsorted).
export const folderIdOf = (value) => (value === ALL_FOLDERS || value === UNSORTED ? "" : String(value || ""));

// Which view a folder / an item belongs to: output storage -> Output, the rest -> Input.
export const folderInView = (folder, view) => (folder?.storage === "output") === (view === OUTPUT_VIEW);
export const itemInView = (item, view) => (item?.storage === "output") === (view === OUTPUT_VIEW);

// Does `item` show under chip `value`?
export function inFolder(item, value) {
  if (value === ALL_FOLDERS) return true;
  if (value === UNSORTED) return !item.folder;
  return item.folder === value;
}

function freeName(folders, storage = "media") {
  const base = storage === "output" ? "New output folder" : "New folder";
  const taken = new Set(folders.map((folder) => folder.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let number = 2;
  while (taken.has(`${base.toLowerCase()} ${number}`)) number += 1;
  return `${base} ${number}`;
}

// The strip (or, while a folder is being edited, its editor). `ctx`:
//   folders, storageView (INPUT_VIEW | OUTPUT_VIEW), active, editor ({ id, name, deleteArm, purgeStage, message, tone } | null), countOf(id),
//   inPresetsOf(id) (how many of the folder's items a preset uses),
//   dragPayload(), onSelect(value), onEdit(editor | null), onChanged() (re-read the Media),
//   onMove(itemId, folderId)
export function renderFolderStrip(ctx) {
  const { shell, bg, scroll } = chipStripShell();
  shell.classList.add("krc-mio-folders");
  if (ctx.editor) {
    scroll.classList.add("is-editing");
    scroll.append(folderEditor(ctx));
    shell.append(bg, scroll);
    return shell;
  }
  const dropTarget = (chip, value) => installMediaDropTarget(chip, {
    dragPayload: ctx.dragPayload,
    onDrop: id => ctx.onMove(id, folderIdOf(value)),
  });
  const output = ctx.storageView === OUTPUT_VIEW;
  scroll.append(plainChip({ label: "ALL", value: ALL_FOLDERS, active: ctx.active === ALL_FOLDERS,
    title: output ? "Show every output" : "Show every upload (uploads go to Unsorted)", onSelect: ctx.onSelect }));
  scroll.append(dropTarget(plainChip({ label: "Unsorted", value: UNSORTED, active: ctx.active === UNSORTED,
    title: output ? "Outputs in no folder: Media Output's Default (drop a card here to take it out of its folder)"
      : "Items in no folder (drop a card here to take it out of its folder)", onSelect: ctx.onSelect }), UNSORTED));
  const addFolderChip = (folder) => {
    const chip = splitChip({
      label: folder.name,
      value: folder.id,
      active: ctx.active === folder.id,
      pinned: folder.pinned,
      color: folder.color,
      title: `Show ${folder.name}${folder.storage === "output" ? " · output destination" : " (uploads go here)"}${folder.keep ? " · protected from Delete" : ""}`,
      notchTitle: "Folder actions",
      onSelect: ctx.onSelect,
      onOpenEditor: () => ctx.onEdit({ id: folder.id, name: folder.name, deleteArm: false, message: "", tone: "" }),
    });
    chip.classList.toggle("is-kept", folder.keep);
    if (folder.keep) {
      const lock = el("span", "krc-mio-folder-lock");
      lock.setAttribute("aria-hidden", "true");
      chip.querySelector(".krc-chip-main").replaceChildren(
        el("span", "krc-mio-folder-name", { textContent: folder.name }), lock,
      );
    }
    scroll.append(dropTarget(chip, folder.id));
  };
  const addFolderButton = (storage) => scroll.append(plainChip({
    label: "+",
    value: storage === "output" ? `${NEW_FOLDER}_output` : NEW_FOLDER,
    title: storage === "output" ? "New output folder" : "New folder",
    onSelect: async () => {
      try {
        const { folder } = await mediaApi.createFolder(freeName(ctx.folders, storage), storage);
        await ctx.onChanged();
        ctx.onSelect(folder.id);
        ctx.onEdit({ id: folder.id, name: folder.name, deleteArm: false, message: "Name the new folder.", tone: "" });
      } catch (error) {
        console.warn(`${TAG} couldn't make a folder: ${error?.message || error}`);
      }
    },
  }));
  ctx.folders.filter((folder) => folderInView(folder, ctx.storageView)).forEach(addFolderChip);
  addFolderButton(output ? "output" : "media");
  shell.append(bg, scroll);
  return shell;
}

// The inline editor (NodePack's chipEditor): name, then pin / colour / PROTECT, then SAVE /
// DELETE (armed) / EXIT. Pin, colour and PROTECT save at once and show their new state at
// once (the editor isn't redrawn while its name field has focus); a failed save puts the
// button back and shows why. The name saves on SAVE or Enter.
function folderEditor(ctx) {
  const state = ctx.editor;
  const folder = ctx.folders.find((entry) => entry.id === state.id);
  if (!folder) {
    queueMicrotask(() => ctx.onEdit(null));
    return el("span");
  }
  const update = async (fields) => {
    try {
      await mediaApi.updateFolder(folder.id, fields);
      await ctx.onChanged();
      return true;
    } catch (error) {
      ctx.onEdit({ ...state, message: String(error?.message || error), tone: "danger" });
      return false;
    }
  };
  const count = ctx.countOf(folder.id);
  const plural = `${count} item${count === 1 ? "" : "s"}`;
  // PURGE's two arming steps say what goes (and what presets will miss).
  const purgeMessage = () => {
    if (!state.purgeStage) return "";
    const inPresets = ctx.inPresetsOf(folder.id);
    const presetNote = inPresets ? ` ${inPresets} ${inPresets === 1 ? "is" : "are"} in presets (those slots will show Missing).` : "";
    return state.purgeStage === 2
      ? `Last chance: ${plural} will be deleted with the folder.${presetNote}`
      : `Purge deletes the folder and its ${plural}${folder.keep ? ", protected or not" : ""}.${presetNote}`;
  };
  const attributes = el("div", "krc-chip-editor-attrs");
  const toggles = el("div", "krc-chip-editor-attr-toggles");
  // A two-state button that flips at once, then saves (and flips back if that fails).
  const flag = (button, key, titles) => {
    let on = Boolean(folder[key]);
    const show = () => {
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", String(on));
      button.title = on ? titles[0] : titles[1];
    };
    show();
    button.addEventListener("click", async () => {
      on = !on;
      show();
      if (!(await update({ [key]: on }))) { on = !on; show(); }
    });
    return button;
  };
  toggles.append(
    flag(pinActionButton({ active: folder.pinned, className: "krc-icon-button is-pin" }), "pinned",
      ["Pinned near the top (click to unpin)", "Pin near the top"]),
    createCardColorButton({ record: folder, explicitColor: folder.color, baseTitle: "Folder colour", onChange: (color) => update({ color: color || "" }) }),
  );
  const protect = flag(el("button", "krc-chip-editor-action krc-mio-protect", { type: "button", textContent: "PROTECT" }), "keep", [
    "Protected: the global Delete (including Delete all) never deletes what's in this folder; only this folder's own PURGE does. Click to stop protecting it.",
    "Protect this folder: the global Delete (including Delete all) will never delete what's in it.",
  ]);
  attributes.append(toggles, protect);
  const save = async () => {
    const name = String(state.name || "").trim();
    if (!name || name === folder.name) { ctx.onEdit(null); return; }
    if (await update({ name })) ctx.onEdit(null);
  };
  return chipEditor({
    inputValue: state.name,
    inputTitle: "Folder name",
    message: state.message || purgeMessage() || (state.deleteArm ? `Delete the folder: its ${plural} move to Unsorted.` : `Rename or manage ${plural}.`),
    messageTone: state.tone || "",
    attributes,
    actions: [
      { label: "SAVE", title: "Rename the folder", className: "is-save", onClick: save },
      {
        label: state.deleteArm ? "MOVE?" : "DELETE",
        title: "Delete the folder (its items move to Unsorted)",
        className: "is-delete",
        confirming: Boolean(state.deleteArm),
        onClick: async () => {
          if (!state.deleteArm) { ctx.onEdit({ ...state, deleteArm: true, purgeStage: 0 }); return; }
          try {
            await mediaApi.deleteFolder(folder.id);
          } catch (error) {
            console.warn(`${TAG} couldn't delete the folder: ${error?.message || error}`);
          }
          ctx.onEdit(null);
          if (ctx.active === folder.id) ctx.onSelect(UNSORTED);
          await ctx.onChanged();
        },
      },
      {
        label: state.purgeStage === 2 ? "SURE?" : state.purgeStage === 1 ? "PURGE?" : "PURGE",
        title: "Purge: delete the folder and every item in it (protected or not)",
        className: "is-danger",
        confirming: Boolean(state.purgeStage),
        onClick: async () => {
          if ((state.purgeStage || 0) < 2) {
            ctx.onEdit({ ...state, deleteArm: false, purgeStage: (state.purgeStage || 0) + 1 });
            return;
          }
          try {
            const result = await mediaApi.purgeFolder(folder.id);
            console.log(`${TAG} purged the folder: ${result.removed} item(s)`);
          } catch (error) {
            console.warn(`${TAG} couldn't purge the folder: ${error?.message || error}`);
          }
          ctx.onEdit(null);
          if (ctx.active === folder.id) ctx.onSelect(ALL_FOLDERS);
          await ctx.onChanged();
        },
      },
      { label: "EXIT", title: "Close", className: "is-exit", onClick: () => ctx.onEdit(null) },
    ],
    onInput: (value) => { state.name = value; state.deleteArm = false; state.purgeStage = 0; state.message = ""; state.tone = ""; },
    onEnter: save,
    onEscape: () => ctx.onEdit(null),
    onMount: (input) => requestAnimationFrame(() => { if (input.isConnected) { input.focus(); input.select(); } }),
  });
}
