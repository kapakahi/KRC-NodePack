// Config Switcher NOTE parameter: a notes box with a value per config (or one for all of
// them when shared). It never outputs anything: Link skips it, and a run never sees it
// (stripNotesForRun), so editing a note can't change a run or bust ComfyUI's cache.
//
// The box is sized in whole lines, 1-20 (3 by default), from a grip on its bottom edge in
// either mode. The size is this node's, kept in the workflow (node.properties), never in
// presets: the same preset in another node or workflow starts at 3 lines. Every config
// shares the size, so switching configs never resizes the node.
import { h } from "./helpers.js";
import { activeConfigValues, isEditMode, writeData } from "./config.js";
import { resizeConfigNode } from "./field_rows.js";

export const NOTE_TYPE = "note";
// Field types a run never sees (no output): NOTES and SECTION/DIVIDER (section_field.js).
const RUNLESS_TYPES = new Set([NOTE_TYPE, "section"]);
export const NOTE_ROWS_DEFAULT = 3;
export const NOTE_ROWS_MIN = 1;
export const NOTE_ROWS_MAX = 20;
// Keep in sync with .ddp-note-input in styles/fields.css: line-height, padding + border.
const NOTE_LINE_H = 16;
const NOTE_BOX_CHROME_H = 12;
const FIELD_PADDING_H = 4;   // .ddp-field's 2px top + bottom
const ROWS_PROP = "configNoteRows";

function clampRows(rows) {
    const n = Math.round(Number(rows));
    return Number.isFinite(n) ? Math.min(NOTE_ROWS_MAX, Math.max(NOTE_ROWS_MIN, n)) : NOTE_ROWS_DEFAULT;
}

export function noteRows(node, field) {
    const stored = node.properties?.[ROWS_PROP]?.[field.id];
    return stored == null ? NOTE_ROWS_DEFAULT : clampRows(stored);
}

function setNoteRows(node, field, rows) {
    node.properties ||= {};
    const sizes = { ...(node.properties[ROWS_PROP] || {}) };
    if (rows === NOTE_ROWS_DEFAULT) delete sizes[field.id];
    else sizes[field.id] = rows;
    if (Object.keys(sizes).length) node.properties[ROWS_PROP] = sizes;
    else delete node.properties[ROWS_PROP];
}

// A removed NOTE forgets its size.
export function forgetNoteRows(node, fieldId) {
    const sizes = node.properties?.[ROWS_PROP];
    if (!sizes || !(fieldId in sizes)) return;
    const rest = { ...sizes };
    delete rest[fieldId];
    if (Object.keys(rest).length) node.properties[ROWS_PROP] = rest;
    else delete node.properties[ROWS_PROP];
}

const noteBoxHeight = (rows) => rows * NOTE_LINE_H + NOTE_BOX_CHROME_H;

// The NOTE row's height (fieldRowHeight).
export function noteRowHeight(node, field) {
    return noteBoxHeight(noteRows(node, field)) + FIELD_PADDING_H;
}

// The box: read-only text in normal mode, typed in edit mode; longer text scrolls.
export function buildNoteControl(node, field, disabled, editing) {
    const value = activeConfigValues(node, false)?.[field.id];
    const readonly = !editing || disabled;
    // textarea text is child content, not a value attribute (see the h() helper).
    const box = h("textarea", {
        class: "ddp-input ddp-note-input" + (readonly ? " is-readonly" : ""),
        placeholder: editing && !disabled ? "notes" : "",
        readonly,
        spellcheck: "false",
        oninput: (event) => {
            if (!isEditMode(node)) return;
            const config = activeConfigValues(node, true);
            if (!config) return;
            config[field.id] = event.target.value;
            writeData(node);
        },
    }, [String(value ?? "")]);
    box.style.height = `${noteBoxHeight(noteRows(node, field))}px`;
    return h("div", { class: "ddp-note-value" }, [box, buildNoteGrip(node, field, box)]);
}

// Drag the bottom edge: whole lines, the node's height following. The canvas zoom scales
// the DOM, so one line on screen is NOTE_LINE_H times the box's rendered / layout ratio.
function buildNoteGrip(node, field, box) {
    const grip = h("div", {
        class: "ddp-note-grip",
        title: `Drag to resize (${NOTE_ROWS_MIN}-${NOTE_ROWS_MAX} lines)`,
        "aria-hidden": "true",
    });
    grip.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const scale = box.getBoundingClientRect().height / (box.offsetHeight || 1) || 1;
        const startY = event.clientY;
        const startRows = noteRows(node, field);
        grip.setPointerCapture?.(event.pointerId);
        grip.classList.add("is-dragging");
        const move = (moveEvent) => {
            const rows = clampRows(startRows + Math.round((moveEvent.clientY - startY) / (NOTE_LINE_H * scale)));
            if (rows === noteRows(node, field)) return;
            setNoteRows(node, field, rows);
            box.style.height = `${noteBoxHeight(rows)}px`;
            resizeConfigNode(node);
        };
        const end = () => {
            grip.classList.remove("is-dragging");
            grip.removeEventListener("pointermove", move);
            grip.removeEventListener("pointerup", end);
            grip.removeEventListener("pointercancel", end);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", end);
        grip.addEventListener("pointercancel", end);
    });
    return grip;
}

// config_data as a run receives it: NOTE and SECTION/DIVIDER fields and their values (every
// config's and the shared one) left out. The workflow keeps them; only the queued prompt
// drops them.
export function stripNotesForRun(raw) {
    let data;
    try {
        data = JSON.parse(raw || "{}");
    } catch (e) {
        return raw;
    }
    if (!data || !Array.isArray(data.fields)) return raw;
    const ids = new Set(data.fields.filter((field) => RUNLESS_TYPES.has(field?.type)).map((field) => String(field.id)));
    if (!ids.size) return raw;
    const without = (values) => (values && typeof values === "object" && !Array.isArray(values)
        ? Object.fromEntries(Object.entries(values).filter(([key]) => !ids.has(key)))
        : values);
    const configs = data.configs && typeof data.configs === "object" && !Array.isArray(data.configs)
        ? Object.fromEntries(Object.entries(data.configs).map(([name, values]) => [name, without(values)]))
        : data.configs;
    return JSON.stringify({
        ...data,
        fields: data.fields.filter((field) => !ids.has(String(field?.id))),
        configs,
        ...(data.shared_values ? { shared_values: without(data.shared_values) } : {}),
    });
}

// The queued prompt's config_data goes through stripNotesForRun (serializeValue is the
// prompt's value; the workflow still saves widget.value).
export function installNoteRunStrip(widget) {
    if (!widget || widget._krcNoteStrip) return;
    widget._krcNoteStrip = true;
    const previous = widget.serializeValue;
    widget.serializeValue = async function (...args) {
        const value = previous ? await previous.apply(this, args) : this.value;
        return stripNotesForRun(value);
    };
}
