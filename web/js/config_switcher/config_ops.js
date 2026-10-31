// Config Switcher config operations: switch / new / Save As / rename / remove configs,
// add a parameter, and the config-action and field-type menus.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { getWidget } from "./helpers.js";
import { krcAlert } from "../shared/modal.js";
import { openTextEntryDialog } from "../shared/text_entry.js";
import {
    ACTIVE_WIDGET,
    activeConfigValues,
    activeName,
    applyFloatingMenuPalette,
    fieldTypeBaseName,
    hasActive,
    isEditMode,
    isInitialBlankState,
    MAX_OUTPUTS,
    PLACEHOLDER,
    realConfigNames,
    renderBar,
    SCRATCH_CONFIG,
    uid,
    uniqueFieldName,
    writeData,
} from "./config.js";
import {
    persistConfigPresetDefault,
    requestConfigSwitcherJson,
    savePresetForNode,
    setLoadedPresetSnapshot,
} from "./presets.js";
import { renderAll, renderFields, resizeConfigNode } from "./field_rows.js";
import { initSeedField } from "./seed_field.js";

export function setActive(node, name) {
    const w = getWidget(node, ACTIVE_WIDGET);
    if (w) w.value = name;
    node._ddp?.activeConfigSelect?.setValue(name);
}

export function resetToBlankSlate(node) {
    node._fields = [];
    node._configs = {};
    node._sharedValues = {};
    node._configPresetDefault = "";
    persistConfigPresetDefault(node);
    setActive(node, PLACEHOLDER);
    setLoadedPresetSnapshot(node, null);
    writeData(node);
    renderAll(node);
    resizeConfigNode(node);
}

export function newConfig(node) {
    node._ddp?.delConfirm?.reset();
    const active = activeName(node);
    const savingScratch = !hasActive(node) && (node._fields || []).length > 0;
    const name = uniqueConfigCopyName(hasActive(node) ? active : "Config", node._configs);
    if (!name || name === SCRATCH_CONFIG || node._configs[name]) return;
    node._configs[name] = { ...(activeConfigValues(node, false) || {}) };
    if (savingScratch) delete node._configs[SCRATCH_CONFIG];
    setActive(node, name);
    writeData(node);
    renderAll(node);
}

// Save As: the active config's current (edited) values become a NEW config under a name
// the user picks, the active config goes back to its saved values, and the preset is
// saved, so an edit can be kept without overwriting the config it started from. A config
// the saved preset doesn't have yet (or a preset never saved) has nothing to go back to
// and keeps its values. The new config is active afterwards.
export async function saveConfigAs(node) {
    if (!hasActive(node)) return;
    node._ddp?.delConfirm?.reset();
    const source = activeName(node);
    const name = await openTextEntryDialog({
        node,
        title: "Save config as",
        label: "Config",
        value: uniqueConfigCopyName(source, node._configs),
        placeholder: "config name",
        confirmTitle: "Save config as",
        validate: (candidate) => (node._configs[candidate] ? "A config with that name already exists." : ""),
    });
    if (!name || node._configs[name] || name === SCRATCH_CONFIG || !node._configs[source]) return;
    let saved = null;
    if (node._configPresetId) {
        try {
            const data = await requestConfigSwitcherJson("/presets");
            const preset = (Array.isArray(data?.presets) ? data.presets : []).find((item) => item.id === node._configPresetId);
            const values = preset?.configs?.[source];
            if (values && typeof values === "object" && !Array.isArray(values)) saved = { ...values };
        } catch (e) {
            krcAlert(`Config Switcher: ${e.message || "could not read the saved preset."}`, node);
            return;
        }
    }
    node._configs[name] = { ...node._configs[source] };
    if (saved) node._configs[source] = saved;
    setActive(node, name);
    writeData(node);
    renderAll(node);
    await savePresetForNode(node);
}

export async function renameConfig(node) {
    if (!hasActive(node)) return;
    node._ddp?.delConfirm?.reset();
    const old = activeName(node);
    const name = await openTextEntryDialog({
        node,
        title: "Rename config",
        label: "Config",
        value: old,
        placeholder: "config name",
        confirmTitle: "Rename config",
        validate: (candidate) => (
            candidate !== old && node._configs[candidate] ? "A config with that name already exists." : ""
        ),
    });
    if (!name || name === old || node._configs[name]) return;
    node._configs[name] = node._configs[old];
    delete node._configs[old];
    if (node._configPresetDefault === old) {
        node._configPresetDefault = name;
        persistConfigPresetDefault(node);
    }
    setActive(node, name);
    writeData(node);
    renderAll(node);
}

export function removeConfig(node) {
    if (!hasActive(node)) return;
    const removed = activeName(node);
    delete node._configs[removed];
    if (node._configPresetDefault === removed) {
        node._configPresetDefault = "";
        persistConfigPresetDefault(node);
    }
    const remaining = realConfigNames(node);
    setActive(node, remaining[0] || PLACEHOLDER);
    writeData(node);
    renderAll(node);
}

export function addField(node, type) {
    if (!isEditMode(node)) return;
    if ((node._fields || []).length >= MAX_OUTPUTS) return;
    // A SECTION/DIVIDER starts untitled (a gap); every other type gets its auto-name.
    const field = { id: uid(), name: type === "section" ? "" : uniqueFieldName(node, fieldTypeBaseName(type)), type, options: [], numberOutput: type === "number" ? "auto" : "", modelType: "", modelOptions: [], promptOptions: [], stringMultiline: false };
    node._fields.push(field);
    if (!hasActive(node)) activeConfigValues(node, true);
    if (type === "seed") initSeedField(node, field);
    writeData(node);
    renderFields(node);
    renderBar(node);
    resizeConfigNode(node);
}

export function closeFieldTypeMenu(node) {
    const menu = node._ddp?.addFieldMenu;
    if (menu) menu.hidden = true;
    node._configInitialNew = false;
}

export function closeConfigActionMenu(node) {
    const menu = node._ddp?.configActionMenu;
    if (menu) menu.hidden = true;
}

function positionConfigActionMenu(node) {
    const ui = node._ddp;
    const menu = ui?.configActionMenu;
    const button = ui?.configActionButton;
    if (!menu || !button) return;

    applyFloatingMenuPalette(node, menu);

    const rect = button.getBoundingClientRect();
    menu.hidden = false;
    const menuWidth = menu.offsetWidth || 132;
    const menuHeight = menu.offsetHeight || 84;
    const margin = 8;
    const below = rect.bottom + 4;
    const above = rect.top - menuHeight - 4;
    const top = below + menuHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, above);
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - menuWidth - margin));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

export function toggleConfigActionMenu(node) {
    const menu = node._ddp?.configActionMenu;
    if (!menu) return;
    if (!menu.hidden) {
        closeConfigActionMenu(node);
        return;
    }
    renderBar(node);
    positionConfigActionMenu(node);
}

function positionFieldTypeMenu(node) {
    const ui = node._ddp;
    const menu = ui?.addFieldMenu;
    const button = node._configInitialNew ? ui?.emptyNew : ui?.addField;
    if (!menu || !button) return;

    // The menu lives on <body>, so apply the node's floating-surface palette.
    // Native maps to Gray because there is no node canvas color behind it.
    applyFloatingMenuPalette(node, menu);

    const rect = button.getBoundingClientRect();
    menu.hidden = false;
    const menuWidth = menu.offsetWidth || 112;
    const menuHeight = menu.offsetHeight || 78;
    const margin = 8;
    const below = rect.bottom + 4;
    const above = rect.top - menuHeight - 4;
    const top = below + menuHeight <= window.innerHeight - margin
        ? below
        : Math.max(margin, above);
    const left = Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin));

    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
}

export function toggleFieldTypeMenu(node) {
    if (!isEditMode(node) && !node._configInitialNew) return;
    const menu = node._ddp?.addFieldMenu;
    if (!menu) return;
    if (!menu.hidden) {
        closeFieldTypeMenu(node);
        return;
    }
    positionFieldTypeMenu(node);
}

export function startInitialNew(node) {
    if (!isInitialBlankState(node)) return;
    node._configInitialNew = true;
    positionFieldTypeMenu(node);
}

export function uniqueCopyName(base, taken) {
    const stem = `${base || "Preset"} copy`;
    let name = stem;
    let counter = 2;
    while (taken.has(name)) {
        name = `${stem} ${counter}`;
        counter += 1;
    }
    return name;
}

function uniqueConfigCopyName(base, configs) {
    let name = `${base || "Config"} copy`;
    while (configs?.[name]) name = `${name} copy`;
    return name;
}
