// Config Switcher value controls: the per-type value editor for a field row (Combo with
// its saved-option menu, raw STRING with its single/multi-line popover, Number with its
// output format, the Switch toggle).
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { h } from "./helpers.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { stopCanvasEvents } from "../shared/dom.js";
import { stepNumberText } from "./number_step.js";
import { STRING_OPTION_CAP, formatStringOptionList, planStringOptionList } from "./string_option_list.js";
import { showToast } from "../shared/toast.js";
import { configValueStores, configValueView } from "./shared_values.js";
import {
    activeConfigValues,
    activeName,
    applyFloatingMenuPalette,
    NUMBER_OUTPUT_FORMAT_IDS,
    NUMBER_OUTPUT_FORMATS,
    sortedComboOptions,
    writeData,
} from "./config.js";
import { buildPromptDropControl, installPromptDrop } from "./prompt_field.js";
import { buildModelDropControl } from "./model_field.js";
import { renderFields, resizeConfigNode } from "./field_rows.js";
import { buildSeedValueControl } from "./seed_field.js";
import { planFieldCapture } from "./link.js";
import {
    buildDynamicComboControl,
    convertFieldToCombo,
    convertFieldToDynamic,
    dynamicCaptureSummary,
    dynamicOptionRow,
    hideDynamicOption,
    restoreDynamicOption,
} from "./dynamic_combo_field.js";
import { cleanDynamicHidden } from "./dynamic_combo.js";

// Build the value control for a field in the active config, by field type.
// Writes the (string-encoded) value directly into the active config.
export function buildValueControl(node, field, disabled, editing) {
    const set = (v) => {
        const config = activeConfigValues(node, true);
        if (!config) return;
        config[field.id] = v;
        writeData(node);
    };
    const values = activeConfigValues(node, false);
    const value = values?.[field.id];
    if (field.type === "model") {
        return buildModelDropControl(node, field, value, disabled);
    }

    if (field.type === "prompt") {
        return buildPromptDropControl(node, field, value, disabled);
    }

    if (field.type === "seed") {
        return buildSeedValueControl(node, field, disabled);
    }

    if (field.type === "dynamic_combo") {
        return buildDynamicComboControl(node, field, disabled, editing);
    }

    if (field.type === "boolean") {
        const on = String(value).toLowerCase() === "true";
        const btn = h("button", {
            class: "ddp-bool-toggle" + (on ? " is-on" : ""),
            type: "button",
            "aria-pressed": on ? "true" : "false",
            title: "Switch value on or off",
            disabled,
            onclick: () => {
                const current = activeConfigValues(node, false)?.[field.id];
                const next = !(String(current).toLowerCase() === "true");
                set(next ? "true" : "false");
                btn.classList.toggle("is-on", next);
                btn.setAttribute("aria-pressed", next ? "true" : "false");
            },
        }, [
            h("span", { class: "ddp-bool-track" }, [
                h("span", { class: "ddp-bool-knob" }),
            ]),
        ]);
        return btn;
    }

    if (field.type === "number") {
        const integerMode = numberOutputFormat(field).id === "integer";
        const sanitize = (raw) => integerMode ? sanitizeIntegerInput(raw) : String(raw ?? "");
        const input = h("input", {
            class: "ddp-input ddp-number-input",
            type: "text",
            inputmode: integerMode ? "numeric" : "decimal",
            placeholder: disabled ? "add a parameter first" : "number value",
            value: sanitize(value ?? ""),
            disabled,
            oninput: (e) => {
                const next = sanitize(e.target.value);
                if (next !== e.target.value) e.target.value = next;
                set(next);
            },
            onblur: (e) => {
                if (!integerMode) return;
                const next = normalizeIntegerValue(e.target.value);
                if (next !== e.target.value) {
                    e.target.value = next;
                    set(next);
                }
            },
        });
        // Integer 1, Float 0.1, Auto by how the value is written (number_step.js).
        const stepBy = (direction) => {
            if (disabled) return;
            input.value = sanitize(stepNumberText(input.value, direction, numberOutputFormat(field).id));
            set(input.value);
            input.focus();
        };
        return h("div", { class: "ddp-number-value" }, [
            input,
            h("button", {
                class: "ddp-number-step",
                type: "button",
                title: "Decrease value",
                disabled,
                onclick: () => stepBy(-1),
            }, h("span", { class: "ddp-number-step-glyph ddp-number-step-glyph-minus", text: "−" })),
            h("button", {
                class: "ddp-number-step",
                type: "button",
                title: "Increase value",
                disabled,
                onclick: () => stepBy(1),
            }, h("span", { class: "ddp-number-step-glyph ddp-number-step-glyph-plus", text: "+" })),
            buildNumberOutputButton(node, field, editing),
        ]);
    }

    if (field.type === "combo") {
        return buildStringValueControl(node, field, value, "combo value", disabled, editing, set);
    }

    // Raw STRING — a plain text input whose value is emitted verbatim (no saved
    // option picker, no number/bool coercion). Also the fallback for any
    // unrecognized type. (buildStringValueControl above is the Combo control; its
    // name is legacy — the raw-text control is this branch.) A Prompt Vault card can
    // be dropped here to snapshot its prompt text into the value (snapshot mode).
    const placeholder = disabled ? "add a parameter first" : "string value";
    const control = field.stringMultiline
        // textarea text is child content, not a value attribute (see the h() helper).
        ? h("textarea", {
            class: "ddp-input ddp-string-input ddp-string-textarea",
            placeholder,
            disabled,
            rows: 3,
            oninput: (e) => set(e.target.value),
        }, [String(value ?? "")])
        : h("input", {
            class: "ddp-input ddp-string-input",
            type: "text",
            placeholder,
            value: value ?? "",
            disabled,
            oninput: (e) => set(e.target.value),
        });
    if (!disabled) installPromptDrop(node, field, control, set);
    const linesBtn = buildStringLinesButton(node, field, editing);
    return linesBtn ? h("div", { class: "ddp-string-value" }, [control, linesBtn]) : control;
}

// Per-field single/multi-line toggle for raw STRING fields (edit mode only). Multi-line
// swaps the input for a textarea so pasted/dropped multi-line prompts (e.g. APPEND'd
// A+B) are readable; it also grows the field row (see fieldRowHeight).
function buildStringLinesButton(node, field, editing) {
    if (!editing) return null;
    const multi = Boolean(field.stringMultiline);
    return h("button", {
        class: "ddp-icon ddp-string-lines" + (multi ? " is-on" : ""),
        type: "button",
        title: multi ? "Value input: multi-line (click for single line)" : "Value input: single line (click for multi-line)",
        text: multi ? "≡" : "—",
        onclick: (event) => {
            event.stopPropagation();
            setStringMultiline(node, field, !multi);
        },
    });
}

function setStringMultiline(node, field, multi) {
    field.stringMultiline = Boolean(multi);
    writeData(node);
    renderFields(node);
    resizeConfigNode(node);
}

function normalizeStringOption(value) {
    return String(value || "").trim();
}

function hasStringOption(field, value) {
    const next = normalizeStringOption(value).toLowerCase();
    if (!next) return false;
    return (field.options || []).some((item) => normalizeStringOption(item).toLowerCase() === next);
}

function rememberStringOption(field, value) {
    const option = normalizeStringOption(value);
    if (!option || hasStringOption(field, option)) return false;
    field.options = [option, ...(field.options || []).filter((item) => normalizeStringOption(item).toLowerCase() !== option.toLowerCase())].slice(0, STRING_OPTION_CAP);
    return true;
}

// Names of every config (scratch included) whose value for this combo field is the
// given saved option (same case-insensitive match as hasStringOption).
function configsUsingStringOption(node, field, value) {
    const key = normalizeStringOption(value).toLowerCase();
    if (!key) return [];
    return Object.entries(node._configs || {})
        .filter(([, config]) => config && normalizeStringOption(configValueView(node, config)[field.id]).toLowerCase() === key)
        .map(([name]) => name);
}

// Every stored value that picked this option (each config, a shared field's hidden
// per-config values included, and the shared value) takes `next`.
function setStringOptionValues(node, field, value, next) {
    const key = normalizeStringOption(value).toLowerCase();
    if (!key) return;
    for (const values of configValueStores(node)) {
        if (values && normalizeStringOption(values[field.id]).toLowerCase() === key) values[field.id] = next;
    }
}

function setStringFieldValue(node, field, value) {
    const config = activeConfigValues(node, true);
    if (!config) return;
    config[field.id] = value || "";
}

export function closeStringValuePopover(node, confirm = false) {
    node._ddp?.stringValuePopover?.close?.(confirm);
    if (node._ddp) node._ddp.stringValuePopover = null;
}

export function closeStringOptionMenu(node) {
    node._ddp?.stringOptionClose?.();
    if (node._ddp) node._ddp.stringOptionClose = null;
    node._ddp?.stringOptionMenu?.remove?.();
    if (node._ddp) node._ddp.stringOptionMenu = null;
}

export function selectStringOption(node, field, value) {
    setStringFieldValue(node, field, value);
    writeData(node);
    closeStringOptionMenu(node);
    renderFields(node);
}

function replaceStringOption(node, field, oldValue, nextValue) {
    const oldKey = normalizeStringOption(oldValue).toLowerCase();
    const next = normalizeStringOption(nextValue);
    if (!oldKey || !next) return false;
    const nextKey = next.toLowerCase();
    const duplicate = (field.options || []).some((item) => {
        const key = normalizeStringOption(item).toLowerCase();
        return key === nextKey && key !== oldKey;
    });
    if (duplicate) return false;
    field.options = (field.options || []).map((item) => normalizeStringOption(item).toLowerCase() === oldKey ? next : item);
    // Every config that picked the old spelling follows it — not just the active one,
    // which would leave the others holding a value that's no longer in the list.
    setStringOptionValues(node, field, oldValue, next);
    writeData(node);
    renderFields(node);
    return true;
}

function removeStringOption(node, field, value) {
    const target = normalizeStringOption(value).toLowerCase();
    if (!target) return;
    field.options = (field.options || []).filter((item) => normalizeStringOption(item).toLowerCase() !== target);
    // Clear it in every config that picked it (the row's × confirms first when other
    // configs are affected); those fields then flag as empty.
    setStringOptionValues(node, field, value, "");
    writeData(node);
    renderFields(node);
}

// A dropdown row: a pick only (saved values are managed in the + popover).
export function stringOptionRow(node, field, option, selected) {
    return h("div", {
        class: "ddp-string-option" + (selected ? " is-selected" : ""),
        role: "button",
        tabindex: "0",
        title: option,
        onclick: () => selectStringOption(node, field, option),
        onkeydown: (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            selectStringOption(node, field, option);
        },
    }, [h("span", { class: "ddp-string-option-label", text: option })]);
}

// One value in the manager's Items view: the dropdown's row style, not a pick (picking is
// the dropdown's). `onEdit(row)` edits it in place; `removeButton` (a saved value's armed
// remove) or `onRemove` removes it. In a captured draft, `isNew` marks a value the capture
// adds, and a `removed` value (one the capture drops) shows struck through with `onRestore`.
function popoverItemRow(option, { isNew = false, removed = false, onEdit = null, onRemove = null, removeButton = null, onRestore = null } = {}) {
    const button = (className, glyph, title, onClick) => h("button", {
        class: className,
        type: "button",
        title,
        text: glyph,
        onclick: (event) => {
            event.stopPropagation();
            onClick();
        },
    });
    const label = h("span", { class: "ddp-string-option-label" }, [
        h("span", { class: "ddp-string-option-text", text: option }),
        ...(isNew ? [h("span", { class: "ddp-string-option-badge", text: "new" })] : []),
    ]);
    const row = h("div", {
        class: ["ddp-string-option", "is-item", removed ? "is-dropped" : "is-editing", isNew ? "is-new" : ""].filter(Boolean).join(" "),
        role: "listitem",
        title: removed ? `${option}: not offered by the linked node; SAVE removes it` : option,
    }, [label]);
    if (removed) {
        row.append(button("ddp-string-option-edit", "\u21ba", "Keep this saved value", onRestore));
    } else {
        row.append(
            button("ddp-string-option-edit", "\u270e", "Edit", () => onEdit(row)),
            removeButton || button("ddp-string-option-remove", "\u00d7", "Leave out of the captured list", onRemove),
        );
    }
    return row;
}

// Removing an option clears it in every config that picked it, so × always arms first
// (one rule, however many configs use it); the armed title says what it clears.
function buildStringOptionRemoveButton(node, field, option, onRemoved) {
    const title = "Remove saved value";
    const others = configsUsingStringOption(node, field, option).filter((name) => name !== activeName(node)).length;
    const button = h("button", { class: "ddp-string-option-remove", type: "button", title, text: "\u00d7" });
    armConfirmButton(button, {
        armedText: "\u2715",
        armedTitle: others
            ? `Used in ${others} other config${others === 1 ? "" : "s"}. Click again to remove it and clear ${others === 1 ? "that config" : "those configs"}`
            : "Click again to remove it",
        restoreText: "\u00d7",
        restoreTitle: title,
        stopPropagation: true,
        onConfirm: () => {
            removeStringOption(node, field, option);
            onRemoved?.();
        },
    });
    return button;
}

function renderStringOptionMenuContents(node, field, menu) {
    const value = String(activeConfigValues(node, false)?.[field.id] || "");
    const options = sortedComboOptions(node, (field.options || []).map(normalizeStringOption).filter(Boolean));
    menu.replaceChildren();
    if (options.length) {
        options.forEach((option) => menu.append(stringOptionRow(node, field, option, option === value)));
    } else {
        menu.append(h("div", { class: "ddp-string-empty", text: "No saved values yet" }));
    }
}

// The dropdown's floating menu under `anchor`; `render(node, field, menu)` fills it (a
// combo's saved values by default, a DYNAMIC COMBO's options: dynamic_combo_field.js).
export function openStringOptionMenu(node, field, anchor, render = renderStringOptionMenuContents) {
    closeStringValuePopover(node, false);
    closeStringOptionMenu(node);
    const menu = h("div", { class: "krc-node ddp-string-menu" });
    applyFloatingMenuPalette(node, menu);
    render(node, field, menu);
    document.body.appendChild(menu);
    node._ddp.stringOptionMenu = menu;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 240;
    const margin = 8;
    menu.style.width = `${menuWidth}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin))}px`;
    const menuH = Math.min(menu.scrollHeight, menu.offsetHeight || 220);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const top = (spaceBelow >= menuH || spaceBelow >= spaceAbove)
        ? Math.min(rect.bottom + 4, window.innerHeight - menuH - margin)
        : Math.max(margin, rect.top - 4 - menuH);
    menu.style.top = `${Math.max(margin, top)}px`;
    const closeOnOutside = (event) => {
        if (menu.contains(event.target) || anchor.contains(event.target)) return;
        closeStringOptionMenu(node);
    };
    node._ddp.stringOptionClose = () => {
        document.removeEventListener("pointerdown", closeOnOutside, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
}

export function numberOutputFormat(field) {
    const id = field?.numberOutput || "auto";
    return NUMBER_OUTPUT_FORMATS.find((format) => format.id === id) || NUMBER_OUTPUT_FORMATS[0];
}

function sanitizeIntegerInput(raw) {
    const text = String(raw ?? "");
    const trimmed = text.trim();
    if (!trimmed) return "";
    if (trimmed === "-") return "-";
    const match = trimmed.match(/^-?\d+/) || trimmed.match(/-?\d+/);
    return match ? match[0] : "";
}

function normalizeIntegerValue(raw) {
    const text = sanitizeIntegerInput(raw);
    if (!text || text === "-") return "";
    return String(Number.parseInt(text, 10));
}

export function closeNumberOutputMenu(node) {
    node._ddp?.numberOutputClose?.();
    if (node._ddp) node._ddp.numberOutputClose = null;
    node._ddp?.numberOutputMenu?.remove?.();
    if (node._ddp) node._ddp.numberOutputMenu = null;
}

function setNumberOutputFormat(node, field, formatId) {
    field.numberOutput = NUMBER_OUTPUT_FORMAT_IDS.has(formatId) ? formatId : "auto";
    if (field.numberOutput === "integer") {
        const config = activeConfigValues(node, false);
        if (config && Object.prototype.hasOwnProperty.call(config, field.id)) {
            config[field.id] = normalizeIntegerValue(config[field.id]);
        }
    }
    writeData(node);
    closeNumberOutputMenu(node);
    renderFields(node);
}

function numberOutputOptionRow(node, field, format) {
    const selected = numberOutputFormat(field).id === format.id;
    return h("button", {
        class: "ddp-number-format-option" + (selected ? " is-selected" : ""),
        type: "button",
        title: format.title,
        text: format.label,
        onclick: () => setNumberOutputFormat(node, field, format.id),
    });
}

function openNumberOutputMenu(node, field, anchor) {
    closeStringValuePopover(node, false);
    closeStringOptionMenu(node);
    closeNumberOutputMenu(node);
    const menu = h("div", { class: "krc-node ddp-number-format-menu" });
    applyFloatingMenuPalette(node, menu);
    NUMBER_OUTPUT_FORMATS.forEach((format) => menu.append(numberOutputOptionRow(node, field, format)));
    document.body.appendChild(menu);
    node._ddp.numberOutputMenu = menu;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 132;
    const margin = 8;
    menu.style.width = `${menuWidth}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin))}px`;
    const menuH = Math.min(menu.scrollHeight, menu.offsetHeight || 120);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const top = (spaceBelow >= menuH || spaceBelow >= spaceAbove)
        ? Math.min(rect.bottom + 4, window.innerHeight - menuH - margin)
        : Math.max(margin, rect.top - 4 - menuH);
    menu.style.top = `${Math.max(margin, top)}px`;
    const closeOnOutside = (event) => {
        if (menu.contains(event.target) || anchor.contains(event.target)) return;
        closeNumberOutputMenu(node);
    };
    node._ddp.numberOutputClose = () => {
        document.removeEventListener("pointerdown", closeOnOutside, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
}

function buildNumberOutputButton(node, field, editing) {
    if (!editing) return null;
    const format = numberOutputFormat(field);
    return h("button", {
        class: "ddp-icon ddp-number-format",
        type: "button",
        title: `Number output: ${format.label}`,
        text: "#",
        onclick: (event) => {
            event.stopPropagation();
            openNumberOutputMenu(node, field, event.currentTarget);
        },
    });
}

// Toggle emits a real boolean; the value control is just the toggle (the output-
// format picker was removed — a two-option Combo covers stringy toggle roles).
export function buildBooleanValueControl(node, field, disabled, editing) {
    return h("div", { class: "ddp-boolean-value" }, [
        buildValueControl(node, field, disabled, editing),
    ]);
}

// The popover lives on document.body (fixed, viewport coordinates) like the option
// menu, so it shows past the node's edges. `below`: always open under the anchor
// (Add Value), only moved up as far as it must to stay on screen; otherwise it flips
// above when there's no room below.
export function clampStringValuePopover({ popover, anchor, close, below = false }) {
    if (!anchor?.isConnected) {
        close(false);
        return;
    }
    const rect = anchor.getBoundingClientRect();
    const width = popover.offsetWidth || 260;
    const height = popover.offsetHeight || 68;
    const margin = 8;
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin));
    const belowTop = rect.bottom + 6;
    const fits = belowTop + height <= window.innerHeight - margin;
    const top = fits ? belowTop
        : below ? Math.max(margin, window.innerHeight - height - margin)
        : Math.max(margin, rect.top - height - 6);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
}

function openStringValuePopover(node, field, initialAnchor) {
    closeStringValuePopover(node, false);
    closeStringOptionMenu(node);
    if (!node._ddp?.wrap) return;
    let closed = false;
    const popover = h("div", {
        class: "krc-node ddp-string-popover",
        role: "dialog",
        "aria-label": "Saved Values",
    });
    applyFloatingMenuPalette(node, popover);
    stopCanvasEvents(popover);
    const titleEl = h("div", { class: "ddp-string-popover-title", text: "Saved Values" });
    // The saved-values manager: an Items view (each value a row, edit / remove) or a Text
    // view (every value as text, one per line, SAVEd as the new list), with the add field
    // always below. It reopens in the view last used on this node.
    let mode = node._ddp.stringAddMode === "list" ? "list" : "items";
    // A DYNAMIC COMBO's options come from Capture (CS_DYNAMIC_COMBO_GAMEPLAN.md D14): Items
    // only, no typed values. A capture may convert the field either way; until SAVE:
    const isDynamic = field.type === "dynamic_combo";
    let pendingDynamic = null;   // the schema a capture converts / updates the field to
    let pendingCombo = false;    // a DYNAMIC COMBO turning back into a COMBO (the draft list)
    if (isDynamic) mode = "items";
    const row = h("div", { class: "ddp-string-popover-row" });
    const input = h("input", {
        class: "ddp-string-popover-input",
        type: "text",
        placeholder: "Add a value",
        "aria-label": "Add a value",
    });
    stopCanvasEvents(input);
    const add = h("button", {
        class: "ddp-string-popover-add",
        type: "button",
        text: "ADD",
        onclick: (event) => {
            event.stopPropagation();
            addFromField();
        },
    });
    const listInput = h("textarea", {
        class: "ddp-string-popover-list",
        rows: 6,
        placeholder: "16:9 (Widescreen);\n9:16 (Portrait);\n...",
        "aria-label": "Saved values (one per line)",
        spellcheck: "false",
    });
    listInput.value = formatStringOptionList(field.options);
    stopCanvasEvents(listInput);
    const LIST_HINT = "One value per line; a trailing ; is optional";
    const listHint = h("span", { class: "ddp-string-popover-hint", text: LIST_HINT });
    const listSave = h("button", {
        class: "ddp-string-popover-add",
        type: "button",
        text: "SAVE",
        title: "Save this as the list (Ctrl/Cmd+Enter)",
        onclick: (event) => {
            event.stopPropagation();
            close(true, { explicit: true });
        },
    });
    // A captured draft saves from either view, so it has its own SAVE / Discard under Items.
    const itemsHint = h("span", { class: "ddp-string-popover-hint" });
    const itemsSave = h("button", {
        class: "ddp-string-popover-add",
        type: "button",
        text: "SAVE",
        title: "Save the captured values as the list",
        onclick: (event) => {
            event.stopPropagation();
            close(true, { explicit: true });
        },
    });
    const itemsDiscard = h("button", {
        class: "ddp-string-popover-discard",
        type: "button",
        text: "Discard",
        title: "Drop the captured values; keep the saved list",
        onclick: (event) => {
            event.stopPropagation();
            discardCapture();
        },
    });
    const itemsFoot = h("div", { class: "ddp-string-popover-items-foot" }, [itemsHint, itemsDiscard, itemsSave]);
    itemsFoot.hidden = true;
    // Removing values other configs use clears them there, so SAVE asks once first:
    // armed, the button reads SURE? and the hint says what goes. Any edit disarms it.
    // Only SAVE / Ctrl+Cmd+Enter confirms; a click outside just arms and stays open.
    let armed = false;
    let captureHint = "";
    let captureWarning = false;
    const showHints = (text, warning) => {
        for (const hint of [listHint, itemsHint]) {
            hint.textContent = text;
            hint.classList.toggle("is-warning", warning);
        }
    };
    const arm = (text) => {
        armed = true;
        for (const save of [listSave, itemsSave]) {
            save.textContent = "SURE?";
            save.classList.add("is-confirming");
        }
        showHints(text, true);
    };
    const disarm = () => {
        armed = false;
        for (const save of [listSave, itemsSave]) {
            save.textContent = "SAVE";
            save.classList.remove("is-confirming");
        }
        if (captured) showHints(captureHint, captureWarning);
        else showHints(LIST_HINT, false);
    };
    listInput.addEventListener("input", () => {
        if (armed) disarm();
        if (captured) refreshDraftHint();
    });
    // Captured values are a draft in the Text box that both views show; only an explicit
    // SAVE / Ctrl+Cmd+Enter writes it, and an outside click drops it.
    let captured = false;
    const draft = () => planStringOptionList(field.options, listInput.value);
    const refreshDraftHint = () => {
        const plan = draft();
        const changes = [plan.added.length && `+${plan.added.length}`, plan.removed.length && `\u2212${plan.removed.length}`].filter(Boolean);
        captureHint = `${plural(plan.options.length, "value")}${changes.length ? ` (${changes.join(" ")})` : ""}. SAVE to apply`;
        captureWarning = false;
        if (!armed) showHints(captureHint, false);
    };
    const setDraft = (values) => {
        listInput.value = formatStringOptionList(values);
        if (armed) disarm();
        refreshDraftHint();
        renderItems();
        positionPopover();
    };
    const capture = () => {
        const plan = planFieldCapture(node, field, STRING_OPTION_CAP);
        if (plan.refused) {
            showToast(captureRefusal(plan.refused), { duration: 4200 });
            return;
        }
        if (plan.conversion === "dynamic") {
            if (!plan.changed) {
                showToast("Options already match the linked node");
                return;
            }
            disarm();
            captured = true;
            pendingDynamic = plan.schema;
            pendingCombo = false;
            captureHint = dynamicCaptureSummary(plan, isDynamic);
            captureWarning = plan.unsupported.length > 0;
            if (mode !== "items") setMode("items");
            showHints(captureHint, captureWarning);
            syncDynamicChrome();
            itemsFoot.hidden = false;
            renderItems();
            positionPopover();
            return;
        }
        pendingDynamic = null;
        pendingCombo = isDynamic;
        captured = false;
        disarm();
        listInput.value = formatStringOptionList(plan.options);
        if (!plan.changed) {
            itemsFoot.hidden = true;
            renderItems();
            if (mode === "list") listHint.textContent = "Saved values already match the linked node";
            else showToast("Saved values already match the linked node");
            return;
        }
        captured = true;
        captureHint = `${pendingCombo ? "Becomes a COMBO. " : ""}${captureSummary(plan)}`;
        captureWarning = plan.differs || plan.truncated.length > 0 || plan.unreadable.length > 0;
        showHints(captureHint, captureWarning);
        syncDynamicChrome();
        itemsFoot.hidden = mode !== "items";
        renderItems();
        positionPopover();
    };
    const discardCapture = () => {
        captured = false;
        pendingDynamic = null;
        pendingCombo = false;
        syncDynamicChrome();
        captureHint = "";
        listInput.value = formatStringOptionList(field.options);
        disarm();
        itemsFoot.hidden = true;
        renderItems();
        positionPopover();
    };
    // Items view: the saved values as rows (✎ edits in place, × removes, arming first when
    // other configs use the value), or the captured draft against them (new values marked,
    // dropped ones struck through with a restore; ✎ / × change the draft only).
    const itemsList = h("div", { class: "ddp-string-popover-items", role: "list", "aria-label": "Saved values" });
    // The row being edited in place: finish(save), or null.
    let activeEdit = null;
    const startEdit = (row, option, apply) => {
        activeEdit?.(true);
        const label = row.querySelector(".ddp-string-option-label");
        if (!label) return;
        const editor = h("input", {
            class: "ddp-string-option-input",
            type: "text",
            value: option,
            "aria-label": "Edit saved value",
            spellcheck: "false",
        });
        stopCanvasEvents(editor);
        let done = false;
        const finish = (save) => {
            if (done) return;
            done = true;
            activeEdit = null;
            const next = normalizeStringOption(editor.value);
            if (save && next && next !== option && !apply(next)) showToast(`"${next}" is already a saved value`);
            if (closed) return;
            renderItems();
            positionPopover();
        };
        activeEdit = finish;
        editor.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                finish(true);
            } else if (event.key === "Escape") {
                event.preventDefault();
                finish(false);
            }
        });
        editor.addEventListener("blur", () => finish(true));
        row.classList.add("is-renaming");
        label.replaceWith(editor);
        editor.focus();
        editor.select();
    };
    const renderItems = () => {
        let rows;
        if (pendingDynamic) {
            const known = new Set((isDynamic ? field.dynamicCombo.options : []).map((option) => option.key));
            rows = pendingDynamic.options.map((option) => dynamicOptionRow(option, { isNew: !known.has(option.key) }));
        } else if (captured) {
            const plan = draft();
            const added = new Set(plan.added);
            const others = (option) => plan.options.filter((value) => value !== option);
            rows = [
                ...plan.options.map((option) => popoverItemRow(option, {
                    isNew: added.has(option),
                    onEdit: (row) => startEdit(row, option, (next) => {
                        if (others(option).some((value) => value.toLowerCase() === next.toLowerCase())) return false;
                        setDraft(plan.options.map((value) => (value === option ? next : value)));
                        return true;
                    }),
                    onRemove: () => setDraft(others(option)),
                })),
                ...plan.removed.map((option) => popoverItemRow(option, {
                    removed: true,
                    onRestore: () => setDraft([...plan.options, option]),
                })),
            ];
        } else if (isDynamic) {
            const hidden = new Set(cleanDynamicHidden(field.dynamicCombo, field.dynamicHidden));
            const after = (change) => () => {
                change();
                renderItems();
                positionPopover();
            };
            rows = field.dynamicCombo.options.map((option) => dynamicOptionRow(option, option.unsupported ? {}
                : hidden.has(option.key)
                    ? { hidden: true, onRestore: after(() => restoreDynamicOption(node, field, option.key)) }
                    : { onHide: after(() => hideDynamicOption(node, field, option.key)) }));
        } else {
            rows = (field.options || []).map(normalizeStringOption).filter(Boolean).map((option) => popoverItemRow(option, {
                onEdit: (row) => startEdit(row, option, (next) => replaceStringOption(node, field, option, next)),
                removeButton: buildStringOptionRemoveButton(node, field, option, () => {
                    renderItems();
                    positionPopover();
                }),
            }));
        }
        itemsList.replaceChildren(...(rows.length ? rows : [h("div", { class: "ddp-string-empty", text: "No saved values yet" })]));
    };
    renderItems();
    // The add field adds only (picking stays in the dropdown). Items: into the list at once,
    // or into a captured draft. Text: a new line in the box, saved with it.
    const addFromField = () => {
        const next = normalizeStringOption(input.value);
        if (!next) return;
        if (captured) {
            const plan = draft();
            if (plan.options.some((value) => value.toLowerCase() === next.toLowerCase())) showToast(`"${next}" is already in the list`);
            else setDraft([...plan.options, next]);
        } else if (mode === "list") {
            const text = listInput.value.replace(/\s+$/, "");
            listInput.value = text ? `${text}\n${next}` : next;
            if (armed) disarm();
        } else if (rememberStringOption(field, next)) {
            writeData(node);
            renderFields(node);
            renderItems();
        } else {
            showToast(`"${next}" is already a saved value`);
        }
        input.value = "";
        input.focus();
        positionPopover();
    };
    const listBlock = h("div", { class: "ddp-string-popover-list-block" }, [
        listInput,
        h("div", { class: "ddp-string-popover-list-foot" }, [listHint, listSave]),
    ]);
    const modeButton = (id, label, hint) => h("button", {
        class: "ddp-string-popover-mode" + (mode === id ? " is-active" : ""),
        type: "button",
        text: label,
        title: hint,
        "data-mode": id,
        onclick: (event) => {
            event.stopPropagation();
            setMode(id);
        },
    });
    const modeToggle = h("div", { class: "ddp-string-popover-modes", role: "group", "aria-label": "View" }, [
        modeButton("items", "Items", "Saved values as a list"),
        modeButton("list", "Text", "Edit every saved value as text, one per line"),
    ]);
    const setMode = (next) => {
        mode = next;
        node._ddp.stringAddMode = next;
        for (const button of modeToggle.children) button.classList.toggle("is-active", button.dataset.mode === mode);
        itemsList.hidden = mode !== "items";
        itemsFoot.hidden = mode !== "items" || !captured;
        listBlock.hidden = mode !== "list";
        if (mode === "items") renderItems();
        positionPopover();
        (mode === "list" ? listInput : input).focus();
    };
    // -> false to keep the popover open (SAVE armed, waiting for the second click).
    const commitList = (explicit) => {
        const plan = planStringOptionList(field.options, listInput.value);
        if (!plan.changed) return true;
        const others = new Set(plan.removed.flatMap((option) => configsUsingStringOption(node, field, option)));
        others.delete(activeName(node));
        if (others.size && !(armed && explicit)) {
            arm(`Clears ${plural(plan.removed.length, "removed value")} in ${plural(others.size, "other config")}. SAVE again to confirm`);
            return false;
        }
        applyStringOptionList(node, field, plan);
        showToast(stringListResult(plan), { duration: plan.truncated.length ? 4200 : 2600 });
        return true;
    };
    const commit = (explicit) => {
        if (pendingDynamic) {
            convertFieldToDynamic(node, field, pendingDynamic);
            return true;
        }
        if (pendingCombo) {
            // Picks the new list doesn't have are cleared; other configs' arm SAVE first.
            const options = planStringOptionList([], listInput.value).options;
            const keys = new Set(options.map((option) => option.toLowerCase()));
            const cleared = Object.entries(node._configs || {}).filter(([name, config]) => {
                const pick = String(configValueView(node, config)?.[field.id] ?? "");
                return name !== activeName(node) && pick && !keys.has(pick.toLowerCase());
            }).length;
            if (cleared && !(armed && explicit)) {
                arm(`Clears the pick in ${plural(cleared, "other config")}. SAVE again to confirm`);
                return false;
            }
            convertFieldToCombo(node, field, options);
            return true;
        }
        if (mode === "list" || captured) return commitList(explicit);
        return true;   // Items: every add / edit / remove already applied
    };
    const close = (confirm = true, { explicit = false } = {}) => {
        if (closed) return;
        activeEdit?.(confirm);
        if (confirm && captured && !explicit) {
            confirm = false;
            showToast("Captured values not saved");
        }
        // A List SAVE that needs its confirm keeps the popover (and the edits) open.
        if (confirm && commit(explicit) === false) return;
        closed = true;
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", positionPopover);
        popover.remove();
        if (node._ddp?.stringValuePopover?.popover === popover) node._ddp.stringValuePopover = null;
    };
    const onDocumentPointerDown = (event) => {
        if (popover.contains(event.target) || currentAnchor()?.contains(event.target)) return;
        close(true);
    };
    const onDocumentKeyDown = (event) => {
        // A row being edited in place handles its own Enter / Escape. Enter in the add
        // field adds; in the list box Enter is a new line and Ctrl/Cmd+Enter saves the list.
        if (event.target?.classList?.contains("ddp-string-option-input")) return;
        if (event.key === "Enter" && event.target === input) {
            event.preventDefault();
            addFromField();
        } else if (event.key === "Enter" && popover.contains(event.target)
            && (event.target !== listInput || event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            close(true, { explicit: true });
        } else if (event.key === "Escape") {
            event.preventDefault();
            close(false);
        }
    };
    // Adding, removing or renaming a value re-renders the node's rows, which replaces the
    // + button this popover hangs from: follow the field's new one. Gone (the parameter was
    // removed) -> clampStringValuePopover closes the popover.
    let anchor = initialAnchor;
    const currentAnchor = () => {
        if (anchor?.isConnected) return anchor;
        const next = [...(node._ddp?.fields?.querySelectorAll(".ddp-string-add[data-field-id]") || [])]
            .find((button) => button.dataset.fieldId === String(field.id));
        if (next) anchor = next;
        return anchor;
    };
    const positionPopover = () => clampStringValuePopover({ popover, anchor: currentAnchor(), close, below: true });
    row.append(input, add);
    itemsList.hidden = mode !== "items";
    listBlock.hidden = mode !== "list";
    // Options only (no Text view, no add field) for a DYNAMIC COMBO or a capture converting
    // to one; one turning back into a COMBO gets both again.
    const syncDynamicChrome = () => {
        const optionsOnly = Boolean(pendingDynamic) || (isDynamic && !pendingCombo);
        const textButton = modeToggle.querySelector('[data-mode="list"]');
        textButton.disabled = optionsOnly;
        textButton.title = optionsOnly ? "A DYNAMIC COMBO's options come from the linked node" : "Edit every saved value as text, one per line";
        row.hidden = optionsOnly;
        titleEl.textContent = optionsOnly ? "Options" : "Saved Values";
    };
    syncDynamicChrome();
    // Delete all / Reset (armed in the button): a COMBO loses every saved value (cleared in
    // every config that picked one); a DYNAMIC COMBO goes back to an empty COMBO (its options,
    // every config's pick and settings dropped), reopened as one. A captured draft goes too.
    const usedElsewhere = () => Object.entries(node._configs || {}).filter(([name, config]) => name !== activeName(node)
        && String(configValueView(node, config)?.[field.id] ?? "").trim()).length;
    const clearAll = buildStringClearButton({
        title: isDynamic
            ? "Reset: back to an empty COMBO (drops the options and every config's pick and settings)"
            : "Delete all saved values (clears them in every config)",
        armedTitle: () => {
            const others = usedElsewhere();
            const what = isDynamic ? "reset this DYNAMIC COMBO to an empty COMBO" : "delete every saved value";
            return `Click again to ${what}${others ? ` and clear ${plural(others, "other config")}` : ""}`;
        },
        canClear: () => {
            if (isDynamic || captured || (field.options || []).length) return true;
            showToast("No saved values to delete");
            return false;
        },
        onConfirm: () => {
            if (isDynamic) {
                close(false);
                convertFieldToCombo(node, field, []);
                const next = currentAnchor();
                if (next?.isConnected) openStringValuePopover(node, field, next);
                showToast("Reset to an empty COMBO");
                return;
            }
            const count = (field.options || []).length;
            captured = false;
            captureHint = "";
            disarm();
            itemsFoot.hidden = true;
            applyStringOptionList(node, field, planStringOptionList(field.options, ""));
            listInput.value = "";
            renderItems();
            positionPopover();
            showToast(count ? `Deleted ${plural(count, "saved value")}` : "Captured values dropped");
        },
    });
    popover.append(
        h("div", { class: "ddp-string-popover-head" }, [
            titleEl,
            h("div", { class: "ddp-string-popover-tools" }, [modeToggle, clearAll, buildStringCaptureButton(capture)]),
        ]),
        itemsList,
        itemsFoot,
        listBlock,
        row,
    );
    document.body.append(popover);
    positionPopover();
    window.addEventListener("resize", positionPopover);
    setTimeout(() => {
        if (closed) return;
        document.addEventListener("pointerdown", onDocumentPointerDown, true);
        document.addEventListener("keydown", onDocumentKeyDown, true);
    }, 0);
    (mode === "list" ? listInput : input).focus();
    node._ddp.stringValuePopover = { popover, close, input };
}

function plural(count, word) {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// Save a List plan (planStringOptionList): the new list, every config following a
// case-only respelling, removed values cleared wherever they were picked. A field
// whose list was empty takes the first value.
function applyStringOptionList(node, field, plan) {
    const wasEmpty = !(field.options || []).length;
    for (const [oldValue, nextValue] of plan.renamed) {
        setStringOptionValues(node, field, oldValue, nextValue);
    }
    for (const option of plan.removed) {
        setStringOptionValues(node, field, option, "");
    }
    field.options = plan.options;
    if (wasEmpty && plan.options.length && !normalizeStringOption(activeConfigValues(node, true)?.[field.id])) {
        setStringFieldValue(node, field, plan.options[0]);
    }
    writeData(node);
    renderFields(node);
}

// The List SAVE toast: the new count, what changed, what the cap left out.
function stringListResult(plan) {
    const parts = [];
    if (plan.added.length) parts.push(`${plan.added.length} added`);
    if (plan.removed.length) parts.push(`${plan.removed.length} removed`);
    let text = `Saved ${plural(plan.options.length, "value")}${parts.length ? ` (${parts.join(", ")})` : ""}`;
    if (plan.truncated.length) text += `. ${plural(plan.truncated.length, "line")} over the ${STRING_OPTION_CAP} max left out`;
    return text;
}

// Capture saved values from the linked target inputs (CS_COMBO_CAPTURE_GAMEPLAN.md), right
// of the One / List toggle of the Add popover.
// The Saved Values popover's Delete all / Reset: a trash glyph that arms to a red ✕ first
// (armConfirmButton; the glyph comes back on reset). `canClear()` false = nothing to clear.
const CLEAR_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.6 6.5v4.5M9.4 6.5v4.5"/></svg>';
function buildStringClearButton({ title, armedTitle, canClear, onConfirm }) {
    const button = h("button", { class: "ddp-string-popover-clear", type: "button", title, "aria-label": title });
    const render = (target, text) => {
        target.replaceChildren();
        if (text === "armed") {
            target.textContent = "\u2715";
            return;
        }
        const glyph = h("span", { class: "ddp-string-clear-glyph", "aria-hidden": "true" });
        glyph.innerHTML = CLEAR_GLYPH;
        target.append(glyph);
    };
    render(button, "idle");
    armConfirmButton(button, {
        armedText: "armed",
        restoreText: "idle",
        restoreTitle: title,
        renderText: render,
        stopPropagation: true,
        shouldArm: () => canClear(),
        onConfirm,
    });
    // The armed title is worked out when it arms (how many configs it clears right now).
    button.addEventListener("click", () => {
        if (button.classList.contains("is-confirming")) button.title = armedTitle();
    });
    return button;
}

function buildStringCaptureButton(onCapture) {
    const glyph = h("span", { class: "ddp-string-capture-glyph", "aria-hidden": "true" });
    glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M3 8V5a2 2 0 0 1 2-2h3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M21 16v3a2 2 0 0 1-2 2h-3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><circle cx="12" cy="12" r="3"/></svg>';
    return h("button", {
        class: "ddp-string-popover-capture",
        type: "button",
        title: "Capture values from the linked node",
        "aria-label": "Capture values from the linked node",
        onclick: (event) => {
            event.stopPropagation();
            onCapture();
        },
    }, glyph);
}

// Why a capture wrote nothing (planComboCapture's refused reasons).
function captureRefusal({ reason, labels }) {
    const names = labels.join(", ");
    switch (reason) {
        case "no-targets": return "Nothing to capture: link this parameter through a CS Link to a node input first";
        case "dynamic-combo": return `${names} needs a method plus its settings; Config Switcher can't drive it yet`;
        case "unreadable": return `Couldn't read values from ${names}`;
        case "empty": return `${names} offers no values right now; saved values unchanged`;
        case "mixed": return `${names}: a DynamicCombo and an ordinary combo can't share one value; nothing changed`;
        case "schema-differs": return `${names} offer different options or settings; nothing changed`;
        case "unsupported": return `${names}: none of its options can be driven by Config Switcher (they need links or nest DynamicCombos)`;
        default: return `${names} have no values in common; saved values unchanged`;
    }
}

// The List hint after a capture: what came in, and what to know before SAVE.
function captureSummary(plan) {
    const changes = [plan.added.length && `+${plan.added.length}`, plan.removed.length && `\u2212${plan.removed.length}`].filter(Boolean);
    let text = `Captured ${plural(plan.options.length, "value")} from ${plural(plan.targets, "input")}${changes.length ? ` (${changes.join(" ")})` : ""}`;
    if (plan.differs) text += `. Only values every input accepts (${plan.skipped.length} skipped)`;
    if (plan.truncated.length) text += `. ${plan.truncated.length} over the ${STRING_OPTION_CAP} max left out`;
    if (plan.unreadable.length) text += `. Couldn't read ${plan.unreadable.join(", ")}`;
    return `${text}. SAVE to apply`;
}

// The + that opens the field's Saved Values popover (edit mode). `data-field-id` lets an
// open popover follow the re-rendered button, and CS Link's toast find it.
export function buildStringAddButton(node, field, disabled) {
    return h("button", {
        class: "ddp-string-add",
        title: "Saved values",
        "data-field-id": field.id,
        text: "+",
        disabled,
        onclick: (event) => {
            if (disabled) return;
            openStringValuePopover(node, field, event.currentTarget);
        },
    });
}

function buildStringValueControl(node, field, value, placeholder, disabled, editing, set) {
    const display = String(value ?? "");
    // Flag what would otherwise run silently: a value no longer in the saved list
    // (removed/renamed elsewhere, or imported) still emits as-is; an empty one emits nothing.
    const orphan = Boolean(display) && !hasStringOption(field, display);
    const title = orphan
        ? `Not in saved values: ${display}. Still emitted as-is`
        : display || (disabled ? "Choose saved value" : "No value set, outputs nothing");
    const selector = h("button", {
        class: "ddp-string-select" + (display ? "" : " is-empty") + (orphan ? " is-orphan" : ""),
        type: "button",
        disabled,
        title,
        onclick: () => openStringOptionMenu(node, field, selector),
    }, [
        h("span", { class: "ddp-string-select-label", text: display || (disabled ? "add a parameter first" : placeholder) }),
        h("span", { class: "ddp-string-select-arrow", text: "⌄" }),
    ]);
    const children = [selector];
    if (editing) children.push(buildStringAddButton(node, field, disabled));
    return h("div", { class: "ddp-string-value" }, children);
}
