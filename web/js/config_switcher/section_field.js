// Config Switcher SECTION/DIVIDER (2026-10-29): a full-width row, one ordinary parameter row
// tall, with no name column. Blank, it's a gap; with a title, the title shows bold and
// centred. An optional card colour washes the whole row. Like NOTES it outputs nothing:
// Link skips it and a run never sees it (stripNotesForRun drops it too).
//
// The section's saved shape is { id, type: "section", name (the title), color }: the title
// and colour belong to the preset's layout. A field belongs to the section above it, up to
// the next section, by position only (sectionOf): nothing is stored per field, so moving a
// field moves it between sections. A coloured section tints its fields with a lighter wash
// of its colour (applySectionTint, drawn from that rule; nothing stored). Sections don't fold:
// hiding values would defeat the node (decided 2026-10-29).
import { h } from "./helpers.js";
import { isEditMode, writeData } from "./config.js";
import { applyCardColorStyle, cardColorHex, hexToRgba, normalizeCardColorId } from "../shared/card_colors.js";
import { createCardColorButton } from "../shared/card_color_button.js";
import { renderFields } from "./field_rows.js";

export const SECTION_TYPE = "section";
// Keep in step with SECTION_TITLE_MAX in utils/config_switcher_presets.py: the server
// stores what the page sends, so a save never reads as Modified.
export const SECTION_TITLE_MAX = 60;
// A member field's wash, lighter than the section row's (the cards' soft colour is 0.52), so
// dropdowns, number boxes and switches stay easy to read.
export const SECTION_TINT_ALPHA = 0.48;

export const isSection = (field) => field?.type === SECTION_TYPE;

// The section a field belongs to: the nearest section above `index`, or null (fields above
// the first section belong to none). A section itself belongs to none.
export function sectionOf(fields, index) {
    const list = Array.isArray(fields) ? fields : [];
    if (isSection(list[index])) return null;
    for (let i = Math.min(index, list.length) - 1; i >= 0; i -= 1) {
        if (isSection(list[i])) return list[i];
    }
    return null;
}

export const sectionTitle = (field) => String(field?.name || "").slice(0, SECTION_TITLE_MAX);

// The row's content: the title (bold, centred) in normal mode; in edit mode a title box and
// the card colour button. The row itself (colour wash, remove, grip) is built by field_rows.js.
export function buildSectionContent(node, field, editing) {
    if (!editing) {
        return [h("div", { class: "ddp-section-title", text: sectionTitle(field) })];
    }
    const title = h("input", {
        class: "ddp-input ddp-section-title-input",
        type: "text",
        placeholder: "Section title (optional)",
        maxlength: String(SECTION_TITLE_MAX),
        value: sectionTitle(field),
        oninput: (event) => {
            if (!isEditMode(node)) return;
            field.name = event.target.value.slice(0, SECTION_TITLE_MAX);
            writeData(node);
        },
    });
    const color = createCardColorButton({
        explicitColor: field.color || "",
        baseTitle: "Section colour",
        disabled: false,
        onChange: (next) => {
            if (!isEditMode(node)) return;
            field.color = normalizeCardColorId(next);
            writeData(node);
            renderFields(node);   // the section row and the fields it tints
        },
    });
    color.classList.add("ddp-section-color");
    return [title, color];
}

// The whole row carries the section colour as the cards' soft wash.
export function applySectionColor(row, field) {
    applyCardColorStyle(row, normalizeCardColorId(field?.color));
}

// A field under a coloured section: a lighter wash of that colour (none without one).
export function applySectionTint(row, section) {
    const hex = cardColorHex(section?.color);
    row.classList.toggle("is-section-tinted", Boolean(hex));
    if (hex) row.style.setProperty("--ddp-section-tint", hexToRgba(hex, SECTION_TINT_ALPHA));
    else row.style.removeProperty("--ddp-section-tint");
}
