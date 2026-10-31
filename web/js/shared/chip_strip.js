import { el } from "./dom.js";
import { applyCardColorStyle } from "./card_colors.js";

// Presentational chip-strip primitives — the shared, drift-proof rendering for a horizontal
// facet strip of chips. It knows NOTHING about what a chip represents (Prompt Vault categories,
// Collections, …): the consumer builds the chip descriptors and supplies the callbacks; this
// owns the markup + class contract so two consumers can never grow divergent chip DOM.
//
// Consumers: Prompt Vault (categories) today; Collections (ML) next. See COLLECTIONS_GAMEPLAN.md
// §8. The inline notch-editor frame is intentionally NOT extracted yet — PV's editor and the
// Collections editor diverge (merge/purge/export/nsfw vs rename/delete), so per the descriptor
// rule it is extracted when the second editor exists (step 4), against two real consumers.
//
// CSS: chips carry the existing .krc-chip / .krc-chip-split / .krc-chip-notch / .krc-chip-main
// classes. Those rules currently live in Prompt Vault's stylesheet (scoped .krc-pm); step 5
// lifts the reusable ones to a shared .krc-node scope when the ML viewer renders them too.

// dataset key -> data-chip-value. Generic (was PV's data-pm-category) so the active-sync helper
// works for any consumer without knowing the value's meaning.
export const CHIP_VALUE_ATTR = "chipValue";

// The strip container: a shell holding an absolutely-positioned background layer + a scrolling
// flex row. Returns all three so the caller appends chips into `scroll` and swaps the whole
// `shell` on a rebuild. Matches the .krc-chip-list-shell / -bg / -scroll CSS contract.
export function chipStripShell() {
  const shell = el("div", "krc-chip-list-shell");
  const bg = el("div", "krc-chip-list-bg");
  const scroll = el("div", "krc-chip-list-scroll");
  return { shell, bg, scroll };
}

// A plain chip: a single button, no notch / color / pin. E.g. PV's fixed ALL / Unassigned chips.
export function plainChip({ label, value, active = false, title = "", onSelect } = {}) {
  const chip = el("button", "krc-chip" + (active ? " is-active" : ""), { textContent: label });
  if (title) chip.title = title;
  chip.dataset[CHIP_VALUE_ATTR] = value;
  if (onSelect) chip.addEventListener("click", () => onSelect(value));
  return chip;
}

// A split chip: a body button (select) + a `›` notch (open the inline editor). Supports the
// active ring, the pinned-bold label, and an optional card color.
export function splitChip({
  label,
  value,
  active = false,
  pinned = false,
  color = "",
  title = "",
  notchTitle = "Actions",
  onSelect,
  onOpenEditor,
} = {}) {
  const chip = el("div", "krc-chip-split" + (active ? " is-active" : "") + (pinned ? " is-pinned" : ""));
  chip.dataset[CHIP_VALUE_ATTR] = value;
  applyCardColorStyle(chip, color);
  const body = el("button", "krc-chip krc-chip-main", { textContent: label, title: title || `Show ${label}` });
  const notch = el("button", "krc-chip-notch", { textContent: "›", title: notchTitle });
  if (onSelect) body.addEventListener("click", () => onSelect(value));
  if (onOpenEditor) {
    notch.addEventListener("click", (event) => {
      event.stopPropagation();
      onOpenEditor(value);
    });
  }
  chip.append(body, notch);
  return chip;
}

// Toggle just the active state across already-rendered chips (both plain + split) without a
// rebuild — the cheap path when only the selection changed. Reads data-chip-value, so it is
// value-agnostic. Returns true when it ran (the caller falls back to a full rebuild on false).
export function syncActiveChip(scroll, activeValue) {
  if (!scroll) return false;
  scroll.querySelectorAll(".krc-chip, .krc-chip-split").forEach((chip) => {
    chip.classList.toggle("is-active", chip.dataset[CHIP_VALUE_ATTR] === activeValue);
  });
  return true;
}

// The shared inline chip editor (the notch-opened editor shown in place of the strip). Its layout
// is Prompt Vault's original category-editor grid: rows of [name input] / [message] / [attributes]
// / [actions], with the actions row split into as many equal columns as there are actions. The
// consumer supplies everything domain-specific — the message text, an attributes node (toggles +
// swatches), and the ordered action set — so PV (rename/merge/purge/export + nsfw/pin/color) and
// Collections (rename/delete + pin/color) render through ONE component. Prompt-specific pieces are
// just actions/attributes the consumer includes or omits. See COLLECTIONS_GAMEPLAN.md.
//
// `attributes` should be an element with class `krc-chip-editor-attrs` so it spans the full row.
// Each action is { label, title?, className?, confirming?, onClick } — className carries the
// per-action color intent (is-save / is-delete / is-danger / is-export / is-exit).
export function chipEditor({
  inputValue = "",
  inputTitle = "",
  message = "",
  messageTone = "",
  attributes = null,
  actions = [],
  onInput,
  onEnter,
  onEscape,
  onMount,
} = {}) {
  const row = el("div", "krc-chip-editor");
  row.style.setProperty("--krc-chip-editor-cols", String(Math.max(1, actions.length)));
  const input = el("input", "krc-chip-editor-input", { value: inputValue, title: inputTitle });
  const messageEl = el(
    "div",
    "krc-chip-editor-message" + (messageTone ? ` is-${messageTone}` : ""),
    { textContent: message },
  );
  input.addEventListener("input", () => onInput?.(input.value));
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") onEnter?.();
    if (event.key === "Escape") onEscape?.();
  });
  row.append(input, messageEl);
  if (attributes) row.append(attributes);
  for (const action of actions) {
    const btn = el(
      "button",
      "krc-chip-editor-action"
        + (action.className ? ` ${action.className}` : "")
        + (action.confirming ? " is-confirming" : ""),
      { textContent: action.label, title: action.title || "" },
    );
    if (action.onClick) btn.addEventListener("click", action.onClick);
    row.append(btn);
  }
  onMount?.(input);
  return row;
}
