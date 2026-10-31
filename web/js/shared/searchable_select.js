import { cancelFrame, scheduleFrame, stopCanvasEvents } from "./dom.js";
import { floatingPaletteId } from "./node_palette.js";
import { closeFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";

// Searchable single-select dropdown: a button showing the current value that
// opens a filterable, keyboard-navigable option list. Extracted verbatim from
// the LoRA Loadout preset picker so WordBank (and any future node) shares one
// styled control instead of a barebones native <select>. Markup uses the shared
// `.krc-preset-*` classes defined in components.css.
//
//   options : [{ name, value, group?, muted? }]  — name is the visible label, value
//             the identity. Include any leading "none"/placeholder entry (value "")
//             yourself, matching the LoRA Loadout convention. `muted: true` renders the
//             option (and the button label while it is selected) de-emphasized — for a
//             neutral default like "--none--" — without disabling it. `badge` renders
//             a small trailing label without changing the selected value.
//   value   : currently-selected value.
//   onSelect(value) : called when the user picks an option (not on setValue).
//   optionMenu(item) : optional. [{label, danger?, run}] (or null) for that row; a row
//             with items gets a trailing "⋯" notch that opens them without selecting the
//             row (→ on the highlighted row does the same). The group pickers use it for
//             Rename / Ungroup / Delete.
//
// Returns { el, setOptions(options, value?), setValue(value), getValue() } and a
// live `.value` accessor so it can stand in for a native <select>'s `.value`.
export function createSearchableSelect({
  options = [],
  value = "",
  searchPlaceholder = "Search...",
  emptyText = "No results found.",
  placeholder = "-- none --",
  buttonTitle = "",
  ariaLabel = "",
  fixedMenu = false,
  menuWidth = 300,
  menuClass = "",
  onSelect,
  optionMenu = null,
  optionMenuTitle = "Actions",
} = {}) {
  let currentOptions = options.slice();
  let selectedValue = value;

  const picker = document.createElement("div");
  picker.className = "krc-preset-picker";
  const button = document.createElement("button");
  button.className = "krc-preset-search-button";
  button.type = "button";
  if (buttonTitle) button.title = buttonTitle;
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  if (ariaLabel) button.setAttribute("aria-label", ariaLabel);
  const label = document.createElement("span");
  label.className = "krc-preset-search-label";
  const arrow = document.createElement("span");
  arrow.className = "krc-preset-search-arrow";
  arrow.textContent = "⌄";
  button.append(label, arrow);

  const menu = document.createElement("div");
  menu.className = `krc-preset-menu${fixedMenu ? " is-fixed" : ""}`;
  if (menuClass) menu.classList.add(...String(menuClass).split(/\s+/).filter(Boolean));
  if (fixedMenu) menu.classList.add("is-portal-menu");
  menu.hidden = true;
  const search = document.createElement("input");
  search.className = "krc-preset-search-input";
  search.type = "search";
  search.placeholder = searchPlaceholder;
  search.autocomplete = "off";
  const list = document.createElement("div");
  list.className = "krc-preset-option-list";
  list.setAttribute("role", "listbox");
  menu.append(search, list);

  let filtered = currentOptions;
  let activeIndex = Math.max(0, currentOptions.findIndex((item) => item.value === selectedValue));
  let onDocumentClick = null;
  let onWindowLayout = null;
  const frames = {};

  // Found option → its label; unknown but truthy value → the value itself (e.g.
  // a preset since deleted); otherwise the placeholder. Mirrors the LoRA Loadout picker.
  const appendOptionLabel = (parent, item, { fallback = "" } = {}) => {
    const text = item ? item.name : fallback;
    const main = document.createElement("span");
    main.className = "krc-preset-option-main";
    main.textContent = text;
    parent.appendChild(main);
    if (item?.badge) {
      const badge = document.createElement("span");
      badge.className = "krc-preset-option-badge";
      badge.textContent = item.badge;
      parent.appendChild(badge);
    }
  };

  const syncLabel = () => {
    const found = currentOptions.find((item) => item.value === selectedValue);
    label.replaceChildren();
    appendOptionLabel(label, found || null, { fallback: selectedValue || placeholder });
    label.classList.toggle("is-muted", Boolean(found && found.muted));
  };

  const close = () => {
    if (menu.querySelector('.krc-preset-option-notch[aria-expanded="true"]')) closeFloatingMenu();
    menu.hidden = true;
    picker.classList.remove("is-open");
    button.setAttribute("aria-expanded", "false");
    cancelFrame(frames, "focus");
    if (onDocumentClick) {
      document.removeEventListener("click", onDocumentClick);
      onDocumentClick = null;
    }
    if (onWindowLayout) {
      window.removeEventListener("resize", onWindowLayout);
      window.removeEventListener("scroll", onWindowLayout, true);
      onWindowLayout = null;
    }
    if (fixedMenu && menu.parentElement === document.body) {
      picker.appendChild(menu);
    }
  };

  const selectOption = (value) => {
    selectedValue = value;
    syncLabel();
    close();
    onSelect?.(value);
  };

  const setActiveOption = (index) => {
    if (!filtered.length) {
      activeIndex = 0;
      return;
    }
    const nextIndex = Math.max(0, Math.min(index, filtered.length - 1));
    if (nextIndex === activeIndex) {
      return;
    }
    list.querySelector(".krc-preset-option.is-active")?.classList.remove("is-active");
    activeIndex = nextIndex;
    list.querySelector(`[data-option-index="${activeIndex}"]`)?.classList.add("is-active");
  };

  const groupedOptions = () => {
    const groups = [];
    let currentGroup = null;
    filtered.forEach((item, index) => {
      const group = item.group || "";
      if (group) {
        if (!currentGroup || currentGroup.name !== group) {
          currentGroup = { name: group, items: [] };
          groups.push(currentGroup);
        }
      } else {
        currentGroup = null;
        groups.push({ name: "", items: [] });
        currentGroup = groups[groups.length - 1];
      }
      currentGroup.items.push({ item, index });
    });
    return groups;
  };

  const rowActions = (item) => {
    const actions = typeof optionMenu === "function" ? optionMenu(item) : null;
    return Array.isArray(actions) && actions.length ? actions : null;
  };

  // The row's action menu, under its notch. Picking an action closes the dropdown first.
  const openRowMenu = (notch, actions, { focus = false } = {}) => {
    if (notch.getAttribute("aria-expanded") === "true") {
      closeFloatingMenu(); // a second click on the notch closes its menu
      return;
    }
    const rowMenu = document.createElement("div");
    rowMenu.className = "krc-menu-select-menu krc-preset-row-menu";
    rowMenu.setAttribute("role", "menu");
    rowMenu.hidden = true;
    const items = actions.map((action) => {
      const entry = document.createElement("button");
      entry.type = "button";
      entry.className = `krc-menu-select-option${action.danger ? " is-danger" : ""}`;
      entry.setAttribute("role", "menuitem");
      entry.textContent = action.label;
      entry.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeFloatingMenu();
        close();
        action.run?.();
      });
      return entry;
    });
    rowMenu.addEventListener("keydown", (event) => {
      event.stopPropagation();
      const at = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        items[(at + step + items.length) % items.length]?.focus();
      } else if (event.key === "Escape" || event.key === "ArrowLeft") {
        event.preventDefault();
        closeFloatingMenu();
        search.focus();
      }
    });
    rowMenu.append(...items);
    const opened = toggleFloatingMenu(notch, rowMenu, {
      align: "right",
      onClose: () => notch.setAttribute("aria-expanded", "false"),
    });
    notch.setAttribute("aria-expanded", opened ? "true" : "false");
    if (opened && focus) items[0]?.focus();
  };

  const rowNotch = (item, actions) => {
    const notch = document.createElement("button");
    notch.type = "button";
    notch.className = "krc-preset-option-notch";
    notch.textContent = "⋯";
    notch.title = `${optionMenuTitle}: ${item.name}`;
    notch.setAttribute("aria-label", `${optionMenuTitle}: ${item.name}`);
    notch.setAttribute("aria-haspopup", "menu");
    notch.setAttribute("aria-expanded", "false");
    notch.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openRowMenu(notch, actions);
    });
    return notch;
  };

  const renderOptions = () => {
    list.innerHTML = "";
    if (!filtered.length) {
      const empty = document.createElement("div");
      empty.className = "krc-preset-empty";
      empty.textContent = emptyText;
      list.append(empty);
      return;
    }
    activeIndex = Math.max(0, Math.min(activeIndex, filtered.length - 1));
    const fragment = document.createDocumentFragment();
    groupedOptions().forEach((group) => {
      if (group.name) {
        const header = document.createElement("div");
        header.className = "krc-preset-option-group";
        header.textContent = `${group.name}:`;
        fragment.append(header);
      }
      group.items.forEach(({ item, index }) => {
        const actions = rowActions(item);
        // A row with a notch can't be a <button> (no button inside a button).
        const option = document.createElement(actions ? "div" : "button");
        option.className = `krc-preset-option ${item.value === selectedValue ? "is-selected" : ""} ${index === activeIndex ? "is-active" : ""}`;
        if (item.group) option.classList.add("is-grouped");
        if (item.muted) option.classList.add("is-muted");
        if (actions) option.classList.add("has-menu");
        else option.type = "button";
        appendOptionLabel(option, item);
        if (actions) option.append(rowNotch(item, actions));
        option.dataset.optionIndex = String(index);
        option.setAttribute("role", "option");
        option.setAttribute("aria-selected", item.value === selectedValue ? "true" : "false");
        option.addEventListener("mouseenter", () => {
          setActiveOption(index);
        });
        option.addEventListener("click", () => selectOption(item.value));
        fragment.append(option);
      });
    });
    list.append(fragment);
  };

  const filterOptions = () => {
    const query = search.value.trim().toLowerCase();
    filtered = query
      ? currentOptions.filter((item) => `${item.name} ${item.badge || ""} ${item.value || ""} ${item.group || ""}`.toLowerCase().includes(query))
      : currentOptions;
    activeIndex = Math.max(0, filtered.findIndex((item) => item.value === selectedValue));
    renderOptions();
  };

  const positionFixedMenu = () => {
    if (!fixedMenu || menu.hidden || !picker.isConnected) {
      return;
    }
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const targetWidth = Math.max(rect.width, Number(menuWidth) || 300);
    const width = Math.min(targetWidth, viewportWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    const top = Math.min(rect.bottom + gap, Math.max(margin, viewportHeight - margin));
    const available = Math.max(96, viewportHeight - top - margin);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    menu.style.width = `${width}px`;
    menu.style.minWidth = `${width}px`;
    list.style.maxHeight = `${Math.max(64, available - 39)}px`;
  };

  // A fixed (portal) menu is reparented to <body>, so it no longer inherits the
  // data-krc-theme of the modal/node it belongs to and would fall back to the
  // global palette. Copy the palette from the picker's nearest themed ancestor
  // so the dropdown matches its surroundings. Native maps to Gray because the
  // menu floats over the page rather than over the node's canvas color.
  const syncMenuTheme = () => {
    if (!fixedMenu) return;
    const themeId = floatingPaletteId(picker.closest("[data-krc-theme]")?.dataset?.krcTheme || "");
    if (themeId) menu.dataset.krcTheme = themeId;
    else delete menu.dataset.krcTheme;
  };

  const open = () => {
    if (fixedMenu && menu.parentElement !== document.body) {
      document.body.appendChild(menu);
    }
    syncMenuTheme();
    menu.hidden = false;
    picker.classList.add("is-open");
    button.setAttribute("aria-expanded", "true");
    search.value = "";
    filtered = currentOptions;
    activeIndex = Math.max(0, currentOptions.findIndex((item) => item.value === selectedValue));
    renderOptions();
    positionFixedMenu();
    scheduleFrame(frames, "focus", () => {
      if (!menu.hidden && picker.isConnected) {
        search.focus();
      }
    });
    onDocumentClick = (event) => {
      if (!picker.contains(event.target) && !menu.contains(event.target)) close();
    };
    document.addEventListener("click", onDocumentClick);
    if (fixedMenu) {
      onWindowLayout = () => positionFixedMenu();
      window.addEventListener("resize", onWindowLayout);
      window.addEventListener("scroll", onWindowLayout, true);
    }
  };

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (menu.hidden) open();
    else close();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });
  search.addEventListener("input", filterOptions);
  search.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveOption(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveOption(activeIndex - 1);
    } else if (event.key === "ArrowRight" && search.selectionStart === search.value.length) {
      // → on a row with a notch opens its actions (else the caret moves, as usual).
      const notch = list.querySelector(`[data-option-index="${activeIndex}"] .krc-preset-option-notch`);
      if (notch && rowActions(filtered[activeIndex])) {
        event.preventDefault();
        openRowMenu(notch, rowActions(filtered[activeIndex]), { focus: true });
      }
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = filtered[activeIndex];
      if (option) selectOption(option.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
      button.focus();
    }
  });

  picker.append(button, menu);
  stopCanvasEvents(picker);
  syncLabel();

  const api = {
    el: picker,
    getValue: () => selectedValue,
    setValue: (val) => {
      selectedValue = val ?? "";
      syncLabel();
    },
    setOptions: (opts, val) => {
      currentOptions = (opts || []).slice();
      if (val !== undefined) selectedValue = val ?? "";
      filtered = currentOptions;
      syncLabel();
    },
  };
  // Stand in for a native <select>'s `.value` so callers can read/write it the
  // same way; the setter never fires onSelect (matching a native assignment).
  Object.defineProperty(api, "value", {
    get: () => selectedValue,
    set: (val) => api.setValue(val),
  });
  return api;
}
