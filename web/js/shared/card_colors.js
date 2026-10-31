export const CARD_COLOR_NONE = "";

export const CARD_COLOR_PALETTE = [
  { id: "black", label: "Black", hex: "#2E2E2E" },
  { id: "blue", label: "Blue", hex: "#4F7A9E" },
  { id: "gray", label: "Gray", hex: "#8A8F98" },
  { id: "green", label: "Green", hex: "#7B9E87" },
  { id: "orange", label: "Orange", hex: "#C28F5C" },
  { id: "purple", label: "Purple", hex: "#9179B0" },
  { id: "red", label: "Red", hex: "#D96D6D" },
  { id: "yellow", label: "Yellow", hex: "#D8B84F" },
];

const COLOR_BY_ID = new Map(CARD_COLOR_PALETTE.map((item) => [item.id, item]));
const HEX_BY_VALUE = new Map(CARD_COLOR_PALETTE.map((item) => [item.hex.toLowerCase(), item.id]));
const CARD_COLOR_SOFT_ALPHA = 0.52;
const CARD_COLOR_BORDER_ALPHA = 0.72;
const CARD_COLOR_SELECTED_BORDER_ALPHA = 0.94;

export function normalizeCardColorId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return CARD_COLOR_NONE;
  }
  const lowered = raw.toLowerCase();
  if (COLOR_BY_ID.has(lowered)) {
    return lowered;
  }
  return HEX_BY_VALUE.get(lowered) || CARD_COLOR_NONE;
}

export function cardColorById(value) {
  return COLOR_BY_ID.get(normalizeCardColorId(value)) || null;
}

export function cardColorHex(value) {
  return cardColorById(value)?.hex || "";
}

export function hexToRgba(color, alpha = 0.24) {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color || "");
  if (!match) {
    return "";
  }
  const [, r, g, b] = match;
  return `rgba(${parseInt(r, 16)}, ${parseInt(g, 16)}, ${parseInt(b, 16)}, ${alpha})`;
}

export function applyCardColorStyle(element, colorId, { selected = false } = {}) {
  const color = cardColorById(colorId);
  element.classList.toggle("is-selected", selected);
  element.dataset.cardColor = color?.id || "";
  if (!color) {
    element.style.removeProperty("--krc-card-color");
    element.style.removeProperty("--krc-card-color-soft");
    element.style.removeProperty("--krc-card-color-border");
    return;
  }
  element.style.setProperty("--krc-card-color", color.hex);
  element.style.setProperty("--krc-card-color-soft", hexToRgba(color.hex, CARD_COLOR_SOFT_ALPHA));
  element.style.setProperty("--krc-card-color-border", hexToRgba(color.hex, selected ? CARD_COLOR_SELECTED_BORDER_ALPHA : CARD_COLOR_BORDER_ALPHA));
}
