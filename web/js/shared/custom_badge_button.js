import { normalizeCustomBadge } from "./card_context_menu.js";
import { el, stopCanvasEvents } from "./dom.js";
import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";

export function customBadgeActionButton({
  value = "",
  active = false,
  title = "",
  disabled = false,
  onSave,
} = {}) {
  const button = el("button", `krc-icon-button krc-custom-badge-button${active || value ? " is-active" : ""}`, {
    type: "button",
    title: title || "Custom badge",
  });
  button.disabled = disabled || typeof onSave !== "function";
  button.setAttribute("aria-haspopup", "menu");
  button.append(el("span", "krc-custom-badge-glyph krc-label-tag-glyph"));
  stopCanvasEvents(button);

  let menu = null;
  const close = () => {
    if (menu) {
      closeFloatingMenu();
      menu = null;
    }
    button.setAttribute("aria-expanded", "false");
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) return;

    close();
    menu = el("div", "krc-card-context-menu krc-custom-badge-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");

    const row = el("div", "krc-card-menu-badge-row");
    const input = el("input", "krc-card-menu-badge-input", {
      type: "text",
      value: value || "",
      placeholder: "Badge",
      maxLength: 10,
      title: "Letters, numbers, spaces. 10 max.",
    });
    const save = el("button", "krc-card-menu-badge-save", {
      type: "button",
      textContent: "✓",
      title: "Save badge",
    });
    const remove = el("button", "krc-card-menu-badge-remove", {
      type: "button",
      textContent: "×",
      title: "Remove badge",
    });
    const syncValidity = () => {
      const normalized = normalizeCustomBadge(input.value);
      const invalid = normalized === null;
      input.classList.toggle("is-invalid", invalid);
      save.disabled = invalid;
      remove.disabled = !normalizeCustomBadge(value || "");
    };
    input.addEventListener("input", syncValidity);
    input.addEventListener("keydown", (keyEvent) => {
      keyEvent.stopPropagation();
      if (keyEvent.key === "Enter" && !save.disabled) {
        keyEvent.preventDefault();
        save.click();
      } else if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        close();
      }
    });
    save.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const normalized = normalizeCustomBadge(input.value);
      if (normalized === null) {
        syncValidity();
        return;
      }
      const result = await onSave(normalized);
      if (result !== false) close();
    });
    remove.addEventListener("click", async (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      const result = await onSave("");
      if (result !== false) close();
    });
    row.append(input, remove, save);
    menu.append(row);
    stopCanvasEvents(menu);
    syncValidity();

    const opened = toggleFloatingMenu(button, menu, {
      align: "right",
      onClose: () => {
        menu = null;
        button.setAttribute("aria-expanded", "false");
      },
    });
    button.setAttribute("aria-expanded", opened ? "true" : "false");
    if (opened) {
      input.focus();
      input.select();
    } else {
      menu = null;
    }
  });

  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") close();
  });

  return button;
}
