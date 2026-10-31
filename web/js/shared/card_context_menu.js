import { el, stopCanvasEvents } from "./dom.js";
import {
  CARD_COLOR_NONE,
  CARD_COLOR_PALETTE,
  cardColorHex,
  normalizeCardColorId,
} from "./card_colors.js";
import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";

const QUICK_ACTION_ORDER = ["color", "customBadge", "favorite", "pin", "nsfw"];
const CUSTOM_BADGE_MAX_LENGTH = 10;
const CUSTOM_BADGE_RESERVED = new Set(["nsfw", "draft", "modified"]);

export function normalizeCustomBadge(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  if (!text) {
    return "";
  }
  if (text.length > CUSTOM_BADGE_MAX_LENGTH) {
    return null;
  }
  if (!/^[A-Za-z0-9 ]+$/.test(text)) {
    return null;
  }
  if (CUSTOM_BADGE_RESERVED.has(text.toLowerCase())) {
    return null;
  }
  return text;
}

function asBool(value, fallback = true) {
  return value == null ? fallback : Boolean(value);
}

function callMenuFactory(factory, item, key, context) {
  if (typeof factory !== "function") {
    return null;
  }
  const result = factory(item, key, context);
  return result && typeof result === "object" ? result : null;
}

function appendMenuItem(menu, item, context, setMode) {
  if (!item || item.visible === false) {
    return false;
  }
  if (item.kind === "separator") {
    menu.append(el("div", "krc-card-menu-separator"));
    return true;
  }
  if (item.kind === "custom" && typeof item.render === "function") {
    const rendered = item.render(context);
    if (rendered) {
      menu.append(rendered);
      return true;
    }
    return false;
  }

  const button = el("button", `krc-card-menu-item${item.danger ? " is-danger" : ""}`);
  button.type = "button";
  button.disabled = Boolean(item.disabled);
  button.title = item.title || item.label || "";
  if (item.id) {
    button.dataset.cardMenuAction = item.id;
  }
  const confirmLabel = item.confirmLabel || "Confirm";
  const baseLabel = item.label || "";
  let armed = false;
  let armTimer = null;
  const resetArm = () => {
    armed = false;
    button.classList.remove("is-confirming");
    const label = button.querySelector(".krc-card-menu-item-label");
    if (label) label.textContent = baseLabel;
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
  };
  if (item.icon) {
    button.append(el("span", `krc-card-menu-item-icon ${item.iconClass || ""}`, {
      textContent: item.icon,
    }));
  }
  button.append(el("span", "krc-card-menu-item-label", { textContent: baseLabel }));
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) {
      return;
    }
    if (item.mode) {
      setMode?.(item.mode);
      return;
    }
    if (item.confirm && !armed) {
      armed = true;
      button.classList.add("is-confirming");
      button.querySelector(".krc-card-menu-item-label").textContent = confirmLabel;
      armTimer = setTimeout(resetArm, item.confirmTimeout || 2400);
      return;
    }
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    const result = await item.onClick?.(event, context);
    if (result !== false) {
      closeFloatingMenu();
    } else if (item.confirm) {
      resetArm();
    }
  });
  menu.append(button);
  return true;
}

function buildTextRow(config, context, setMode, rowConfig = {}) {
  const row = el("div", `krc-card-menu-text-row ${rowConfig.className || ""}`.trim());
  const disabled = Boolean(rowConfig.disabled) || typeof rowConfig.onSave !== "function";
  const back = el("button", "krc-card-menu-mode-back", { textContent: "‹", title: "Back" });
  back.type = "button";
  back.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setMode("quick");
  });
  const input = el("input", rowConfig.inputClass || "krc-card-menu-text-input", {
    type: "text",
    value: rowConfig.value || "",
    placeholder: rowConfig.placeholder || "",
    maxLength: rowConfig.maxLength || 120,
    disabled,
    title: rowConfig.title || "",
  });
  const save = el("button", rowConfig.saveClass || "krc-card-menu-text-save", {
    type: "button",
    textContent: rowConfig.saveIcon || "✓",
    title: rowConfig.saveTitle || "Save",
    disabled,
  });
  const remove = rowConfig.canRemove ? el("button", rowConfig.removeClass || "krc-card-menu-text-remove", {
    type: "button",
    textContent: rowConfig.removeIcon || "×",
    title: rowConfig.removeTitle || "Remove",
    disabled,
  }) : null;
  const normalize = typeof rowConfig.normalize === "function"
    ? rowConfig.normalize
    : (value) => String(value || "").trim();
  const syncValidity = () => {
    const normalized = normalize(input.value, context, config);
    const invalid = normalized === null;
    input.classList.toggle("is-invalid", invalid);
    save.disabled = disabled || invalid;
    if (remove) remove.disabled = disabled || !(rowConfig.hasValue ?? normalize(rowConfig.value || "", context, config));
  };
  input.addEventListener("input", syncValidity);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !save.disabled) {
      event.preventDefault();
      save.click();
    }
  });
  save.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (save.disabled) {
      return;
    }
    const normalized = normalize(input.value, context, config);
    if (normalized === null) {
      syncValidity();
      return;
    }
    const result = await rowConfig.onSave(normalized, context);
    if (result !== false) {
      closeFloatingMenu();
    }
  });
  remove?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (remove.disabled) {
      return;
    }
    const result = await rowConfig.onSave("", context);
    if (result !== false) {
      closeFloatingMenu();
    }
  });
  syncValidity();
  row.append(back, input);
  if (remove) row.append(remove);
  row.append(save);
  return row;
}

function quickButton(kind, action, context, setMode) {
  if (!action || action.visible === false) {
    return null;
  }
  const active = Boolean(action.active ?? action.checked);
  const button = el("button", `krc-card-menu-quick-button is-${kind}${active ? " is-on" : ""}`);
  button.type = "button";
  button.disabled = Boolean(action.disabled);
  button.title = action.title || "";
  button.setAttribute("aria-label", action.label || action.title || kind);
  button.setAttribute("aria-pressed", action.mixed ? "mixed" : String(active));
  if (kind === "color") {
    const color = normalizeCardColorId(action.value);
    button.dataset.cardColor = color;
    const hex = cardColorHex(color);
    if (hex) button.style.setProperty("--krc-card-filter-color", hex);
    button.append(el("span", "krc-card-color-filter-glyph"));
  } else if (kind === "customBadge") {
    button.append(el("span", "krc-card-menu-badge-glyph krc-label-tag-glyph"));
  } else if (kind === "favorite") {
    button.textContent = "★";
  } else if (kind === "pin") {
    button.append(el("span", "krc-pin-glyph"));
  } else if (kind === "nsfw") {
    button.append(el("span", "krc-nsfw-glyph", { textContent: "⊘" }));
  }
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (button.disabled) {
      return;
    }
    if (action.mode) {
      setMode(action.mode);
      return;
    }
    if (kind === "color") {
      setMode("color");
      return;
    }
    if (kind === "customBadge") {
      setMode("badge");
      return;
    }
    const result = await action.onToggle?.(event, context);
    if (result !== false) closeFloatingMenu();
  });
  return button;
}

function buildQuickRow(config, context, setMode) {
  const row = el("div", "krc-card-menu-quick-row");
  const actions = config.quickActions || {};
  for (const kind of QUICK_ACTION_ORDER) {
    const button = quickButton(kind, actions[kind], context, setMode);
    if (button) {
      row.append(button);
    }
  }
  return row.children.length ? row : null;
}

function buildColorRow(config, context, setMode) {
  const row = el("div", "krc-card-menu-color-row");
  const action = config.quickActions?.color || {};
  const back = el("button", "krc-card-menu-mode-back", { textContent: "‹", title: "Back" });
  back.type = "button";
  back.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setMode("quick");
  });
  row.append(back);

  const selected = normalizeCardColorId(action.value);
  const swatch = (id, { title = "", hex = "" } = {}) => {
    const button = el("button", `krc-card-menu-swatch ${!action.mixed && selected === id ? "is-active" : ""}`.trim());
    button.type = "button";
    button.title = title;
    button.dataset.cardColor = id;
    if (hex) button.style.setProperty("--krc-swatch", hex);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const result = await action.onChange?.(id, context);
      if (result !== false) closeFloatingMenu();
    });
    return button;
  };

  row.append(swatch(CARD_COLOR_NONE, { title: "No color" }));
  for (const item of CARD_COLOR_PALETTE) {
    row.append(swatch(item.id, { title: item.label, hex: item.hex }));
  }
  return row;
}

function buildBadgeRow(config, context, setMode) {
  const action = config.quickActions?.customBadge || {};
  return buildTextRow(config, context, setMode, {
    className: "krc-card-menu-badge-row",
    inputClass: "krc-card-menu-badge-input",
    saveClass: "krc-card-menu-badge-save",
    value: action.value || "",
    placeholder: action.mixed ? "Mixed badges" : "Badge",
    maxLength: CUSTOM_BADGE_MAX_LENGTH,
    disabled: action.disabled,
    title: action.title || "Letters, numbers, spaces. 10 max.",
    saveTitle: action.saveTitle || "Save badge",
    canRemove: true,
    hasValue: action.hasValue,
    removeClass: "krc-card-menu-badge-remove",
    removeTitle: action.removeTitle || "Remove badge",
    normalize: normalizeCustomBadge,
    onSave: action.onSave,
  });
}

function buildRenameRow(config, context, setMode) {
  const action = config.rename || {};
  return buildTextRow(config, context, setMode, {
    className: "krc-card-menu-rename-row",
    inputClass: "krc-card-menu-rename-input",
    saveClass: "krc-card-menu-rename-save",
    value: action.value || "",
    placeholder: action.placeholder || "Name",
    maxLength: action.maxLength || 160,
    disabled: action.disabled,
    title: action.title || "Rename",
    saveTitle: action.saveTitle || "Save name",
    normalize: action.normalize,
    onSave: action.onSave,
  });
}

export function buildCardContextMenu(config = {}, context = {}) {
  const menu = el("div", "krc-card-context-menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  let mode = "quick";

  const quickSlot = el("div", "krc-card-menu-quick-slot");
  const renderMode = () => {
    quickSlot.textContent = "";
    if (mode === "color") {
      quickSlot.append(buildColorRow(config, context, setMode));
    } else if (mode === "badge") {
      quickSlot.append(buildBadgeRow(config, context, setMode));
    } else if (mode === "rename") {
      quickSlot.append(buildRenameRow(config, context, setMode));
    } else if (config.modes && typeof config.modes[mode] === "function") {
      // Consumer-supplied sub-view (e.g. Prompt Vault's "move to category" picker).
      // Kept out of this shared file so node-specific vocabulary never leaks in; the
      // render fn gets (config, context, setMode) and returns the sub-view element.
      const rendered = config.modes[mode](config, context, setMode);
      if (rendered) {
        quickSlot.append(rendered);
      }
    } else {
      const row = buildQuickRow(config, context, setMode);
      if (row) {
        quickSlot.append(row);
      }
      // (API 1.17) A consumer's own block under the quick row in the main view (e.g. KRC
      // Media's slot boxes): `quickExtra(context, setMode)` returns an element or null.
      // It owns its own updates (the menu stays open while it changes itself).
      const extra = typeof config.quickExtra === "function" ? config.quickExtra(context, setMode) : null;
      if (extra) {
        quickSlot.append(extra);
      }
    }
  };
  const setMode = (next) => {
    mode = next || "quick";
    renderMode();
  };
  renderMode();
  const hasQuickActions = quickSlot.children.length > 0;
  if (hasQuickActions) {
    menu.append(quickSlot);
  }

  const actions = Array.isArray(config.actions) ? config.actions : [];
  const actionCount = actions.reduce(
    (count, item) => count + (appendMenuItem(menu, item, context, setMode) ? 1 : 0),
    0,
  );

  if (!hasQuickActions && !actionCount) {
    menu.append(el("div", "krc-card-menu-empty", { textContent: "No actions" }));
  }

  stopCanvasEvents(menu);
  menu.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    closeFloatingMenu();
  });
  return menu;
}

export function createCardNotchButton({ item, key, source, opts = {}, card } = {}) {
  const configFactory = source?.notchMenu;
  if (typeof configFactory !== "function") {
    return null;
  }
  // Default: notch shows on every card with a notchMenu. A source opts a
  // specific card out by returning false; absent hook == shown.
  if (source.hasNotch?.(item, key, opts) === false) {
    return null;
  }

  const button = el("button", "krc-card-notch-button", {
    type: "button",
    title: opts.notchTitle || "Card actions",
  });
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  button.append(el("span", "krc-card-notch-glyph", { textContent: "⌄" }));
  stopCanvasEvents(button);

  let menu = null;
  const closeExisting = () => {
    if (menu) {
      closeFloatingMenu();
      menu = null;
      button.setAttribute("aria-expanded", "false");
    }
  };

  // Open the menu: under the card from the notch, or (API 1.19) at the pointer from a
  // right-click on a card in the KRC Portal.
  const open = (point = null) => {
    const context = { item, key, source, opts, card, button };
    const config = callMenuFactory(configFactory, item, key, context);
    if (!config || config.visible === false) {
      return;
    }
    closeExisting();
    menu = buildCardContextMenu(config, context);
    // A point anchor: the menu's top-left at the pointer.
    const at = point && {
      getBoundingClientRect: () => ({ left: point.x, right: point.x, top: point.y, bottom: point.y, width: 0, height: 0 }),
    };
    const opened = toggleFloatingMenu(button, menu, {
      // Native-dropdown feel: open flush below the whole card (not the small notch
      // button), with no gap. Right-aligned to the card so the menu hangs from under
      // the notch (which sits at the card's top-right). Toggle still fires from the
      // notch button so clicking the card body selects/closes as usual.
      align: at ? "left" : config.align || "right",
      positionAnchor: at || card || button,
      gap: 0,
      onClose: () => {
        if (menu) {
          menu = null;
        }
        button.setAttribute("aria-expanded", "false");
      },
    });
    // At the pointer near the bottom of the window: open upwards instead.
    if (opened && at && menu) {
      const height = menu.offsetHeight || 0;
      const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
      if (point.y + height > viewportH - 8) menu.style.top = `${Math.max(8, Math.round(point.y - height))}px`;
    }
    button.setAttribute("aria-expanded", opened ? "true" : "false");
    if (!opened) {
      menu = null;
    }
  };

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
  // (API 1.19) Right-click on a card in the KRC Portal opens the same menu at the pointer.
  // Only in the Portal: on the canvas a right-click belongs to LiteGraph / ComfyUI's node
  // menu. Shift+right-click keeps the browser's own menu.
  card?.addEventListener("contextmenu", (event) => {
    if (event.shiftKey || button.disabled || !card.closest(".krc-library-modal")) return;
    event.preventDefault();
    event.stopPropagation();
    open({ x: event.clientX, y: event.clientY });
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeExisting();
    }
  });
  button.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  if (asBool(opts.notchDisabled, false)) {
    button.disabled = true;
  }
  return button;
}
