import { configValueView, pruneSharedValues } from "./shared_values.js";
import { cleanDynamicHidden, cleanDynamicSchema } from "./dynamic_combo.js";
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import {
    applyNodeColors,
    ensureConfigSwitcherStyles,
    getWidget,
    h,
    hideWidget,
    promoteDomWidgetAfterVisible,
} from "./helpers.js";
import { krcAlert } from "../shared/modal.js";
import { openLibraryModal } from "../shared/library_modal.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { applyNodePalette, floatingPaletteId } from "../shared/node_palette.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { isOwnSyncEvent, KRC_SYNC_EVENTS, subscribeKrcSync } from "../shared/sync_bus.js";
import { followGroupChange } from "../shared/preset_group_actions.js";
import { LOCAL_STATUS } from "../shared/local_status.js";
import { installConfigSwitcherStatsHook, registerConfigSwitcherNode } from "./memory_stats.js";
import { installLibraryHealBridge } from "../shared/library_heal_client.js";
import {
    applyModelIdentityChange,
    applyModelPathMoves,
    applyPromptTextChanges,
} from "./path_moves.js";
import {
    applyPromptLibraryToOptions,
    closePromptOptionMenu,
    normalizePromptOption,
} from "./prompt_field.js";
import {
    classifyConfigPreset,
    configSyncSource,
    createInitialPresetWithField,
    openInitialLoadModal,
    persistConfigPresetDefault,
    persistedConfigPresetId,
    PRESET_ID_WIDGET,
    refreshConfigPresetGlobalSnapshot,
    restorePersistedPresetSnapshot,
    savePresetForNode,
    setConfigPresetDefault,
    setConfigPresetId,
    updatePresetModifiedSlot,
} from "./presets.js";
import {
    closeNumberOutputMenu,
    closeStringOptionMenu,
    closeStringValuePopover,
} from "./value_controls.js";
import { closeModelOptionMenu, normalizeModelOption } from "./model_field.js";
import {
    applyLibraryMetadataToOptions,
    applyLibraryThumbnailToOptions,
    followPromptEdits,
    refreshModelCardStatus,
    refreshModelCardRecords,
    refreshPromptCards,
    scheduleCardCatchUp,
} from "./card_sync.js";
import {
    calcConfigDomHeight,
    calcConfigNodeHeight,
    renderAll,
    renderFields,
    resizeConfigNode,
    stampConfigDomHeight,
} from "./field_rows.js";
import {
    addField,
    closeConfigActionMenu,
    closeFieldTypeMenu,
    newConfig,
    removeConfig,
    renameConfig,
    saveConfigAs,
    setActive,
    startInitialNew,
    toggleConfigActionMenu,
    toggleFieldTypeMenu,
} from "./config_ops.js";
import { openIOModal } from "./options_modal.js";
import { installSeedRunHook } from "./seed_field.js";
import { installNoteRunStrip } from "./note_field.js";
import { SECTION_TITLE_MAX } from "./section_field.js";
import { normalizeCardColorId } from "../shared/card_colors.js";
// Must match nodes/krc_config_switcher.py.
const NODE_NAME = "KRC Config Switcher";
const NODE_NAMES = new Set([NODE_NAME]);
export const CONFIG_PRESETS_CHANGED_EVENT = "krc-config-switcher-presets-changed";
// Server push: prompt texts a run found edited. Must match utils/config_switcher_heal.py.
const PROMPT_TEXTS_EVENT = "krc-config-switcher-prompt-texts";
// Preset schema version: sent with every save, which the server refuses unless it's on the
// same one (utils/config_switcher_schema.py, keep CS_SCHEMA_VERSION equal). Bump it by .1
// whenever the field vocabulary or a preset's shape changes (a new type below, a new key).
export const CS_SCHEMA_VERSION = "1.6";
// Recognized field types. "combo" is the saved option picker (historically
// serialized as "string"); "string" is the new raw-text type. See migrateFieldType.
// dynamic_combo (CS_DYNAMIC_COMBO_GAMEPLAN.md) only ever comes from Capture: never addable.
// note (note_field.js) is a notes box: no output, never sent to a run.
// section (section_field.js, schema 1.6) is a SECTION/DIVIDER row: a title or gap, no output.
export const FIELD_TYPES = ["combo", "string", "number", "boolean", "model", "prompt", "seed", "dynamic_combo", "note", "section"];
// Types offered in the "add field" menu. STRING (raw text) sits next to Combo.
// Most to least used; SEED last of the outputs (CS_SEED_FIELD_GAMEPLAN.md), then NOTES and
// SECTION/DIVIDER, which output nothing.
const ADDABLE_FIELD_TYPES = ["combo", "string", "number", "boolean", "model", "prompt", "seed", "note", "section"];
// The "+ Parameter" menu's labels, in capitals as the menu shows them. The default field
// name is the label lowercased (fieldTypeBaseName).
const FIELD_TYPE_LABELS = {
    combo: "COMBO",
    string: "STRING",
    number: "NUMBER",
    boolean: "SWITCH",
    model: "MODEL",
    prompt: "PROMPT",
    seed: "SEED",
    dynamic_combo: "DYNAMIC COMBO",
    note: "NOTES",
    section: "SECTION/DIVIDER",
};
export const DROPDOWN_SORT_AZ = "az";
export const DROPDOWN_SORT_EXISTING = "existing";
export const DROPDOWN_SORT_VALUES = new Set([DROPDOWN_SORT_AZ, DROPDOWN_SORT_EXISTING]);
// Per-node display preference for the model/prompt field cards (node.properties.
// configCardView). "card" is the tall default; the two list flavors are compact
// rows — "list" keeps a tiny thumbnail, "list-text" drops it. Mutually exclusive
// (a card can't be both), surfaced as two Options-modal toggles that clear each
// other. CS styles its own card skin (.ddp-model-card), so the list look is
// bespoke CS CSS, independent of the shared browser list view.
export const CARD_VIEW_CARD = "card";
export const CARD_VIEW_LIST = "list";
export const CARD_VIEW_LIST_TEXT = "list-text";
export const CARD_VIEW_VALUES = new Set([CARD_VIEW_CARD, CARD_VIEW_LIST, CARD_VIEW_LIST_TEXT]);
export const PRESET_CYCLE_SESSION_MS = 2500;
export const NUMBER_OUTPUT_FORMATS = [
    { id: "auto", label: "Auto", title: "Whole numbers emit integers; decimals emit floats" },
    { id: "integer", label: "Integer", title: "Always emit an integer" },
    { id: "float", label: "Float", title: "Always emit a float" },
];
export const NUMBER_OUTPUT_FORMAT_IDS = new Set(NUMBER_OUTPUT_FORMATS.map((format) => format.id));
const DATA_WIDGET = "config_data"; // hidden, declared, canonical store
export const ACTIVE_WIDGET = "active_config"; // native combo (promotable selector)
export const PLACEHOLDER = "(no config)";
export const SCRATCH_CONFIG = PLACEHOLDER;
export const MAX_OUTPUTS = 30;
export const MIN_W = 600;
export const API_PREFIX = "/krc/config-switcher";
// Prompt cards dropped from Prompt Vault carry only the record identity (category +
// name); the deferred prompt text is fetched from this cross-node route on drop.
export const PROMPT_VAULT_API_PREFIX = "/krc/prompt-vault";
// WordBank-style sizing: derive height from field count, not DOM/LiteGraph
// measurements. Keep the DOM constants in sync with the .ddp-* fixed heights
// in styles/fields.css and styles/base.css.
export const DDP_FIELD_H = 28;
export const DDP_MODEL_FIELD_H = 70;
// Model/prompt field row when a list view is active: the compact 34px list card
// (mirror of --krc-browser-list-card-min-height) plus the .ddp-field 2px padding
// top+bottom. Both list flavors share this height (the tiny thumb fits the 34px row).
export const DDP_MODEL_FIELD_LIST_H = 38;
export const DDP_STRING_MULTILINE_H = 72;   // raw STRING field switched to multi-line textarea
export const DDP_FIELD_GAP = 2;
export const DDP_DOM_FIXED_H = 73;
export const DDP_EMPTY_DOM_H = 92;
// Node 2.0 chrome; the classic canvas sizes from the shared edge (shared/node_edge.js).
export const DDP_NODE_BASE_CHROME_H = 50;
export const DDP_CONFIG_OUTPUT_ROW_H = 24;
export const MODEL_CARD_W = 324;
export const MODEL_MENU_PAD_X = 26;

export function applyFloatingMenuPalette(node, menu) {
    const themeId = floatingPaletteId(node?._ddp?.wrap?.dataset?.krcTheme || "");
    if (themeId) menu.dataset.krcTheme = themeId;
    else delete menu.dataset.krcTheme;
}

export function uid() {
    return Math.random().toString(36).slice(2, 9);
}

// Migrate a stored field's type token to the current vocabulary. Legacy
// option-picker fields serialized as "string"; they're now "combo". A "string"
// WITH saved options is definitely a legacy Combo; a bare "string" (no options)
// is the new raw STRING type. Unknown tokens default to Combo (the historical
// default when "string" meant the picker).
function migrateFieldType(rawType, hasOptions) {
    if (rawType === "string") return hasOptions ? "combo" : "string";
    return FIELD_TYPES.includes(rawType) ? rawType : "combo";
}

// Coerce a stored/imported field into the current shape.
export function normalizeField(f) {
    const hasOptions = Array.isArray(f && f.options) && f.options.some((item) => String(item).trim());
    let type = migrateFieldType(f && f.type, hasOptions);
    // A DYNAMIC COMBO is only as good as its captured schema; without one it's a COMBO.
    const dynamicCombo = type === "dynamic_combo" ? cleanDynamicSchema(f?.dynamicCombo) : null;
    if (type === "dynamic_combo" && !dynamicCombo) type = "combo";
    const numberOutput = NUMBER_OUTPUT_FORMAT_IDS.has(f?.numberOutput) ? f.numberOutput : "auto";
    const modelOptions = type === "model" && Array.isArray(f && f.modelOptions)
        ? f.modelOptions.map(normalizeModelOption).filter(Boolean)
        : [];
    const promptOptions = type === "prompt" && Array.isArray(f && f.promptOptions)
        ? f.promptOptions.map(normalizePromptOption).filter(Boolean)
        : [];
    return {
        id: (f && f.id) || uid(),
        // A section's name is its title, capped like the server caps it.
        name: type === "section" ? String((f && f.name) || "").slice(0, SECTION_TITLE_MAX) : String((f && f.name) || ""),
        type,
        options: type === "combo" && Array.isArray(f && f.options) ? f.options.map(String).filter((item) => item.trim()) : [],
        numberOutput: type === "number" ? numberOutput : "",
        modelType: type === "model" ? String((f && f.modelType) || "") : "",
        modelOptions,
        promptOptions,
        stringMultiline: type === "string" ? Boolean(f && f.stringMultiline) : false,
        ...(dynamicCombo ? { dynamicCombo } : {}),
        ...(dynamicCombo && cleanDynamicHidden(dynamicCombo, f?.dynamicHidden).length
            ? { dynamicHidden: cleanDynamicHidden(dynamicCombo, f.dynamicHidden) } : {}),
        ...(type === "section" && normalizeCardColorId(f?.color) ? { color: normalizeCardColorId(f.color) } : {}),
        ...(f?.shared === true && type !== "section" ? { shared: true } : {}),
    };
}

// ---------------------------------------------------------------------------
// Model — in-memory mirror of config_data. Field/structure/value edits write
// through immediately so configs behave like direct node parameters.
// ---------------------------------------------------------------------------

export function activeName(node) {
    return getWidget(node, ACTIVE_WIDGET)?.value ?? PLACEHOLDER;
}

export function hasActive(node) {
    const a = activeName(node);
    return a && a !== PLACEHOLDER && node._configs && a in node._configs;
}

export function realConfigNames(node) {
    return Object.keys(node._configs || {}).filter((name) => name !== SCRATCH_CONFIG);
}

function sortedConfigNames(node) {
    return realConfigNames(node).sort((a, b) => compareDropdownText(a, b));
}

export function explicitDefaultConfig(node) {
    const name = String(node._configPresetDefault || node.properties?.configPresetDefault || "");
    return name && node._configs?.[name] ? name : "";
}

export function resolvedDefaultConfig(node) {
    return explicitDefaultConfig(node) || sortedConfigNames(node)[0] || "";
}

export function hasScratchConfig(node) {
    return Boolean(node._configs && Object.prototype.hasOwnProperty.call(node._configs, SCRATCH_CONFIG));
}

export function isInitialBlankState(node) {
    return !(node._fields || []).length && !realConfigNames(node).length && !hasScratchConfig(node);
}

export function dropdownSortMode(node) {
    const value = String(node.properties?.configDropdownSort || DROPDOWN_SORT_AZ);
    return DROPDOWN_SORT_VALUES.has(value) ? value : DROPDOWN_SORT_AZ;
}

export function cardViewMode(node) {
    const value = String(node.properties?.configCardView || CARD_VIEW_CARD);
    return CARD_VIEW_VALUES.has(value) ? value : CARD_VIEW_CARD;
}

// The .ddp-model-field host class for the active view; "" for the default tall card.
export function cardViewFieldClass(node) {
    const mode = cardViewMode(node);
    if (mode === CARD_VIEW_LIST) return " is-list";
    if (mode === CARD_VIEW_LIST_TEXT) return " is-list is-list-text";
    return "";
}

export function compareDropdownText(a, b) {
    return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
}

export function sortedComboOptions(node, options) {
    if (dropdownSortMode(node) !== DROPDOWN_SORT_AZ) return options;
    return [...options].sort(compareDropdownText);
}

function modelOptionSortText(option) {
    return option?.title || option?.value || "";
}

export function sortedModelOptions(node, options) {
    if (dropdownSortMode(node) !== DROPDOWN_SORT_AZ) return options;
    return [...options].sort((a, b) => compareDropdownText(modelOptionSortText(a), modelOptionSortText(b)));
}

export function hasEditableConfig(node) {
    return hasActive(node) || (activeName(node) === PLACEHOLDER && hasScratchConfig(node));
}

export function activeConfigValues(node, create = false) {
    const active = activeName(node);
    if (active && active !== PLACEHOLDER && node._configs?.[active]) {
        return configValueView(node, node._configs[active]);
    }
    if (active === PLACEHOLDER) {
        node._configs ||= {};
        if (create && !node._configs[SCRATCH_CONFIG]) node._configs[SCRATCH_CONFIG] = {};
        return configValueView(node, node._configs[SCRATCH_CONFIG] || null);
    }
    return null;
}

export function isEditMode(node) {
    return Boolean(node._configEditMode);
}

function setEditMode(node, enabled) {
    const next = Boolean(enabled);
    if (node._configEditMode === next) return;
    node._configEditMode = next;
    node._ddp?.delConfirm?.reset();
    renderAll(node);
}

// The node's Save button. In edit mode, a press with nothing left to save (a loaded preset,
// clean) finishes editing, so Save, then Save again, saves and leaves edit mode.
function saveOrFinishEditing(node) {
    if (isEditMode(node) && node._configPresetId && classifyConfigPreset(node) === LOCAL_STATUS.CLEAN) {
        setEditMode(node, false);
        return;
    }
    savePresetForNode(node);
}

function loadModel(node) {
    let data = {};
    try {
        data = JSON.parse(getWidget(node, DATA_WIDGET)?.value || "{}");
    } catch (e) {
        data = {};
    }
    node._fields = (Array.isArray(data.fields) ? data.fields : []).slice(0, MAX_OUTPUTS).map(normalizeField);
    node._configs = data.configs && typeof data.configs === "object" ? data.configs : {};
    node._sharedValues = data.shared_values && typeof data.shared_values === "object" && !Array.isArray(data.shared_values) ? { ...data.shared_values } : {};
    if (node._fields.length && !realConfigNames(node).length && !hasScratchConfig(node)) {
        node._configs[SCRATCH_CONFIG] = {};
    }
    node._configPresetDefault = node._configPresetDefault || node.properties?.configPresetDefault || "";
    if (!explicitDefaultConfig(node)) {
        node._configPresetDefault = "";
        persistConfigPresetDefault(node);
    }
}

// Persist fields + configs to the canonical widget.
export function writeData(node) {
    pruneSharedValues(node);
    const w = getWidget(node, DATA_WIDGET);
    if (w) w.value = JSON.stringify({ fields: node._fields, configs: node._configs, shared_values: node._sharedValues });
    updatePresetModifiedSlot(node);
    node.setDirtyCanvas(true, true);
}

function ensureSingleConfigOutput(node) {
    while ((node.outputs?.length || 0) > 1) {
        node.removeOutput(node.outputs.length - 1);
    }
    if (!node.outputs?.[0]) {
        node.addOutput("config", "KRC_CONFIG");
    } else {
        node.outputs[0].name = "config";
        node.outputs[0].type = "KRC_CONFIG";
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export function syncActiveOptions(node) {
    const w = getWidget(node, ACTIVE_WIDGET);
    if (!w) return;
    w.options.values = () => {
        const names = realConfigNames(node);
        if (activeName(node) === PLACEHOLDER && hasScratchConfig(node)) {
            return [PLACEHOLDER].concat(names);
        }
        return names.length ? names : [PLACEHOLDER];
    };
}

function activeConfigSelectOptions(node) {
    const names = realConfigNames(node);
    const defaultName = resolvedDefaultConfig(node);
    const options = names.map((name) => ({
        name,
        value: name,
        badge: name === defaultName ? "DEFAULT" : "",
    }));
    if (!names.length || (activeName(node) === PLACEHOLDER && hasScratchConfig(node))) {
        options.unshift({ name: PLACEHOLDER, value: PLACEHOLDER, muted: true });
    }
    return options;
}

// Make `name` the active config (dropdown pick or stepper).
function switchConfig(node, name) {
    if (!name || name === activeName(node)) return;
    node._ddp?.delConfirm?.reset();
    setActive(node, name);
    renderFields(node);
    renderBar(node);
    node.setDirtyCanvas(true, true);
}

// Step to the previous (-1) or next (+1) config in dropdown order, wrapping
// around. From the unsaved placeholder, next is the first and previous the last.
function cycleConfig(node, step) {
    const names = realConfigNames(node);
    if (names.length < 2 && hasActive(node)) return;
    if (!names.length) return;
    const index = names.indexOf(activeName(node));
    const next = index < 0
        ? (step > 0 ? 0 : names.length - 1)
        : (index + step + names.length) % names.length;
    switchConfig(node, names[next]);
}

export function renderBar(node) {
    const ui = node._ddp;
    if (!ui) return;
    const active = hasActive(node);
    const editing = isEditMode(node);
    const empty = isInitialBlankState(node);
    if (ui.emptyState) ui.emptyState.hidden = !empty;
    if (ui.bar) ui.bar.hidden = empty;
    if (ui.fields) ui.fields.hidden = empty;
    if (ui.addRow) ui.addRow.hidden = empty;
    ui.wrap.classList.toggle("is-empty-start", empty);
    ui.newConfig.textContent = "New";
    ui.newConfig.title = active ? "Duplicate current config" : "Create config from current values";
    ui.newConfig.classList.remove("is-save");
    ui.rename.disabled = !active;
    if (ui.saveConfigAs) ui.saveConfigAs.disabled = !active;
    ui.del.disabled = !active;
    if (ui.setDefaultConfig) {
        ui.setDefaultConfig.hidden = !active || activeName(node) === resolvedDefaultConfig(node);
    }
    if (ui.activeConfigSelect) {
        ui.activeConfigSelect.setOptions(activeConfigSelectOptions(node), activeName(node));
    }
    const configCount = realConfigNames(node).length;
    const cycleDisabled = active ? configCount < 2 : configCount < 1;
    if (ui.configCycleUp) ui.configCycleUp.disabled = cycleDisabled;
    if (ui.configCycleDown) ui.configCycleDown.disabled = cycleDisabled;
    if (ui.savePreset) ui.savePreset.disabled = false;
    ui.wrap.classList.toggle("is-editing-fields", editing);
    ui.wrap.classList.toggle("is-empty-parameters", (node._fields || []).length === 0);
    ui.editFields.classList.toggle("is-active", editing);
    ui.editFields.textContent = "✎";
    ui.editFields.title = editing ? "Hide parameter structure controls" : "Show parameter structure controls";
    ui.addFieldWrap.hidden = !editing;
    ui.addField.disabled = !editing || (node._fields || []).length >= MAX_OUTPUTS;
    if (!editing) closeFieldTypeMenu(node);
    if (!editing) closeStringOptionMenu(node);
    if (!editing) closeStringValuePopover(node, false);
    if (!editing) closeNumberOutputMenu(node);
    if (!active) ui.delConfirm?.reset();
    updatePresetModifiedSlot(node);
}

// Auto field names are type-based: the type's label lowercased ("string", "number",
// "switch", "combo", "model", "prompt"), de-duplicated with _2, _3, … against sibling
// fields. Model fields start generic ("model") and get relabeled to their modelType on
// drop (see applyModelDrop).
export function fieldTypeBaseName(type) {
    return String(FIELD_TYPE_LABELS[type] || type || "parameter").toLowerCase();
}

export function uniqueFieldName(node, base, excludeId = "") {
    const cleanBase = String(base || "parameter").trim() || "parameter";
    const taken = new Set((node._fields || [])
        .filter((f) => f.id !== excludeId)
        .map((f) => String(f.name || "").trim().toLowerCase())
        .filter(Boolean));
    if (!taken.has(cleanBase.toLowerCase())) return cleanBase;
    let n = 2;
    while (taken.has(`${cleanBase}_${n}`.toLowerCase())) n++;
    return `${cleanBase}_${n}`;
}

// True when a field name is still auto-generated (so a model drop may relabel it):
// blank, the legacy "parameter N", or one of the given bases with an optional _N suffix.
export function looksAutoNamed(name, bases) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return true;
    if (/^parameter \d+$/.test(n)) return true;
    return bases.some((base) => {
        const b = String(base || "").trim().toLowerCase();
        if (!b) return false;
        const esc = b.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return n === b || new RegExp(`^${esc}_\\d+$`).test(n);
    });
}

// ---------------------------------------------------------------------------
// Config operations
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// DOM build
// ---------------------------------------------------------------------------

function buildDom(node) {
    ensureConfigSwitcherStyles();

    const mkMenuBtn = (label, cls, fn) =>
        h("button", {
            class: `ddp-config-menu-item ${cls}`,
            text: label,
            onclick: () => {
                closeConfigActionMenu(node);
                fn(node);
            },
        });

    const newBtn = mkMenuBtn("New", "", newConfig);
    const saveConfigAsBtn = mkMenuBtn("Save as", "", saveConfigAs);
    saveConfigAsBtn.title = "Save the edited values as a new config; this config goes back to its saved values";
    const rename = mkMenuBtn("Rename", "", renameConfig);
    const setDefaultConfig = mkMenuBtn("Set as default", "", () => setConfigPresetDefault(node, activeName(node)));
    const del = h("button", { class: "ddp-btn ddp-danger", text: "Remove" });
    const delConfirm = armConfirmButton(del, {
        restoreText: "Remove",
        shouldArm: () => hasActive(node),
        onConfirm: () => {
            closeConfigActionMenu(node);
            removeConfig(node);
        },
    });
    del.className = "ddp-config-menu-item ddp-danger";
    const activeConfigSelect = createSearchableSelect({
        options: [],
        value: PLACEHOLDER,
        searchPlaceholder: "Search configs...",
        emptyText: "No configs found.",
        placeholder: PLACEHOLDER,
        buttonTitle: "Active config",
        ariaLabel: "Active config",
        fixedMenu: true,
        menuWidth: 240,
        menuClass: "ddp-config-select-menu",
        onSelect: (value) => switchConfig(node, value),
    });
    const configActionButton = h("button", {
        class: "ddp-btn ddp-config-action-button",
        title: "Config actions",
        "aria-label": "Config actions",
        onclick: () => toggleConfigActionMenu(node),
    }, [h("span", { class: "ddp-config-action-glyph", text: "▦" })]);
    // Up/down strip that steps through the config list (Resizer W/H stepper look).
    const mkCycleBtn = (glyph, step) => h("button", {
        class: "ddp-config-cycle-button",
        type: "button",
        tabIndex: -1,
        title: step < 0 ? "Previous config" : "Next config",
        "aria-label": step < 0 ? "Previous config" : "Next config",
        onclick: () => cycleConfig(node, step),
    }, [h("span", { class: `ddp-config-cycle-glyph ${step < 0 ? "is-up" : "is-down"}`, text: glyph })]);
    const configCycleUp = mkCycleBtn("▴", -1);
    const configCycleDown = mkCycleBtn("▾", 1);
    const configCycle = h("div", { class: "ddp-config-cycle" }, [configCycleUp, configCycleDown]);
    const activeConfigWrap = h("div", { class: "ddp-config-select-wrap" }, [activeConfigSelect.el, configCycle, configActionButton]);
    const configActionMenu = h("div", { class: "ddp-config-action-menu", hidden: true }, [newBtn, saveConfigAsBtn, rename, setDefaultConfig, del]);
    document.body.appendChild(configActionMenu);
    const configStatusGroup = h("div", { class: "ddp-config-status-group" }, [activeConfigWrap]);
    const presetModSlot = h("div", { class: "ddp-top-modified-slot" });
    const emptyNew = h("button", {
        class: "krc-save-button ddp-empty-action",
        text: "new",
        title: "Create a new preset",
        onclick: () => startInitialNew(node),
    });
    const emptyLoad = h("button", {
        class: "krc-save-button ddp-empty-action",
        text: "load",
        title: "Load an existing preset",
        onclick: () => openInitialLoadModal(node),
    });
    const emptyActions = h("div", { class: "ddp-empty-actions" }, [emptyNew, emptyLoad]);

    const fields = h("div", { class: "ddp-fields" });
    const editFields = h("button", {
        class: "ddp-btn ddp-edit-fields",
        text: "✎",
        title: "Show parameter structure controls",
        "aria-label": "Edit parameters",
        onclick: () => setEditMode(node, !isEditMode(node)),
    });
    const savePreset = h("button", {
        class: "krc-save-button ddp-preset-save",
        text: "save",
        title: "Save current Config Switcher preset",
        onclick: () => saveOrFinishEditing(node),
    });
    const addFieldBtn = h("button", {
        class: "ddp-btn ddp-add-field",
        text: "+ Parameter",
        title: "Choose a parameter type to add",
        onclick: () => toggleFieldTypeMenu(node),
    });
    const addFieldMenu = h("div", { class: "ddp-add-field-menu", hidden: true },
        ADDABLE_FIELD_TYPES.map((type) =>
            h("button", {
                class: "ddp-add-field-option",
                text: FIELD_TYPE_LABELS[type] || type,
                onclick: () => {
                    const initialNew = Boolean(node._configInitialNew);
                    closeFieldTypeMenu(node);
                    if (initialNew) {
                        createInitialPresetWithField(node, type).catch((e) => {
                            krcAlert(`Config Switcher: ${e.message || "could not create preset."}`, node);
                        });
                    } else {
                        addField(node, type);
                    }
                },
            })
        )
    );
    document.body.appendChild(addFieldMenu);
    const addFieldWrap = h("div", { class: "ddp-add-field-wrap", hidden: true }, [addFieldBtn]);
    const closeMenuOnOutsidePointer = (event) => {
        if (addFieldMenu.hidden) return;
        if (addFieldMenu.contains(event.target) || addFieldBtn.contains(event.target)) return;
        closeFieldTypeMenu(node);
    };
    const closeConfigMenuOnOutsidePointer = (event) => {
        if (configActionMenu.hidden) return;
        if (configActionMenu.contains(event.target) || configActionButton.contains(event.target)) return;
        closeConfigActionMenu(node);
    };
    const closeMenuOnViewportChange = (event) => {
        // The floating menus are pinned to fixed viewport coordinates, so a real
        // page/pane scroll (or resize) must close them or they drift off their
        // anchor. But a scroll event ALSO fires when a menu scrolls its OWN
        // overflow — and since this listener is on window in the capture phase it
        // sees that too. Closing on the menu's internal scroll made the model list
        // impossible to scroll (it shut the instant it moved), so ignore scrolls
        // that originate inside either floating menu.
        if (event?.type === "scroll") {
            const t = event.target;
            const modelMenu = node._ddp?.modelOptionMenu;
            const promptMenu = node._ddp?.promptOptionMenu;
            const stringMenu = node._ddp?.stringOptionMenu;
            const stringPopover = node._ddp?.stringValuePopover?.popover;
            const numberMenu = node._ddp?.numberOutputMenu;
            if ((modelMenu && (t === modelMenu || modelMenu.contains?.(t))) ||
                (promptMenu && (t === promptMenu || promptMenu.contains?.(t))) ||
                (stringMenu && (t === stringMenu || stringMenu.contains?.(t))) ||
                (stringPopover && (t === stringPopover || stringPopover.contains?.(t))) ||
                (numberMenu && (t === numberMenu || numberMenu.contains?.(t))) ||
                t === addFieldMenu || addFieldMenu.contains?.(t)) {
                return;
            }
        }
        closeFieldTypeMenu(node);
        closeConfigActionMenu(node);
        closeModelOptionMenu(node);
        closePromptOptionMenu(node);
        closeStringOptionMenu(node);
        closeStringValuePopover(node, false);
        closeNumberOutputMenu(node);
    };
    document.addEventListener("pointerdown", closeMenuOnOutsidePointer, true);
    document.addEventListener("pointerdown", closeConfigMenuOnOutsidePointer, true);
    window.addEventListener("resize", closeMenuOnViewportChange);
    window.addEventListener("scroll", closeMenuOnViewportChange, true);
    const unsubscribeConfigPresetChanges = subscribeKrcSync(CONFIG_PRESETS_CHANGED_EVENT, (event) => {
        if (isOwnSyncEvent(event, configSyncSource(node))) return;
        // A group renamed / ungrouped / deleted elsewhere: a filter on it follows.
        const filter = node._configPresetPrefixFilter || node.properties?.configPresetPrefixFilter || "";
        const followed = followGroupChange(filter, event);
        if (followed !== filter) {
            node._configPresetPrefixFilter = followed;
            node.properties ||= {};
            node.properties.configPresetPrefixFilter = followed;
        }
        // The Options modal's own subscriber does the fuller reload while it's open.
        if (node._configOptionsModalOpen) return;
        refreshConfigPresetGlobalSnapshot(node);
    });
    // Read-only live metadata sync: mirror sibling LoRA/model display changes onto
    // this node's model-option cards, persist and repaint. No echo guard needed — CS never
    // publishes metadata events. Pins don't show on option cards.
    const unsubscribeModelMetadataChanges = subscribeKrcSync(KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, (event) => {
        const detail = event?.detail || {};
        if (Array.isArray(detail.fields) && detail.fields.length && detail.fields.every((field) => field === "pinned")) return;
        if (detail.record) {
            refreshModelCardRecords(node, detail);
            return;
        }
        // Persist too, so the updated cards survive a reload.
        const changed = detail.thumbnail
            ? applyLibraryThumbnailToOptions(node, detail)
            : applyLibraryMetadataToOptions(node, detail);
        if (changed) {
            writeData(node);
            renderFields(node);
        } else {
            refreshModelCardStatus(node);
        }
    });
    // A model moved outside KRC (the server healed it on a run or noticed it on a browse):
    // point this node's options and configs at the new path, without a modification.
    installLibraryHealBridge();
    // (The server already rewrote the saved presets for these moves.)
    const unsubscribeLibraryHealed = subscribeKrcSync(KRC_SYNC_EVENTS.LIBRARY_HEALED, (event) => {
        if (applyModelPathMoves(node, event?.detail?.heal?.moves)) {
            writeData(node);
            renderFields(node);
        }
        refreshModelCardStatus(node);   // a rescan also adds and removes files
    });
    // A Refresh, an import or a Civitai batch: files may have come or gone.
    const unsubscribeLibraryChanged = subscribeKrcSync(KRC_SYNC_EVENTS.LIBRARY_CHANGED, () => refreshModelCardStatus(node));
    // A model stabilized while this node is open (local- id -> content SHA256) keeps its
    // card: the option takes the new id. Identity is display data, never Modified.
    const unsubscribeIdentityChanged = subscribeKrcSync(KRC_SYNC_EVENTS.IDENTITY_CHANGED, (event) => {
        if (applyModelIdentityChange(node, event?.detail?.identity)) {
            writeData(node);
            renderFields(node);
        }
        refreshModelCardStatus(node);
    });
    const unsubscribePromptLibrary = subscribeKrcSync(KRC_SYNC_EVENTS.PROMPT_LIBRARY_UPDATED, (event) => {
        const prompts = event?.detail?.prompts;
        if (applyPromptLibraryToOptions(node, prompts)) {
            writeData(node);
            renderFields(node);
        }
        followPromptEdits(node, prompts);
    });
    // Works even when no Prompt Vault is mounted to reload and relay the library.
    const unsubscribePromptsChanged = subscribeKrcSync(KRC_SYNC_EVENTS.PROMPTS_CHANGED, () => refreshPromptCards(node));
    // A run found a prompt's stored text out of date (edited where no node was listening)
    // and already rewrote the saved presets: take the same text here.
    const onPromptTextsPush = (event) => {
        if (applyPromptTextChanges(node, event?.detail?.texts)) {
            writeData(node);
            renderFields(node);
        }
    };
    api.addEventListener(PROMPT_TEXTS_EVENT, onPromptTextsPush);
    const prevOnRemoved = node.onRemoved;
    node.onRemoved = function () {
        document.removeEventListener("pointerdown", closeMenuOnOutsidePointer, true);
        document.removeEventListener("pointerdown", closeConfigMenuOnOutsidePointer, true);
        window.removeEventListener("resize", closeMenuOnViewportChange);
        window.removeEventListener("scroll", closeMenuOnViewportChange, true);
        unsubscribeConfigPresetChanges();
        unsubscribeModelMetadataChanges();
        unsubscribeLibraryHealed();
        unsubscribeLibraryChanged();
        unsubscribeIdentityChanged();
        unsubscribePromptLibrary();
        unsubscribePromptsChanged();
        api.removeEventListener(PROMPT_TEXTS_EVENT, onPromptTextsPush);
        closeModelOptionMenu(node);
        closePromptOptionMenu(node);
        closeStringOptionMenu(node);
        closeStringValuePopover(node, false);
        closeNumberOutputMenu(node);
        configActionMenu.remove();
        addFieldMenu.remove();
        return prevOnRemoved ? prevOnRemoved.apply(this, arguments) : undefined;
    };
    const makeOptionsButton = () => h("button", {
        class: "ddp-io",
        title: "Options",
        "aria-label": "Options",
        onclick: () => openIOModal(node),
    }, h("span", { class: "krc-gear-glyph" }));
    const io = makeOptionsButton();
    const emptyIo = makeOptionsButton();
    const emptyOptionsRow = h("div", { class: "ddp-empty-options-row" }, [emptyIo]);
    const emptyState = h("div", { class: "ddp-empty-state" }, [emptyActions, emptyOptionsRow]);

    // Top-right Browse button opens the shared library modal at the model/parent
    // view (all model types); mirrors LoRA Loadout's Browse button design.
    const browseLibrary = h("button", {
        class: "krc-browse-button ddp-browse",
        text: "Browse",
        title: "Browse the model library",
        "aria-label": "Browse the model library",
        // The last model or prompt viewed (a later Media tab visit doesn't count); else Models, all types.
        onclick: () => openLibraryModal({ provider: "models", scope: "all", resume: { tabs: ["models", "prompts"] } }),
    });
    const barRight = h("div", { class: "ddp-bar-right" }, [presetModSlot, browseLibrary]);
    const bar = h("div", { class: "ddp-bar" }, [configStatusGroup, barRight]);
    // The loaded preset's "Group · Name", left of the buttons: a label only (Options switches presets).
    const presetLabel = h("div", { class: "ddp-preset-label" });
    const addRow = h("div", { class: "ddp-addrow" }, [presetLabel, addFieldWrap, editFields, savePreset, io]);
    const panel = h("div", { class: "ddp-panel" }, [
        emptyState,
        bar,
        fields,
        addRow,
    ]);
    const wrap = h("div", { class: "krc-node ddp-wrap" }, [panel]);

    node._ddp = { wrap, emptyState, emptyNew, emptyLoad, bar, addRow, activeConfigSelect, activeConfigWrap, newConfig: newBtn, saveConfigAs: saveConfigAsBtn, rename, setDefaultConfig, del, delConfirm, configCycleUp, configCycleDown, configActionButton, configActionMenu, presetModSlot, presetLabel, savePreset, fields, editFields, addField: addFieldBtn, addFieldWrap, addFieldMenu };
    applyNodePalette(node, wrap); // restore any saved per-node palette

    const widget = node.addDOMWidget(NODE_NAME, "ddp-ui", wrap, {
        serialize: false,
        getMinHeight() {
            return calcConfigDomHeight(node);
        },
    });
    widget.computeSize = (width) => [width ?? MIN_W, calcConfigDomHeight(node)];
    promoteDomWidgetAfterVisible(node, widget);
    // Once mounted the renderer is known: the classic canvas sizes from the shared edge.
    requestAnimationFrame(() => requestAnimationFrame(() => {
        if (node._ddp && node.graph) resizeConfigNode(node);
    }));
    return widget;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

app.registerExtension({
    name: "KRC.ConfigSwitcher",
    setup() {
        installConfigSwitcherStatsHook();
        const disableAllEditModes = () => {
            for (const node of app.graph?._nodes ?? []) {
                const nodeClass = node.comfyClass ?? node.type;
                if (NODE_NAMES.has(nodeClass) && node._configEditMode) {
                    setEditMode(node, false);
                }
            }
        };

        const origQueue = app.queuePrompt?.bind(app);
        if (typeof origQueue === "function" && !app._krcConfigSwitcherQueueHooked) {
            app.queuePrompt = async function (...args) {
                disableAllEditModes();
                return origQueue(...args);
            };
            app._krcConfigSwitcherQueueHooked = true;
        }

        api.addEventListener("execution_start", disableAllEditModes);
        api.addEventListener("execution_success", disableAllEditModes);
    },

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (!NODE_NAMES.has(nodeData.name)) return;

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            onNodeCreated?.apply(this, arguments);
            this._configEditMode = false;
            applyNodeColors(this);
            hideWidget(getWidget(this, DATA_WIDGET));
            hideWidget(getWidget(this, PRESET_ID_WIDGET));
            // Switching the active config reloads the value draft.
            const aw = getWidget(this, ACTIVE_WIDGET);
            if (aw) {
                const prev = aw.callback;
                aw.callback = (...a) => {
                    prev?.apply(this, a);
                    this._ddp?.delConfirm?.reset();
                    renderFields(this);
                    renderBar(this);
                };
                hideWidget(aw);
            }
            buildDom(this);
            installSeedRunHook(this);
            installNoteRunStrip(getWidget(this, DATA_WIDGET));
            registerConfigSwitcherNode(this);
            loadModel(this);
            ensureSingleConfigOutput(this);
            renderAll(this);
            restorePersistedPresetSnapshot(this);
        };

        // On load, the saved config_data is restored first; rebuild the editor.
        const onConfigure = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            onConfigure?.apply(this, arguments);
            this._configEditMode = false;
            applyNodeColors(this);
            hideWidget(getWidget(this, DATA_WIDGET));
            hideWidget(getWidget(this, ACTIVE_WIDGET));
            hideWidget(getWidget(this, PRESET_ID_WIDGET));
            ensureSingleConfigOutput(this);
            // Restore the persisted preset selection so the picker (and modified
            // badge, once the modal reloads presets) reflects the saved preset.
            setConfigPresetId(this, this._configPresetId || persistedConfigPresetId(this));
            if (this._ddp) {
                loadModel(this);
                renderAll(this);
                restorePersistedPresetSnapshot(this);
                scheduleCardCatchUp(this);
                // node.properties is restored now: re-stamp the per-node palette
                // (buildDom's stamp ran pre-configure, so Native reverted to the
                // global palette), and resize from field-count math like WordBank
                // instead of from stale LiteGraph/DOM measurements.
                applyNodePalette(this, this._ddp.wrap);
                resizeConfigNode(this);
                // LiteGraph applies the serialized (possibly stale/tall) size and
                // runs its own DOM-widget layout pass *after* onConfigure, which
                // can leave the node over-tall with extra bottom padding until a
                // manual resize re-clamps it. Re-assert the field-count height on
                // the next frame, once that pass has settled, so the fit wins
                // deterministically instead of racing it.
                requestAnimationFrame(() => {
                    if (this._ddp) resizeConfigNode(this);
                });
            }
        };

        // Grow freely; never shrink below the minimum width or content height. On the
        // classic canvas the UI follows the new height (Node 2.0 does that itself).
        const onResize = nodeType.prototype.onResize;
        nodeType.prototype.onResize = function (size) {
            size[0] = Math.max(size[0], MIN_W);
            size[1] = Math.max(size[1], calcConfigNodeHeight(this));
            stampConfigDomHeight(this, size[1]);
            return onResize?.apply(this, arguments);
        };
    },
});
