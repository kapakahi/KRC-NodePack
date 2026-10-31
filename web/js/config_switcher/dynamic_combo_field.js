// Config Switcher DYNAMIC COMBO row and settings popover (CS_DYNAMIC_COMBO_GAMEPLAN.md D5 /
// D6). The rules are in dynamic_combo.js.
//
// The row stays one 24px row: a dropdown of the option keys only (picking works like any
// combo), its summary (`vsa · keep_percent 10`), and in edit mode a sliders settings button and
// the + Saved Values button. In run mode the dropdown is full width and only shows the
// settings.
//
// The settings popover edits the active config's settings for the picked option, under
// `<id>:<option>:<setting>` (a shared field's go to the shared store: configValueView).
import { h } from "./helpers.js";
import { stopCanvasEvents } from "../shared/dom.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { showToast } from "../shared/toast.js";
import { activeConfigValues, applyFloatingMenuPalette, writeData } from "./config.js";
import { renderFields } from "./field_rows.js";
import { configValueStores } from "./shared_values.js";
import {
    buildStringAddButton,
    clampStringValuePopover,
    closeStringOptionMenu,
    closeStringValuePopover,
    openStringOptionMenu,
    stringOptionRow,
} from "./value_controls.js";
import {
    adoptDynamicSchema,
    cleanDynamicHidden,
    coerceSetting,
    dropDynamicSettings,
    pickedOption,
    resolveDynamicValue,
    settingKey,
} from "./dynamic_combo.js";

// A setting's value in the row's summary: switches on / off, free text quoted (and
// shortened), everything else as sent.
function formatSettingValue(setting, value) {
    if (setting.type === "BOOLEAN") return value ? "on" : "off";
    if (setting.type === "STRING") {
        const text = String(value).replace(/\s+/g, " ").trim();
        return text.length > 18 ? `"${text.slice(0, 17)}…"` : `"${text}"`;
    }
    return String(value);
}

// "vsa · keep_percent 10": the picked option and what each of its settings sends.
export function dynamicSummary(field, values) {
    const resolved = resolveDynamicValue(field, values);
    const option = pickedOption(field, values);
    if (!resolved || !option) return "";
    const parts = option.settings.map((setting) => `${setting.name} ${formatSettingValue(setting, resolved[setting.name])}`);
    return parts.length ? `${option.key} · ${parts.join(", ")}` : option.key;
}

// The dropdown: supported options pick like any combo value; an unsupported one (D11 / D12)
// shows greyed out with why.
function renderDynamicMenuContents(node, field, menu) {
    const picked = pickedOption(field, activeConfigValues(node, false))?.key;
    const hidden = new Set(cleanDynamicHidden(field.dynamicCombo, field.dynamicHidden));
    menu.replaceChildren(...(field.dynamicCombo?.options || []).filter((option) => !hidden.has(option.key)).map((option) => {
        if (!option.unsupported) return stringOptionRow(node, field, option.key, option.key === picked);
        return h("div", {
            class: "ddp-string-option is-unsupported",
            title: `${option.key}: ${option.unsupported}. Config Switcher can't drive this option`,
            "aria-disabled": "true",
        }, [
            h("span", { class: "ddp-string-option-label" }, [
                h("span", { class: "ddp-string-option-text", text: option.key }),
                h("span", { class: "ddp-string-option-reason", text: option.unsupported }),
            ]),
        ]);
    }));
}

// Three sliders, drawn symmetric about the 16px box's centre so the button centres it exactly
// (a text glyph sits on its font's baseline, never the box's middle).
const SLIDERS_GLYPH = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" focusable="false"><path d="M2.5 4h6M11.5 4h2M2.5 8h1.5M7 8h6.5M2.5 12h4.5M10 12h3.5"/><circle cx="10" cy="4" r="1.5"/><circle cx="5.5" cy="8" r="1.5"/><circle cx="8.5" cy="12" r="1.5"/></svg>';

export function buildDynamicComboControl(node, field, disabled, editing) {
    const values = activeConfigValues(node, false);
    const summary = dynamicSummary(field, values);
    const selector = h("button", {
        class: "ddp-string-select ddp-dynamic-select" + (summary ? "" : " is-empty"),
        type: "button",
        disabled,
        title: summary || "No option this node can use",
        onclick: () => openStringOptionMenu(node, field, selector, renderDynamicMenuContents),
    }, [
        h("span", { class: "ddp-string-select-label", text: summary || (disabled ? "add a parameter first" : "no usable option") }),
        h("span", { class: "ddp-string-select-arrow", text: "⌄" }),
    ]);
    const children = [selector];
    if (editing) {
        const glyph = h("span", { class: "ddp-dynamic-settings-glyph" });
        glyph.innerHTML = SLIDERS_GLYPH;
        const settings = h("button", {
            class: "ddp-string-add ddp-dynamic-settings-button",
            type: "button",
            "data-settings-field-id": field.id,
            title: "Settings for the picked option",
            "aria-label": "Settings for the picked option",
            disabled: disabled || !summary,
            onclick: (event) => {
                event.stopPropagation();
                openDynamicSettingsPopover(node, field, settings);
            },
        }, glyph);
        children.push(settings, buildStringAddButton(node, field, disabled));
    }
    return h("div", { class: "ddp-string-value ddp-dynamic-value" }, children);
}

// One setting's control in the popover, writing the active config's value (D6). `write(raw)`
// stores the text; `commit()` re-renders the rows (the summary follows).
function settingControl(setting, value, write, commit) {
    if (setting.type === "BOOLEAN") {
        const button = h("button", {
            class: "ddp-bool-toggle" + (value ? " is-on" : ""),
            type: "button",
            "aria-pressed": value ? "true" : "false",
            title: "Switch on or off",
            onclick: () => {
                const next = !button.classList.contains("is-on");
                button.classList.toggle("is-on", next);
                button.setAttribute("aria-pressed", next ? "true" : "false");
                write(next ? "true" : "false");
                commit();
            },
        }, [h("span", { class: "ddp-bool-track" }, [h("span", { class: "ddp-bool-knob" })])]);
        return button;
    }
    if (setting.type === "COMBO") {
        // The setting's own values open in place under the button (no second floating menu).
        const label = h("span", { class: "ddp-string-select-label", text: String(value) });
        const list = h("div", { class: "ddp-dynamic-setting-options", role: "listbox" });
        list.hidden = true;
        const pick = (option) => {
            label.textContent = option;
            list.hidden = true;
            write(option);
            commit();
        };
        list.append(...setting.options.map((option) => h("div", {
            class: "ddp-string-option" + (option === value ? " is-selected" : ""),
            role: "option",
            tabindex: "0",
            title: option,
            onclick: () => pick(option),
            onkeydown: (event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                pick(option);
            },
        }, [h("span", { class: "ddp-string-option-label", text: option })])));
        const button = h("button", {
            class: "ddp-string-select",
            type: "button",
            title: "Choose a value",
            onclick: () => { list.hidden = !list.hidden; },
        }, [label, h("span", { class: "ddp-string-select-arrow", text: "\u2304" })]);
        return h("div", { class: "ddp-dynamic-setting-combo" }, [button, list]);
    }
    if (setting.type === "STRING") {
        const attrs = {
            class: "ddp-input ddp-dynamic-setting-text" + (setting.multiline ? " is-multiline" : ""),
            spellcheck: "false",
            oninput: (event) => write(event.target.value),
            onchange: commit,
        };
        const control = setting.multiline
            ? h("textarea", { ...attrs, rows: 3 }, String(value))
            : h("input", { ...attrs, type: "text", value: String(value) });
        stopCanvasEvents(control);
        return control;
    }
    // FLOAT / INT: typed freely, settled in range and on step when it's left; the steppers
    // move by the setting's step (1 for INT, 0.1 for FLOAT without one).
    const input = h("input", {
        class: "ddp-input ddp-number-input",
        type: "text",
        inputmode: setting.type === "INT" ? "numeric" : "decimal",
        value: String(value),
        oninput: (event) => write(event.target.value),
        onchange: () => {
            input.value = String(coerceSetting(setting, input.value));
            write(input.value);
            commit();
        },
    });
    stopCanvasEvents(input);
    const stepBy = (direction) => {
        const delta = setting.step || (setting.type === "INT" ? 1 : 0.1);
        input.value = String(coerceSetting(setting, Number(coerceSetting(setting, input.value)) + direction * delta));
        write(input.value);
        commit();
    };
    const step = (direction, glyph, title) => h("button", { class: "ddp-number-step", type: "button", title, onclick: () => stepBy(direction) },
        h("span", { class: `ddp-number-step-glyph ddp-number-step-glyph-${direction < 0 ? "minus" : "plus"}`, text: glyph }));
    return h("div", { class: "ddp-number-value" }, [input, step(-1, "\u2212", "Decrease"), step(1, "+", "Increase")]);
}

function rangeHint(setting) {
    if (setting.type !== "FLOAT" && setting.type !== "INT") return "";
    const parts = [];
    if (setting.min !== undefined || setting.max !== undefined) parts.push(`${setting.min ?? "\u2212\u221e"} \u2013 ${setting.max ?? "\u221e"}`);
    if (setting.step) parts.push(`step ${setting.step}`);
    return parts.join(" \u00b7 ");
}

// The picked option's settings, one row each (D6), on document.body like the Saved Values
// popover; it shares that popover's slot so one closes the other. Each change writes the
// active config at once; rows re-render, and the popover follows its field's new settings button.
export function openDynamicSettingsPopover(node, field, initialAnchor) {
    closeStringOptionMenu(node);
    closeStringValuePopover(node, false);
    if (!node._ddp?.wrap) return;
    const values = activeConfigValues(node, false);
    const option = pickedOption(field, values);
    if (!option) return;
    const resolved = resolveDynamicValue(field, values) || {};
    let closed = false;
    let anchor = initialAnchor;
    const currentAnchor = () => {
        if (anchor?.isConnected) return anchor;
        const next = [...(node._ddp?.fields?.querySelectorAll(".ddp-dynamic-settings-button[data-settings-field-id]") || [])]
            .find((button) => button.dataset.settingsFieldId === String(field.id));
        if (next) anchor = next;
        return anchor;
    };
    const write = (name) => (raw) => {
        const config = activeConfigValues(node, true);
        if (!config) return;
        config[settingKey(field.id, option.key, name)] = String(raw);
        writeData(node);
    };
    const commit = () => {
        if (closed) return;
        renderFields(node);
        position();
    };
    const popover = h("div", { class: "krc-node ddp-string-popover ddp-dynamic-settings", role: "dialog", "aria-label": `${option.key} settings` });
    applyFloatingMenuPalette(node, popover);
    stopCanvasEvents(popover);
    const rows = option.settings.length
        ? option.settings.map((setting) => h("div", { class: "ddp-dynamic-setting" }, [
            h("div", { class: "ddp-dynamic-setting-head" }, [
                h("span", { class: "ddp-dynamic-setting-name", text: setting.name }),
                h("span", { class: "ddp-dynamic-setting-hint", text: rangeHint(setting) }),
            ]),
            settingControl(setting, resolved[setting.name], write(setting.name), commit),
        ]))
        : [h("div", { class: "ddp-string-empty", text: "This option has no settings" })];
    popover.append(
        h("div", { class: "ddp-string-popover-head" }, [
            h("div", { class: "ddp-string-popover-title", text: `${option.key} settings` }),
        ]),
        h("div", { class: "ddp-dynamic-settings-list" }, rows),
    );
    const close = () => {
        if (closed) return;
        // A number or text being typed settles first (its change event may not have fired).
        popover.querySelector(":focus")?.blur?.();
        closed = true;
        document.removeEventListener("pointerdown", onDocumentPointerDown, true);
        document.removeEventListener("keydown", onDocumentKeyDown, true);
        window.removeEventListener("resize", position);
        popover.remove();
        if (node._ddp?.stringValuePopover?.popover === popover) node._ddp.stringValuePopover = null;
        renderFields(node);
    };
    const position = () => clampStringValuePopover({ popover, anchor: currentAnchor(), close, below: true });
    const onDocumentPointerDown = (event) => {
        if (popover.contains(event.target) || currentAnchor()?.contains(event.target)) return;
        close();
    };
    const onDocumentKeyDown = (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
        } else if (event.key === "Enter" && event.target?.tagName === "INPUT" && popover.contains(event.target)) {
            event.preventDefault();
            event.target.blur();
        }
    };
    document.body.append(popover);
    position();
    window.addEventListener("resize", position);
    setTimeout(() => {
        if (closed) return;
        document.addEventListener("pointerdown", onDocumentPointerDown, true);
        document.addEventListener("keydown", onDocumentKeyDown, true);
    }, 0);
    node._ddp.stringValuePopover = { popover, close };
}

// A capture's SAVE: the field becomes (or stays, with a new schema) a DYNAMIC COMBO (D2).
// Every value store (each config, the shared one) adopts the schema: a value that is an
// option key stays picked, else the first supported option; remembered settings the
// schema still has are kept (D8 / D9).
export function convertFieldToDynamic(node, field, schema) {
    field.type = "dynamic_combo";
    field.dynamicCombo = schema;
    delete field.dynamicHidden;   // a capture brings every option back (D14)
    field.options = [];
    for (const values of configValueStores(node)) adoptDynamicSchema(field, values);
    writeData(node);
    renderFields(node);
}

// A capture's SAVE against an ordinary combo: the DYNAMIC COMBO turns back into a COMBO with
// `options` as its saved values (D3). Settings go; a pick not in the list is cleared, like
// any removed saved value.
export function convertFieldToCombo(node, field, options) {
    const keys = new Set(options.map((option) => option.toLowerCase()));
    for (const values of configValueStores(node)) {
        dropDynamicSettings(field, values);
        if (Object.prototype.hasOwnProperty.call(values, field.id) && !keys.has(String(values[field.id] ?? "").toLowerCase())) {
            values[field.id] = "";
        }
    }
    field.type = "combo";
    delete field.dynamicCombo;
    field.options = options.slice();
    writeData(node);
    renderFields(node);
}

// Hide an option from the dropdown (D14): configs that picked it move to the first visible
// option; its remembered settings stay. The last visible option can't be hidden.
export function hideDynamicOption(node, field, key) {
    const hidden = cleanDynamicHidden(field.dynamicCombo, [...(field.dynamicHidden || []), key]);
    if (!hidden.includes(key)) {
        showToast("Keep at least one option in the dropdown");
        return false;
    }
    field.dynamicHidden = hidden;
    for (const values of configValueStores(node)) adoptDynamicSchema(field, values);
    writeData(node);
    renderFields(node);
    return true;
}

export function restoreDynamicOption(node, field, key) {
    field.dynamicHidden = (field.dynamicHidden || []).filter((item) => item !== key);
    if (!field.dynamicHidden.length) delete field.dynamicHidden;
    writeData(node);
    renderFields(node);
}

// One option in Saved Values for a DYNAMIC COMBO (D14): its key with its settings' names, or
// why Config Switcher can't drive it. `isNew` marks an option a capture adds. A visible
// option's × (`onHide`, armed like every ×) hides it from the dropdown; a `hidden` one shows
// struck through with ↺ (`onRestore`).
export function dynamicOptionRow(option, { isNew = false, hidden = false, onHide = null, onRestore = null } = {}) {
    const detail = option.unsupported || option.settings.map((setting) => setting.name).join(", ") || "no settings";
    const action = onHide || onRestore;
    const row = h("div", {
        class: "ddp-string-option is-item is-option" + (option.unsupported ? " is-unsupported" : "")
            + (action ? " is-removable" : "") + (hidden ? " is-hidden-option" : ""),
        role: "listitem",
        title: option.unsupported ? `${option.key}: ${option.unsupported}`
            : hidden ? `${option.key}: hidden from the dropdown` : `${option.key}: ${detail}`,
    }, [
        h("span", { class: "ddp-string-option-label" }, [
            h("span", { class: "ddp-string-option-text", text: option.key }),
            ...(isNew ? [h("span", { class: "ddp-string-option-badge", text: "new" })] : []),
            h("span", { class: "ddp-string-option-reason", text: hidden ? "hidden" : detail }),
        ]),
    ]);
    if (onRestore) {
        row.append(h("button", {
            class: "ddp-string-option-edit",
            type: "button",
            title: "Show this option in the dropdown again",
            text: "\u21ba",
            onclick: (event) => {
                event.stopPropagation();
                onRestore();
            },
        }));
    } else if (onHide) {
        const button = h("button", { class: "ddp-string-option-remove", type: "button", title: "Hide from the dropdown", text: "\u00d7" });
        armConfirmButton(button, {
            armedText: "\u2715",
            armedTitle: "Click again to hide it; configs that picked it move to the first option",
            restoreText: "\u00d7",
            restoreTitle: "Hide from the dropdown",
            stopPropagation: true,
            onConfirm: onHide,
        });
        row.append(button);
    }
    return row;
}

// The hint after a capture that converts to a DYNAMIC COMBO.
export function dynamicCaptureSummary(plan, wasDynamic) {
    const total = plan.schema.options.length;
    const usable = total - plan.unsupported.length;
    const what = wasDynamic ? "Updates its options" : "Becomes a DYNAMIC COMBO";
    const skipped = plan.unsupported.length ? ` (${plan.unsupported.length} this node can't use)` : "";
    return `${what}: ${usable} of ${total} option${total === 1 ? "" : "s"}${skipped}. SAVE to apply`;
}
