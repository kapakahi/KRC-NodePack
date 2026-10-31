import { createSearchableSelect } from "./searchable_select.js";
import { openKrcModal } from "./modal.js";
import { el } from "./dom.js";
import { createTextEntryControl } from "./text_entry.js";
import {
  NONE_PRESET_GROUP,
  NONE_PRESET_GROUP_LABEL,
  canonicalGroup,
  canonicalLabel,
  presetPrefixOptions,
} from "./preset_naming.js";

const NEW_GROUP_VALUE = "__new_group__";

function groupOptions(presets, selectedGroup) {
  const options = presetPrefixOptions(presets)
    .filter(([value]) => value !== "__all__")
    .map(([value, name]) => ({ value, name }));
  const group = canonicalGroup(selectedGroup);
  if (!options.some((option) => option.value === group)) {
    options.push({ value: group, name: group === NONE_PRESET_GROUP ? NONE_PRESET_GROUP_LABEL : group });
  }
  options.push({ value: NEW_GROUP_VALUE, name: "+ New group" });
  return options;
}

// Resolves to { group, name } (both canonicalized) or null on cancel. `group` is the
// stored group token; `name` is the label (free-form, may contain ':'). `validateName`
// receives { group, name } and returns an error string ("" = ok).
export function openPresetNameDialog({
  node = null,
  title = "Preset name",
  presets = [],
  group = NONE_PRESET_GROUP,
  name = "",
  confirmTitle = "Save preset",
  validateName = null,
} = {}) {
  return new Promise((resolve) => {
    let selectedGroup = canonicalGroup(group);
    let resolved = false;
    let groupEntry = null;
    let nameEntry = null;
    let save = null;

    const body = el("div", "krc-preset-name-dialog");
    const groupField = el("label", "krc-preset-name-field");
    groupField.appendChild(el("span", "krc-preset-name-label", { textContent: "Group" }));
    const groupPicker = createSearchableSelect({
      options: groupOptions(presets, selectedGroup),
      value: selectedGroup,
      placeholder: NONE_PRESET_GROUP_LABEL,
      searchPlaceholder: "Search groups...",
      emptyText: "No groups found.",
      buttonTitle: "Preset group",
      ariaLabel: "Preset group",
      fixedMenu: true,
      menuWidth: 220,
      onSelect: (next) => {
        if (next === NEW_GROUP_VALUE) {
          groupEntry.el.hidden = false;
          groupEntry.setValue("");
          groupEntry.focus();
          return;
        }
        selectedGroup = canonicalGroup(next);
        groupEntry.el.hidden = true;
        updateSaveState();
      },
    });
    groupPicker.el.classList.add("krc-preset-name-group-picker");
    groupField.appendChild(groupPicker.el);

    groupEntry = createTextEntryControl({
      placeholder: "new group",
      maxLength: 80,
      title: "New group",
      validate: (value) => {
        if (!value) return "Group is required.";
        return value.includes(":") ? "Group cannot contain ':'." : "";
      },
      onInput: (value) => {
        if (value) selectedGroup = canonicalGroup(value);
        updateSaveState();
      },
      onSubmit: () => nameEntry.focus(),
      onCancel: () => {
        groupEntry.el.hidden = true;
        groupPicker.setValue(selectedGroup);
        nameEntry.focus();
      },
    });
    groupEntry.el.classList.add("krc-preset-name-new-group");
    groupEntry.el.hidden = true;

    const nameField = el("label", "krc-preset-name-field");
    nameField.appendChild(el("span", "krc-preset-name-label", { textContent: "Name" }));
    nameEntry = createTextEntryControl({
      value: canonicalLabel(name),
      placeholder: "preset name",
      maxLength: 160,
      title: "Preset name",
      validate: (value) => {
        if (!value) return "Preset name is required.";
        return validateName?.({ group: canonicalGroup(selectedGroup), name: canonicalLabel(value) }) || "";
      },
      onInput: () => updateSaveState(),
      onSubmit: () => save?.click(),
      onCancel: () => closeWith(null),
    });

    const footer = el("div", "krc-preset-name-footer");
    const cancel = el("button", "krc-modal-btn", { type: "button", textContent: "Cancel" });
    save = el("button", "krc-text-entry-submit", { type: "button", textContent: "✓", title: confirmTitle });

    function updateSaveState() {
      if (!nameEntry || !groupEntry || !save) return;
      const invalid = !!nameEntry.el.querySelector(".krc-text-entry-message")?.textContent
        || (!groupEntry.el.hidden && !!groupEntry.el.querySelector(".krc-text-entry-message")?.textContent);
      save.disabled = invalid || !nameEntry.value();
    }
    function closeWith(value) {
      if (resolved) return;
      resolved = true;
      modal.close();
      resolve(value);
    }

    cancel.addEventListener("click", () => closeWith(null));
    save.addEventListener("click", () => {
      nameEntry.sync();
      groupEntry.sync();
      updateSaveState();
      if (save.disabled) return;
      closeWith({ group: canonicalGroup(selectedGroup), name: canonicalLabel(nameEntry.value()) });
    });

    footer.append(cancel, save);
    body.append(groupField, groupEntry.el, nameField, nameEntry.el);
    const modal = openKrcModal({
      node,
      title,
      body,
      footer,
      width: 360,
      draggable: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
    });

    updateSaveState();
    requestAnimationFrame(() => nameEntry.focus());
  });
}
