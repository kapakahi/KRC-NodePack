// Loadout Kit field strip: one row under each slot, a `[label:] [pill]` per descriptor
// field (RefMod Loadout's S / X / components / V / A strip, generated). Floats and ints
// edit in the shared numeric popover, enums in the body-portaled option menu, bools
// toggle on click. An empty slot shows the defaults, dimmed, and nothing is editable.
import { closeFloatingMenu, toggleFloatingMenu } from "../floating_menu.js";
import { openNumericPopover } from "../numeric_popover.js";
import { modalPaletteIdForNode } from "../node_palette.js";
import { stopCanvasEvents } from "../dom.js";
import { coerceField, fieldDecimals, formatField, isFieldDimmed, sanitizeFieldInput } from "./fields.js";

// Sliders move in coarse steps; the nudge buttons and typing are exact.
const SLIDER_STEPS_PER_NUDGE = 5;

export const fieldStripMethods = {
  renderFieldStrip(stackId, index) {
    const entry = this.entryAtSlot(stackId, index);
    const strip = document.createElement("div");
    strip.className = "krc-kit-field-strip";
    strip.classList.toggle("is-empty", !entry);
    const editable = Boolean(entry);
    for (const field of this.kit.fields) {
      strip.append(this.renderStripField(stackId, index, field, entry, editable));
    }
    return strip;
  },

  // Re-render one slot's strip in place (e.g. an enum pick re-dims dependent fields).
  refreshFieldStrip(stackId, index) {
    const strip = this.root?.querySelector(`.krc-kit-slot-row[data-slot-index="${index}"] > .krc-kit-field-strip`);
    strip?.replaceWith(this.renderFieldStrip(stackId, index));
  },

  renderStripField(stackId, index, field, entry, editable) {
    const wrap = document.createElement("span");
    wrap.className = `krc-kit-field is-${field.type}`;
    wrap.dataset.field = field.key;
    wrap.classList.toggle("is-dimmed", isFieldDimmed(field, this.kit.fields, entry));
    wrap.title = field.title || field.key;
    if (field.label) {
      const label = document.createElement("span");
      label.className = "krc-kit-field-label";
      label.textContent = `${field.label}:`;
      wrap.append(label);
    }
    const pill = document.createElement(editable ? "button" : "span");
    pill.className = "krc-kit-field-value";
    const value = entry?.[field.key];
    if (field.type === "enum") {
      const text = document.createElement("span");
      text.textContent = formatField(field, value);
      const caret = document.createElement("span");
      caret.className = "krc-kit-caret";
      caret.textContent = "▾";
      pill.append(text, caret);
    } else {
      pill.textContent = formatField(field, value);
    }
    wrap.append(pill);
    if (!editable) return wrap;

    pill.type = "button";
    stopCanvasEvents(pill);
    const name = (field.title || field.key).toLowerCase();
    if (field.type === "enum") {
      this.installEnumMenu(pill, stackId, index, field, coerceField(field, value));
    } else if (field.type === "bool") {
      pill.setAttribute("aria-label", `Toggle slot ${index + 1} ${name}`);
      pill.addEventListener("click", (event) => {
        event.stopPropagation();
        const live = this.entryAtSlot(stackId, index);
        if (!live) return;
        this.setEntryField(stackId, index, field.key, !coerceField(field, live[field.key]));
        this.refreshFieldStrip(stackId, index);
      });
    } else {
      pill.setAttribute("aria-label", `Edit slot ${index + 1} ${name}`);
      pill.addEventListener("click", (event) => {
        event.stopPropagation();
        this.openNumberEditor(pill, stackId, index, field);
      });
    }
    return wrap;
  },

  // Compact dropdown: the pill is the button, the shared menu-select option menu
  // (body-portaled, node palette) holds the choices.
  installEnumMenu(pill, stackId, index, field, current) {
    pill.setAttribute("aria-haspopup", "listbox");
    pill.setAttribute("aria-label", `Slot ${index + 1} ${(field.title || field.key).toLowerCase()}`);
    const menu = document.createElement("div");
    menu.className = "krc-menu-select-menu krc-kit-enum-menu";
    menu.hidden = true;
    menu.setAttribute("role", "listbox");
    field.options.forEach((choice) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "krc-menu-select-option";
      option.classList.toggle("is-selected", choice === current);
      option.textContent = choice;
      option.setAttribute("role", "option");
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeFloatingMenu();
        this.setEntryField(stackId, index, field.key, choice);
        this.refreshFieldStrip(stackId, index);
      });
      menu.append(option);
    });
    pill.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleFloatingMenu(pill, menu, { align: "left" });
    });
    pill.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeFloatingMenu();
    });
  },

  // Write one field onto the live entry (fresh lookup: stack state can be rebuilt during
  // modified-badge checks). Returns the stored value, or null for an empty slot.
  setEntryField(stackId, index, key, value) {
    const live = this.entryAtSlot(stackId, index);
    if (!live) return null;
    const field = this.kit.fields.find((item) => item.key === key);
    const current = field ? coerceField(field, live[key]) : live[key];
    if (value === current) return current;
    live[key] = value;
    this.persistStack(stackId);
    this.updatePresetStatusUi();
    this.refreshHeader();
    return value;
  },

  // Float / int: LL's strength popover, ranged to the field.
  openNumberEditor(anchor, stackId, index, field) {
    const live = this.entryAtSlot(stackId, index);
    if (!live) return;
    this.closeFieldEditor(true);

    const isFloat = field.type === "float";
    const step = isFloat ? Number(field.step) || 0.01 : 1;
    const name = field.title || field.key;
    const clamp = (value) => coerceField(field, value);
    const shown = isFloat ? String(Number(step.toFixed(fieldDecimals(field)))) : "1";
    const editor = openNumericPopover({
      root: this.root,
      anchor,
      initialValue: clamp(live[field.key]),
      classes: {
        popover: "krc-strength-popover",
        input: "krc-strength-value-input",
        slider: "krc-strength-slider",
        nudge: "krc-strength-nudge",
        sliderRow: "krc-strength-slider-row",
      },
      ariaLabel: `Edit ${name.toLowerCase()}`,
      inputMode: isFloat ? "decimal" : "numeric",
      inputAriaLabel: `${name} value`,
      slider: {
        min: field.min,
        max: field.max,
        step: isFloat ? step * SLIDER_STEPS_PER_NUDGE : 1,
        value: clamp,
        ariaLabel: `${name} slider`,
      },
      nudge: {
        step,
        downTitle: `Decrease by ${shown}`,
        downAriaLabel: `Decrease ${name.toLowerCase()} by ${shown}`,
        upTitle: `Increase by ${shown}`,
        upAriaLabel: `Increase ${name.toLowerCase()} by ${shown}`,
      },
      themeId: modalPaletteIdForNode(this.node),
      formatValue: (value) => formatField(field, value),
      sanitizeInput: (value) => sanitizeFieldInput(field, value),
      isPartialInput: (value) => !value || value === "." || value === "-",
      normalizeValue: clamp,
      onCommit: (draftValue) => {
        const committed = this.setEntryField(stackId, index, field.key, clamp(draftValue));
        if (committed !== null && anchor.isConnected) anchor.textContent = formatField(field, committed);
      },
      onClose: ({ popover }) => {
        if (this._fieldEditor?.popover === popover) this._fieldEditor = null;
      },
    });
    this._fieldEditor = editor;
  },

  closeFieldEditor(confirm = true) {
    this._fieldEditor?.close(confirm);
  },
};
