// Preset group actions (PRESET_GROUP_RENAME_GAMEPLAN.md stages 2 and 3), shared by every
// preset owner: LoRA Loadout, the Loadout Kit, Word Bank and Config Switcher. Each real
// group in the owner's group picker gets a "⋯" notch (searchable_select `optionMenu`) with:
//
//   Rename…                 every preset in the group moves to the new name (a name that
//                           exists merges; Word Bank / Config Switcher refuse a name clash)
//   Ungroup…                the group goes away, its presets move to --none-- (same
//                           refusals), after a warning confirm
//   Delete group…           the group and its presets, after a red two-step confirm
//
// Each posts to the store's `<base>/rename-group {from, to}`, `ungroup-group {group}` or
// `delete-group {group}`. Ids never change, so Prompt Vault links follow a rename or a move;
// links to deleted presets show MISSING. The owner then moves its filter and broadcasts
// `groupChange: {kind, from, to}` (to = where a filter on `from` goes) so the other nodes
// follow (`followGroupChange`).
import { api } from "../../../scripts/api.js";
import { forgetInFlight, jsonBodyInit } from "./api.js";
import { el } from "./dom.js";
import { krcAlert, openKrcConfirm, openKrcModal } from "./modal.js";
import {
  NONE_PRESET_GROUP,
  NONE_PRESET_GROUP_LABEL,
  canonicalGroup,
  composeTrigger,
  presetDisplayName,
  presetGroup,
} from "./preset_naming.js";
import { createTextEntryControl } from "./text_entry.js";

// Whether a group picker value is a real group (not All, not --none--).
export function isManagedGroup(value) {
  return !!value && value !== "__all__" && canonicalGroup(value) === value && value !== NONE_PRESET_GROUP;
}

const plural = (count) => `${count} preset${count === 1 ? "" : "s"}`;

function groupCounts(presets) {
  const counts = new Map();
  for (const preset of presets || []) {
    const group = presetGroup(preset);
    counts.set(group, (counts.get(group) || 0) + 1);
  }
  return counts;
}

function groupNameProblem(raw) {
  const value = String(raw || "").trim();
  if (!value) return "Group name is required.";
  if (value.includes(":")) return "Group cannot contain ':'.";
  if (value.startsWith("@")) return "Group cannot start with '@'.";
  if (canonicalGroup(value) === NONE_PRESET_GROUP) return "That name is reserved for --none--.";
  return "";
}

// Resolves to the new group name (canonical) or null on cancel. `presets` is the store's
// list, for the counts, the example trigger and the merge note.
export function openPresetGroupRenameDialog({ node = null, presets = [], group = "" } = {}) {
  return new Promise((resolve) => {
    const from = canonicalGroup(group);
    const counts = groupCounts(presets);
    const members = (presets || []).filter((preset) => presetGroup(preset) === from);
    const example = members.map(presetDisplayName).find(Boolean) || "preset";
    // Groups that differ only in case: the picker lists one spelling, so say where the others are.
    const caseTwins = [...counts.keys()]
      .filter((name) => name !== from && name.toLowerCase() === from.toLowerCase());
    let resolved = false;
    let entry = null;
    let save = null;

    const body = el("div", "krc-preset-name-dialog");
    const field = el("label", "krc-preset-name-field");
    field.appendChild(el("span", "krc-preset-name-label", { textContent: "New group name" }));
    const summary = el("div", "krc-modal-option-desc", { textContent: `${plural(members.length)} in “${from}”.` });
    const exampleField = el("div", "krc-preset-name-field");
    exampleField.appendChild(el("span", "krc-preset-name-label", { textContent: "Example" }));
    const preview = el("div", "krc-preset-name-preview");
    exampleField.appendChild(preview);
    const mergeNote = el("div", "krc-modal-option-desc");
    const twinNote = el("div", "krc-modal-option-desc", {
      hidden: !caseTwins.length,
      textContent: caseTwins.length
        ? `Also in the list under this name: ${caseTwins.map((name) => `“${name}” (${plural(counts.get(name))})`).join(", ")}. `
          + "Type that exact spelling to merge them."
        : "",
    });
    const warning = el("div", "krc-modal-option-desc", {
      textContent: "Prompt Vault links follow the presets (they link by id).",
    });

    function sync() {
      if (!entry || !save) return;
      const to = canonicalGroup(entry.value());
      const problem = groupNameProblem(entry.value());
      const same = !problem && to === from;
      preview.textContent = problem || same
        ? composeTrigger(from, example)
        : `${composeTrigger(from, example)}  →  ${composeTrigger(to, example)}`;
      const existing = !problem && !same ? counts.get(to) || 0 : 0;
      const caseOnly = existing === 0 && !problem && !same
        && [...counts.keys()].find((name) => name !== to && name !== from && name.toLowerCase() === to.toLowerCase());
      mergeNote.hidden = !existing && !caseOnly;
      mergeNote.textContent = existing
        ? `“${to}” already has ${plural(existing)}: the two groups merge.`
        : caseOnly ? `“${caseOnly}” exists with different capitals; this makes a separate group.` : "";
      save.disabled = !!problem || same;
      save.title = existing ? "Merge groups" : "Rename group";
    }

    function closeWith(value) {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve(value);
    }

    entry = createTextEntryControl({
      value: from,
      placeholder: "group",
      maxLength: 80,
      title: "New group name",
      validate: (value) => groupNameProblem(value),
      onInput: () => sync(),
      onSubmit: () => save?.click(),
      onCancel: () => closeWith(null),
    });

    const footer = el("div", "krc-preset-name-footer");
    const cancel = el("button", "krc-modal-btn", { type: "button", textContent: "Cancel" });
    save = el("button", "krc-text-entry-submit", { type: "button", textContent: "✓", title: "Rename group" });
    cancel.addEventListener("click", () => closeWith(null));
    save.addEventListener("click", () => {
      entry.sync();
      sync();
      if (save.disabled) return;
      closeWith(canonicalGroup(entry.value()));
    });
    footer.append(cancel, save);

    body.append(summary, field, entry.el, exampleField, mergeNote, twinNote, warning);
    const modal = openKrcModal({
      node,
      title: "Rename group",
      body,
      footer,
      width: 380,
      draggable: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
    });
    sync();
    requestAnimationFrame(() => entry.focus());
  });
}

function refusalMessage(action, status, data, { from, to }) {
  const names = Array.isArray(data?.clashes) ? data.clashes.map((name) => `“${name}”`).join(", ") : "";
  if (status === 409 && data?.error === "reserved") {
    return `Can't move “${from}” to ${NONE_PRESET_GROUP_LABEL}: ${names} would clash with the blank slate (--empty--). Rename it first.`;
  }
  if (status === 409 && names) {
    const target = action === "ungroup" ? NONE_PRESET_GROUP_LABEL : `“${to}”`;
    return `Can't move “${from}” into ${target}: it already has presets named ${names}. Rename those first.`;
  }
  if (status === 404) return `No presets are in “${from}” any more. Reload the list and try again.`;
  const verb = { rename: "rename", ungroup: "move", delete: "delete" }[action] || "change";
  return `Could not ${verb} the group (HTTP ${status}).`;
}

async function postGroupAction(node, action, url, body, names) {
  let response;
  let data = null;
  try {
    response = await api.fetchApi(url, jsonBodyInit("POST", body));
    data = await response.json().catch(() => null);
  } catch {
    krcAlert("Could not change the group (network error).", node);
    return null;
  } finally {
    forgetInFlight();
  }
  if (!response.ok || !data?.ok) {
    krcAlert(refusalMessage(action, response.status, data, names), node);
    return null;
  }
  return data;
}

// Each flow resolves to the change `{kind, from, to, count}` (to = where a filter on `from`
// goes), or null when cancelled or refused (a refusal is shown). `base` is the store's
// presets path, e.g. "/krc/lora-loadout/presets".
export async function renamePresetGroup({ node = null, presets = [], group = "", base = "" } = {}) {
  const from = canonicalGroup(group);
  const to = await openPresetGroupRenameDialog({ node, presets, group: from });
  if (!to) return null;
  const data = await postGroupAction(node, "rename", `${base}/rename-group`, { from, to }, { from, to });
  return data ? { kind: "rename", from, to: data.group || to, count: data.count || 0 } : null;
}

export async function ungroupPresetGroup({ node = null, presets = [], group = "", base = "" } = {}) {
  const from = canonicalGroup(group);
  const members = (presets || []).filter((preset) => presetGroup(preset) === from);
  const example = members.map(presetDisplayName).find(Boolean) || "preset";
  // A warning confirm: the presets survive, but they mix into --none-- and there is no
  // undo short of regrouping them one by one.
  const ok = await openKrcConfirm({
    node,
    title: `Ungroup “${from}”?`,
    message: `Its ${plural(members.length)} move to ${NONE_PRESET_GROUP_LABEL} and the group is removed. `
      + "There's no undo: regrouping them means moving each preset back one at a time. "
      + `Names read ${composeTrigger(NONE_PRESET_GROUP, example)} instead of ${composeTrigger(from, example)}; `
      + "Prompt Vault links follow.",
    confirmLabel: "Ungroup",
    danger: true,
  });
  if (!ok) return null;
  const data = await postGroupAction(node, "ungroup", `${base}/ungroup-group`, { group: from }, { from });
  return data ? { kind: "ungroup", from, to: NONE_PRESET_GROUP, count: data.count || 0 } : null;
}

export async function deletePresetGroup({ node = null, presets = [], group = "", base = "" } = {}) {
  const from = canonicalGroup(group);
  const count = (presets || []).filter((preset) => presetGroup(preset) === from).length;
  const ok = await openKrcConfirm({
    node,
    title: `Delete “${from}” and its presets?`,
    message: `Delete “${from}” and its ${plural(count)}? Prompt Vault links to them will show MISSING. `
      + "This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    armed: true,
  });
  if (!ok) return null;
  const data = await postGroupAction(node, "delete", `${base}/delete-group`, { group: from }, { from });
  return data ? { kind: "delete", from, to: "__all__", count: data.count || 0 } : null;
}

// The group picker's `optionMenu`: the three actions for a real group's row, else null.
// `presets()` reads the owner's current list; `onDone(change)` runs after a done action.
export function presetGroupMenu({ node = null, presets = () => [], base = "", onDone = () => {} } = {}) {
  const run = (flow, group) => async () => {
    const change = await flow({ node, presets: presets(), group, base });
    if (change) await onDone(change);
  };
  return (item) => {
    if (!isManagedGroup(item?.value)) return null;
    return [
      { label: "Rename…", run: run(renamePresetGroup, item.value) },
      { label: "Ungroup…", run: run(ungroupPresetGroup, item.value) },
      { label: "Delete group…", danger: true, run: run(deletePresetGroup, item.value) },
    ];
  };
}

// The presets-changed event detail for a done change.
export function groupChangeDetail(change) {
  return { groupChange: { kind: change.kind, from: change.from, to: change.to } };
}

// A presets-changed event's `groupChange`, applied to a group filter value: where a filter
// on the changed group goes (the new name, --none--, or All), else the filter unchanged.
export function followGroupChange(filter, event) {
  const change = event?.detail?.groupChange;
  return change && filter && filter === change.from ? change.to : filter;
}
