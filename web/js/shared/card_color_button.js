import {
  CARD_COLOR_NONE,
  CARD_COLOR_PALETTE,
  cardColorHex,
  normalizeCardColorId,
} from "./card_colors.js";
// Share the body-portaled popup machinery (position, single-open, outside-close)
// AND its palette sync: the menu now inherits the node's per-node theme instead
// of being stuck on the global palette (Native → Gray for floating surfaces).
import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";

function buildColorMenu(options, onSelect) {
  const menu = document.createElement("div");
  menu.className = "krc-card-color-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");

  options.forEach(({ id, label, hex = "", rainbow = false, swatchColor = id }) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "krc-card-color-option";
    option.dataset.cardColor = swatchColor;
    option.setAttribute("role", "option");
    if (hex) option.style.setProperty("--krc-card-filter-color", hex);
    if (rainbow) option.classList.add("is-rainbow");
    const swatch = document.createElement("span");
    swatch.className = "krc-card-color-option-swatch";
    const text = document.createElement("span");
    text.className = "krc-card-color-option-label";
    text.textContent = label;
    option.append(swatch, text);
    option.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onSelect?.(id);
    });
    menu.append(option);
  });

  return menu;
}

export function createCardColorButton({
  record = null,
  explicitColor = record?.cardColor,
  inheritedColor = "",
  baseTitle = "Card color",
  disabled = !record,
  onChange,
} = {}) {
  const button = document.createElement("button");
  button.className = "krc-icon-button krc-card-color-button";
  button.type = "button";
  const glyph = document.createElement("span");
  glyph.className = "krc-card-color-filter-glyph";

  const state = { value: "" };
  const inheritedValue = () => (typeof inheritedColor === "function" ? inheritedColor() : inheritedColor);

  const applySwatch = (explicit, inherited = "") => {
    const displayColor = explicit || inherited;
    state.value = explicit;
    button.dataset.cardColor = displayColor;
    button.title = baseTitle;
    const colorHex = cardColorHex(displayColor);
    if (colorHex) button.style.setProperty("--krc-card-filter-color", colorHex);
    else button.style.removeProperty("--krc-card-filter-color");
  };

  const selectValue = (value) => {
    const next = normalizeCardColorId(value);
    applySwatch(next, next ? "" : normalizeCardColorId(inheritedValue()));
    closeFloatingMenu();
    onChange?.(next, { next, button, select: state });
  };

  const menu = buildColorMenu([
    { id: CARD_COLOR_NONE, label: "None" },
    ...CARD_COLOR_PALETTE.map((item) => ({ id: item.id, label: item.label, hex: item.hex })),
  ], selectValue);

  const initialExplicit = normalizeCardColorId(explicitColor);
  applySwatch(initialExplicit, normalizeCardColorId(inheritedValue()));

  button.disabled = disabled;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;
    toggleFloatingMenu(button, menu);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeFloatingMenu();
  });

  button.append(glyph);
  return button;
}

export function createCardColorFilterButton({
  value = "",
  title = "",
  onChange,
} = {}) {
  const current = normalizeCardColorId(value);
  const button = document.createElement("button");
  button.className = `krc-icon-button krc-card-color-filter-button${current || value === "__none__" ? " is-active" : ""}`;
  button.type = "button";
  button.title = title || (current ? `Showing ${current} cards` : value === "__none__" ? "Showing uncolored cards" : "Showing all card colors");
  button.dataset.cardColor = value === "__none__" ? "__none__" : current;
  const colorHex = cardColorHex(current);
  if (colorHex) {
    button.style.setProperty("--krc-card-filter-color", colorHex);
  }

  const glyph = document.createElement("span");
  glyph.className = "krc-card-color-filter-glyph";
  button.append(glyph);

  const menu = buildColorMenu([
    { id: "", label: "All colors", rainbow: true },
    { id: "__none__", label: "No color", swatchColor: "" },
    ...CARD_COLOR_PALETTE.map((item) => ({ id: item.id, label: item.label, hex: item.hex })),
  ], (next) => {
    closeFloatingMenu();
    onChange?.(next);
  });

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleFloatingMenu(button, menu);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeFloatingMenu();
  });

  return button;
}
