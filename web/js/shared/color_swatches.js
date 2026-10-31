import { CARD_COLOR_NONE, CARD_COLOR_PALETTE } from "./card_colors.js";

/*
 * A row of selectable color-swatch chips: a "none" chip followed by one chip per
 * CARD_COLOR_PALETTE entry. The chip matching `selected` gets `.is-active`;
 * clicking a chip calls `onSelect(id)`.
 *
 * Shared by the Prompt Vault category config and the LoRA Loadout folder
 * config so both look and behave identically. Emits `.krc-swatches` / `.krc-swatch`
 * (styled in shared/components.css). Pass `className` to add layout classes to
 * the wrapper (e.g. the Prompt Vault category row's right-alignment).
 */
export function buildColorSwatches({ selected = CARD_COLOR_NONE, onSelect, noneTitle = "No color", className = "" } = {}) {
  const wrap = document.createElement("div");
  wrap.className = `krc-swatches ${className}`.trim();

  const chip = (id, { extra = "", title = "", hex = "" }) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `krc-swatch ${extra} ${selected === id ? "is-active" : ""}`.replace(/\s+/g, " ").trim();
    if (title) button.title = title;
    if (hex) button.style.setProperty("--krc-swatch", hex);
    if (onSelect) button.addEventListener("click", () => onSelect(id));
    return button;
  };

  wrap.append(chip(CARD_COLOR_NONE, { extra: "is-none", title: noneTitle }));
  for (const item of CARD_COLOR_PALETTE) {
    wrap.append(chip(item.id, { title: item.label, hex: item.hex }));
  }
  return wrap;
}
