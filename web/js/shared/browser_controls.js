import { browserViewOptions } from "./browser_views.js";
import { createCardColorFilterButton } from "./card_color_button.js";
import { debounce } from "./dom.js";
import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";

function button(className, { title = "", textContent = "", active = false, disabled = false } = {}) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className + (active ? " is-active" : "");
  el.title = title;
  el.disabled = disabled;
  if (textContent) el.textContent = textContent;
  return el;
}

export function favoriteFilterButton({ active = false, title = "", onClick } = {}) {
  const el = button("krc-icon-button krc-favorite-filter-button", {
    active,
    title: title || (active ? "Showing favorites" : "Show favorites"),
    textContent: "★",
  });
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function nsfwFilterButton({ active = false, className = "krc-nsfw-button", title = "", onClick } = {}) {
  const el = button(`krc-icon-button ${className}`, {
    active,
    title: title || (active ? "Showing NSFW" : "Show NSFW"),
  });
  const glyph = document.createElement("span");
  glyph.className = "krc-nsfw-glyph";
  glyph.textContent = "⊘";
  el.append(glyph);
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function cardColorFilterButton({ value = "", title = "", onChange } = {}) {
  return createCardColorFilterButton({ value, title, onChange });
}

export function refreshButton({ title = "Refresh", textContent = "⟳", disabled = false, loading = false, onClick } = {}) {
  const el = button("krc-icon-button krc-refresh-button", { title, disabled: disabled || loading });
  const glyph = document.createElement("span");
  glyph.className = "krc-refresh-glyph";
  // Loading state shows a centered CSS ring spinner (see components.css) instead of a
  // spinning ⟳ character, which wobbles (a glyph rotates around its em-box, not its ink).
  // Driven two ways: the `loading` prop (for callers that re-render the button early,
  // e.g. LL's loadLibrary) and a self-managed spinner around the onClick promise (for
  // callers whose refresh keeps the button until the end, e.g. PV's reload).
  const setLoading = (on) => {
    el.classList.toggle("is-loading", on);
    glyph.textContent = on ? "" : textContent;
  };
  setLoading(loading);
  el.append(glyph);
  if (onClick) {
    el.addEventListener("click", async () => {
      if (el.disabled) return;
      el.disabled = true;
      setLoading(true);
      try {
        await onClick();
      } finally {
        if (el.isConnected) {
          setLoading(false);
          el.disabled = false;
        }
      }
    });
  }
  return el;
}

// Compact DOM dropdown that replaces the native <select> (header sort / name-mode
// controls, Options rows, the per-node palette picker, Word Bank Options). A small button shows the current label; clicking it
// opens a body-portaled option menu (shared/floating_menu.js) that inherits the
// node's palette — the same styling model as the card-color picker. Exposes a
// `.value` accessor so it can stand in for the old <select> element.
export function menuSelect({
  className = "",
  title = "",
  value = "",
  options = [],
  align = "left",
  stopEvents = null,
  onChange,
} = {}) {
  let current = value;

  const button = document.createElement("button");
  button.type = "button";
  button.className = `krc-menu-select${className ? ` ${className}` : ""}`;
  button.title = title;
  button.setAttribute("aria-haspopup", "listbox");
  const labelEl = document.createElement("span");
  labelEl.className = "krc-menu-select-label";
  const arrow = document.createElement("span");
  arrow.className = "krc-menu-select-arrow";
  arrow.textContent = "⌄";
  button.append(labelEl, arrow);

  const menu = document.createElement("div");
  menu.className = "krc-menu-select-menu";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");

  const optionEls = new Map();
  const syncLabel = () => {
    const found = options.find(([optValue]) => optValue === current);
    labelEl.textContent = found ? found[1] : current;
  };
  const syncSelected = () => {
    for (const [optValue, optEl] of optionEls) {
      optEl.classList.toggle("is-selected", optValue === current);
    }
  };

  const buildOptions = () => {
    optionEls.clear();
    menu.replaceChildren();
    for (const [optValue, optLabel] of options) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "krc-menu-select-option";
      option.textContent = optLabel;
      option.setAttribute("role", "option");
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        current = optValue;
        syncLabel();
        syncSelected();
        closeFloatingMenu();
        onChange?.(current, button);
      });
      optionEls.set(optValue, option);
      menu.append(option);
    }
  };
  buildOptions();

  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    syncSelected();
    // The open list is never narrower than its button.
    menu.style.minWidth = `${Math.round(button.getBoundingClientRect().width)}px`;
    toggleFloatingMenu(button, menu, { align });
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeFloatingMenu();
  });
  stopEvents?.(button);

  syncLabel();
  // Stand in for a native <select>'s `.value` (read/write without firing onChange).
  Object.defineProperty(button, "value", {
    get: () => current,
    set: (next) => {
      current = next ?? "";
      syncLabel();
      syncSelected();
    },
  });
  // The current option's label (a native <select>'s selectedOptions[0].textContent).
  Object.defineProperty(button, "selectedLabel", {
    get: () => options.find(([optValue]) => optValue === current)?.[1] ?? "",
  });
  // Replace the option list (a lazily filled select); keeps the value unless one is given.
  button.setOptions = (nextOptions = [], nextValue) => {
    options = nextOptions.slice();
    if (nextValue !== undefined) current = nextValue ?? "";
    buildOptions();
    syncLabel();
    syncSelected();
  };
  return button;
}

export function browserSearchControl({
  value = "",
  placeholder = "Search...",
  debounceMs = 120,
  stopEvents = null,
  onInput,
  onClear,
} = {}) {
  const wrap = document.createElement("div");
  wrap.className = "krc-search-wrap";
  const search = document.createElement("input");
  search.className = "krc-search";
  search.placeholder = placeholder;
  search.value = value;
  const clear = document.createElement("button");
  clear.className = "krc-search-clear";
  clear.type = "button";
  clear.title = "Clear search";
  // Wrap the × glyph so CSS can optically center it (U+00D7 renders ~2px low).
  const clearGlyph = document.createElement("span");
  clearGlyph.className = "krc-search-clear-glyph";
  clearGlyph.textContent = "×";
  clear.appendChild(clearGlyph);
  clear.hidden = !value;
  const runSearch = debounce((next) => {
    if (!wrap.isConnected) return;
    onInput?.(next, { search, clear });
  }, debounceMs);
  stopEvents?.(search);
  stopEvents?.(clear);
  search.addEventListener("input", (event) => {
    const next = event.target.value;
    clear.hidden = !next;
    runSearch(next);
  });
  clear.addEventListener("click", (event) => {
    event.stopPropagation();
    search.value = "";
    clear.hidden = true;
    runSearch.cancel();
    onClear?.({ search, clear });
    search.focus();
  });
  wrap.append(search, clear);
  return { wrap, search, clear };
}

export function favoriteActionButton({ active = false, title = "Favorite", disabled = false, className = "krc-favorite-button", onClick } = {}) {
  const el = button(className, { active, title, disabled, textContent: "★" });
  el.classList.toggle("is-on", active);
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function nsfwActionButton({ active = false, title = "Mark NSFW", disabled = false, className = "krc-favorite-button krc-nsfw-button", onClick } = {}) {
  const el = button(className, { active, title, disabled });
  el.classList.toggle("is-on", active);
  const glyph = document.createElement("span");
  glyph.className = "krc-nsfw-glyph";
  glyph.textContent = "⊘";
  el.append(glyph);
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function pinActionButton({ active = false, title = "Pin to top", disabled = false, className = "krc-favorite-button krc-pin-button", onClick } = {}) {
  const el = button(className, { active, title, disabled });
  el.classList.toggle("is-on", active);
  const glyph = document.createElement("span");
  glyph.className = "krc-pin-glyph";
  el.append(glyph);
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function switchToggle({ label = "", active = false, title = label, onClick } = {}) {
  const el = button("krc-switch-toggle", { active, title });
  el.classList.toggle("is-on", active);
  const text = document.createElement("span");
  text.className = "krc-switch-label";
  text.textContent = label;
  const track = document.createElement("span");
  track.className = "krc-switch-track";
  const knob = document.createElement("span");
  knob.className = "krc-switch-knob";
  track.append(knob);
  el.append(text, track);
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

export function browserViewToggle({ views, current, onChange } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "krc-view-toggle";
  for (const option of browserViewOptions(views || [])) {
    const el = button("krc-icon-button", {
      active: option.value === current,
      title: option.title,
    });
    const icon = document.createElement("span");
    icon.className = `krc-view-icon ${option.iconClass}`;
    el.append(icon);
    el.addEventListener("click", () => onChange?.(option.value));
    wrap.append(el);
  }
  return wrap;
}
