// Config Switcher field rows: build each parameter row (name, value control, reorder grip,
// remove), drag-to-reorder, renderFields, and the node height that follows the rows.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { h } from "./helpers.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { classicDomHeight, classicNodeHeight, isClassicDom } from "../shared/node_edge.js";
import {
    activeConfigValues,
    CARD_VIEW_CARD,
    cardViewFieldClass,
    cardViewMode,
    DDP_CONFIG_OUTPUT_ROW_H,
    DDP_DOM_FIXED_H,
    DDP_EMPTY_DOM_H,
    DDP_FIELD_GAP,
    DDP_FIELD_H,
    DDP_MODEL_FIELD_H,
    DDP_MODEL_FIELD_LIST_H,
    DDP_NODE_BASE_CHROME_H,
    DDP_STRING_MULTILINE_H,
    hasEditableConfig,
    hasScratchConfig,
    isEditMode,
    isInitialBlankState,
    MAX_OUTPUTS,
    MIN_W,
    renderBar,
    SCRATCH_CONFIG,
    syncActiveOptions,
    writeData,
} from "./config.js";
import { buildPromptDropControl } from "./prompt_field.js";
import { buildBooleanValueControl, buildValueControl } from "./value_controls.js";
import { buildModelDropControl } from "./model_field.js";
import { moveSeedHoldForShare } from "./seed_field.js";
import { fieldValueKeys, setFieldShared } from "./shared_values.js";
import { buildNoteControl, forgetNoteRows, NOTE_TYPE, noteRowHeight } from "./note_field.js";
import { applySectionColor, applySectionTint, buildSectionContent, SECTION_TYPE, sectionOf } from "./section_field.js";

function buildShareFieldControl(node, field, editing) {
    if (!editing) return null;
    const glyph = h("span", { class: "ddp-field-share-glyph", "aria-hidden": "true" });
    glyph.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>';
    const button = h("button", {
        class: "ddp-icon ddp-field-share",
        type: "button",
        title: "Share across configs",
        "aria-label": "Share across configs",
        onclick: (event) => {
            event.stopPropagation();
            if (!isEditMode(node)) return;
            setFieldShared(node, field, !field.shared, activeConfigValues(node, true));
            if (field.type === "seed") moveSeedHoldForShare(node, field);
            writeData(node);
            renderFields(node);
        },
    }, glyph);
    const sync = () => {
        button.classList.toggle("is-active", Boolean(field.shared));
        button.setAttribute("aria-pressed", String(Boolean(field.shared)));
    };
    sync();
    return button;
}

function removeField(node, index, field) {
    node._fields.splice(index, 1);
    // Every key the field owns (a seed's state, a DYNAMIC COMBO's settings), not just its id.
    const keys = fieldValueKeys(field);
    for (const p of Object.values(node._configs)) for (const key of keys) delete p[key];
    if (field.type === NOTE_TYPE) forgetNoteRows(node, field.id);
    if (!node._fields.length && hasScratchConfig(node)) delete node._configs[SCRATCH_CONFIG];
    writeData(node);
    renderFields(node);
    renderBar(node);
    resizeConfigNode(node);
}

// Move the parameter at `from` so it ends up at index `to`.
function moveFieldTo(node, from, to) {
    if (!isEditMode(node)) return false;
    const fields = node._fields || [];
    if (from === to || from < 0 || to < 0 || from >= fields.length || to >= fields.length) return false;
    const [field] = fields.splice(from, 1);
    fields.splice(to, 0, field);
    writeData(node);
    renderFields(node);
    renderBar(node);
    resizeConfigNode(node);
    return true;
}

// ── Drag to reorder parameters (edit mode) ──────────────────────────────────────────
// The narrow right-edge grip starts the drag; every parameter row is a
// drop target that inserts above or below itself by the pointer's half. A field drag has
// its own data type and never sets the shared KRC card payload, so the model / prompt
// card drop areas inside the rows ignore it, and the rows ignore card drags.
const FIELD_DRAG_MIME = "application/x-krc-cs-field";
let fieldDrag = null;   // { node, index } while a parameter is dragged

function isFieldDrag(node, event) {
    return fieldDrag?.node === node
        && Array.from(event?.dataTransfer?.types || []).includes(FIELD_DRAG_MIME);
}

function clearFieldDropMarks(node) {
    node._ddp?.fields?.querySelectorAll(".ddp-field").forEach((row) => {
        row.classList.remove("is-field-drop-before", "is-field-drop-after", "is-field-dragging");
    });
}

function fieldDropIndex(row, event, index) {
    const rect = row.getBoundingClientRect();
    return event.clientY > rect.top + rect.height / 2 ? index + 1 : index;
}

function installFieldDropTarget(node, row, index) {
    row.addEventListener("dragover", (event) => {
        if (!isFieldDrag(node, event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const before = fieldDropIndex(row, event, index) === index;
        if (row.classList.contains(before ? "is-field-drop-before" : "is-field-drop-after")) return;
        node._ddp?.fields?.querySelectorAll(".is-field-drop-before, .is-field-drop-after").forEach((other) => {
            other.classList.remove("is-field-drop-before", "is-field-drop-after");
        });
        row.classList.add(before ? "is-field-drop-before" : "is-field-drop-after");
    });
    row.addEventListener("dragleave", (event) => {
        if (event.relatedTarget && row.contains(event.relatedTarget)) return;
        row.classList.remove("is-field-drop-before", "is-field-drop-after");
    });
    row.addEventListener("drop", (event) => {
        if (!isFieldDrag(node, event)) return;
        event.preventDefault();
        event.stopPropagation();
        const from = fieldDrag.index;
        let to = fieldDropIndex(row, event, index);
        if (from < to) to -= 1;   // the dragged row leaves its old slot first
        fieldDrag = null;
        clearFieldDropMarks(node);
        moveFieldTo(node, from, to);
    });
}

function buildNameControl(node, field, editing) {
    const nameInput = h("input", {
        class: "ddp-input ddp-name" + (editing ? "" : " is-readonly"),
        type: "text",
        placeholder: "parameter name",
        value: field.name ?? "",
        readonly: !editing,
        oninput: (e) => {
            if (!isEditMode(node)) return;
            field.name = e.target.value;
            writeData(node);
        },
    });
    const clearName = h("button", {
        class: "ddp-name-clear",
        title: "Clear parameter name",
        text: "×",
        disabled: !editing,
        onclick: () => {
            if (!isEditMode(node)) return;
            field.name = "";
            nameInput.value = "";
            writeData(node);
            nameInput.focus();
        },
    });
    return h("div", { class: "ddp-name-wrap" }, [nameInput, clearName]);
}

function buildModelField(node, field, index, disabled, editing) {
    return h("div", { class: "ddp-field ddp-model-field" + cardViewFieldClass(node) + (editing ? " is-editing" : "") }, [
        buildNameControl(node, field, editing),
        buildModelDropControl(node, field, activeConfigValues(node, false)?.[field.id], disabled),
        buildModelFieldActions(node, index, field, editing),
    ]);
}

function buildPromptField(node, field, index, disabled, editing) {
    return h("div", { class: "ddp-field ddp-model-field ddp-prompt-field" + cardViewFieldClass(node) + (editing ? " is-editing" : "") }, [
        buildNameControl(node, field, editing),
        buildPromptDropControl(node, field, activeConfigValues(node, false)?.[field.id], disabled),
        buildModelFieldActions(node, index, field, editing),
    ]);
}

function buildModelFieldActions(node, index, field, editing) {
    if (!editing) return null;
    return h("div", { class: "ddp-model-field-actions" }, [
        buildShareFieldControl(node, field, editing),
        buildRemoveFieldButton(node, index, field, editing),
    ]);
}

// Thin right-edge reorder notch. Alt+↑ / Alt+↓ retains keyboard reordering.
function buildMoveFieldControl(node, index, count, editing) {
    if (!editing) return null;
    const grip = h("div", {
        class: "ddp-field-grip",
        title: "Drag to reorder (Alt+↑ / Alt+↓)",
        role: "button",
        tabindex: "0",
        "aria-label": "Reorder parameter",
        draggable: "true",
    }, h("span", { class: "ddp-field-grip-glyph", "aria-hidden": "true" }));
    grip.addEventListener("dragstart", (event) => {
        if (!isEditMode(node)) {
            event.preventDefault();
            return;
        }
        event.stopPropagation();
        fieldDrag = { node, index };
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(FIELD_DRAG_MIME, String(index));
        const row = grip.closest(".ddp-field");
        if (row) {
            const gripRect = grip.getBoundingClientRect();
            const rowRect = row.getBoundingClientRect();
            event.dataTransfer.setDragImage(row, gripRect.left - rowRect.left + gripRect.width / 2, gripRect.top - rowRect.top + gripRect.height / 2);
            requestAnimationFrame(() => row.classList.add("is-field-dragging"));
        }
    });
    grip.addEventListener("dragend", () => {
        fieldDrag = null;
        clearFieldDropMarks(node);
    });
    grip.addEventListener("keydown", (event) => {
        if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return;
        event.preventDefault();
        event.stopPropagation();
        const to = index + (event.key === "ArrowUp" ? -1 : 1);
        if (to < 0 || to >= count || !moveFieldTo(node, index, to)) return;
        node._ddp?.fields?.querySelectorAll(".ddp-field-grip")[to]?.focus();
    });
    return grip;
}

function buildRemoveFieldButton(node, index, field, editing) {
    if (!editing) return null;
    const remove = h("button", {
        class: "ddp-icon ddp-remove",
        title: "Remove parameter",
    }, h("span", { class: "ddp-remove-glyph", text: "×" }));
    armConfirmButton(remove, {
        armedText: "✕",
        armedTitle: "Click again to remove parameter",
        restoreText: "×",
        restoreTitle: "Remove parameter",
        renderText: (button, text) => button.replaceChildren(h("span", { class: "ddp-remove-glyph", text })),
        onConfirm: () => removeField(node, index, field),
    });
    return remove;
}

export function renderFields(node) {
    const ui = node._ddp;
    if (!ui) return;
    const editing = isEditMode(node);
    ui.fields.replaceChildren();

    const disabled = !hasEditableConfig(node);

    (node._fields || []).forEach((field, i) => {
        const count = (node._fields || []).length;
        let row;
        if (field.type === "model") {
            row = buildModelField(node, field, i, disabled, editing);
        } else if (field.type === "prompt") {
            row = buildPromptField(node, field, i, disabled, editing);
        } else if (field.type === SECTION_TYPE) {
            // Full width, no name column, no Share (nothing to share): title / gap + colour.
            row = h("div", { class: "ddp-field ddp-section-field" + (editing ? " is-editing" : "") }, [
                ...buildSectionContent(node, field, editing),
                buildRemoveFieldButton(node, i, field, editing),
            ]);
            applySectionColor(row, field);
        } else if (field.type === NOTE_TYPE) {
            row = h("div", { class: "ddp-field ddp-compact-field ddp-note-field" + (editing ? " is-editing" : "") }, [
                buildNameControl(node, field, editing),
                buildNoteControl(node, field, disabled, editing),
                buildShareFieldControl(node, field, editing),
                buildRemoveFieldButton(node, i, field, editing),
            ]);
        } else {
            const fieldClass = "ddp-field ddp-compact-field"
                + (field.type === "boolean" ? " ddp-boolean-field" : "")
                + (editing ? " is-editing" : "");
            row = h("div", { class: fieldClass }, [
                buildNameControl(node, field, editing),
                field.type === "boolean"
                    ? buildBooleanValueControl(node, field, disabled, editing)
                    : buildValueControl(node, field, disabled, editing),
                buildShareFieldControl(node, field, editing),
                buildRemoveFieldButton(node, i, field, editing),
            ]);
        }
        row.classList.toggle("is-shared", Boolean(field.shared));
        if (field.type !== SECTION_TYPE) applySectionTint(row, sectionOf(node._fields, i));
        if (editing) {
            row.append(buildMoveFieldControl(node, i, count, editing));
            installFieldDropTarget(node, row, i);
        }
        ui.fields.appendChild(row);
    });

    if (ui.addField) {
        ui.addField.disabled = !editing || (node._fields || []).length >= MAX_OUTPUTS;
        ui.addFieldWrap.hidden = !editing;
    }
    resizeConfigNode(node);
}

// Per-field rendered row height (must track the actual .ddp-* layout): model and
// prompt fields render as tall cards; a raw STRING field switched to multi-line uses a
// textarea row; everything else (a SECTION/DIVIDER included) is the compact single-line row.
function fieldRowHeight(node, field) {
    if (field.type === "model" || field.type === "prompt") {
        return cardViewMode(node) === CARD_VIEW_CARD ? DDP_MODEL_FIELD_H : DDP_MODEL_FIELD_LIST_H;
    }
    if (field.type === "string" && field.stringMultiline) return DDP_STRING_MULTILINE_H;
    if (field.type === NOTE_TYPE) return noteRowHeight(node, field);
    return DDP_FIELD_H;
}

export function calcConfigDomHeight(node) {
    if (isInitialBlankState(node)) return DDP_EMPTY_DOM_H;
    const fields = node._fields || [];
    const fieldGaps = Math.max(fields.length - 1, 0) * DDP_FIELD_GAP;
    const fieldHeights = fields.reduce((sum, field) => sum + fieldRowHeight(node, field), 0);
    return DDP_DOM_FIXED_H + fieldHeights + fieldGaps;
}

function classicWidget(node) {
    const wrap = node._ddp?.wrap;
    const widget = wrap && node.widgets?.find((entry) => entry.element === wrap);
    return widget && isClassicDom(wrap) ? widget : null;
}

// Classic canvas: the UI's natural height. The panel fills a taller node (min-height:
// 100%), but its rows never grow, so the last row's bottom plus the panel's padding is
// the content at any node height (rects, so canvas zoom divides out).
function classicContentHeight(node) {
    const panel = node._ddp?.wrap?.querySelector(".ddp-panel");
    if (!panel?.offsetHeight) return 0;
    const box = panel.getBoundingClientRect();
    const scale = box.height / panel.offsetHeight || 1;
    let bottom = box.top;
    for (const child of panel.children) {
        if (child.offsetHeight) bottom = Math.max(bottom, child.getBoundingClientRect().bottom);
    }
    const style = getComputedStyle(panel);
    const floor = style.minHeight.endsWith("px") ? parseFloat(style.minHeight) : 0;
    return Math.ceil(Math.max(floor, (bottom - box.top) / scale + (parseFloat(style.paddingBottom) || 0)));
}

export function calcConfigNodeHeight(node) {
    // Classic canvas: the content + the shared edge (node_edge.js); Node 2.0 its chrome.
    const widget = classicWidget(node);
    if (widget) return classicNodeHeight(node, widget, classicContentHeight(node) || calcConfigDomHeight(node));
    return calcConfigDomHeight(node) + DDP_NODE_BASE_CHROME_H + DDP_CONFIG_OUTPUT_ROW_H;
}

// Classic canvas: the UI fills the node down to the shared edge, like LoRA Loadout and
// Prompt Vault, so a taller node is a taller panel (Node 2.0 does this itself).
export function stampConfigDomHeight(node, nodeHeight = node.size?.[1]) {
    const widget = classicWidget(node);
    if (!widget || !Number.isFinite(nodeHeight)) return;
    node._ddp.wrap.style.setProperty("height", `${classicDomHeight(node, widget, nodeHeight)}px`, "important");
}

export function resizeConfigNode(node) {
    const height = calcConfigNodeHeight(node);
    node.min_size = [MIN_W, height];
    node.setSize([Math.max(node.size?.[0] ?? MIN_W, MIN_W), height]);
    stampConfigDomHeight(node, height);
    node.setDirtyCanvas(true, true);
}

export function renderAll(node) {
    syncActiveOptions(node);
    renderFields(node);
    renderBar(node);
}
