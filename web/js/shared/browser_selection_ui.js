// Shared selection presentation. Providers supply capabilities and mutation adapters.
import { el, stopCanvasEvents } from "./dom.js";
import { buildCardContextMenu } from "./card_context_menu.js";
import { closeFloatingMenu, hasFloatingMenu, toggleFloatingMenu } from "./floating_menu.js";
import { createSelectionController } from "./selection_controller.js";
import { bulkAttributeState, executeBulkAttribute } from "./bulk_attributes.js";
import { showToast } from "./toast.js";

const mountedSelections = new WeakMap();
function surfaces(root) {
  return [...(root?.classList?.contains("krc-selection-surface") ? [root] : []), ...(root?.querySelectorAll(".krc-selection-surface") || [])];
}

export function endBrowserSelections(root, reason = "portal-tab") {
  for (const panel of surfaces(root)) mountedSelections.get(panel)?.controller.exit(reason);
}

export function handleBrowserSelectionEscape(root, event) {
  for (const panel of surfaces(root)) {
    if (mountedSelections.get(panel)?.escape()) {
      event.preventDefault(); event.stopPropagation(); return true;
    }
  }
  return false;
}

export function createBrowserSelectionUI({ items, keyOf, cardKeyOf = keyOf, focusedKey = () => null, allItems = items, scope, filters, actions = () => [], isFiltered = () => false, attributes = null, notify = showToast }) {
  let panel = null;
  let observer = null;
  let menu = null;
  let activityRoot = null;
  let syncing = false;
  let entrySource = null;
  let entrySourceLength = -1;
  let entryRows = [];
  let cardsByKey = new Map();
  const controller = createSelectionController({ items, keyOf, allItems, scope, filters });
  const button = el("button", "krc-icon-button krc-browser-selection-button", { type: "button" });
  button.innerHTML = '<svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="3"/><path d="m6 10 3 3 5-6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  stopCanvasEvents(button);

  const entries = () => {
    const source = items() || [];
    if (source !== entrySource || source.length !== entrySourceLength) {
      entrySource = source;
      entrySourceLength = source.length;
      entryRows = source.filter((item) => !item.__draft && keyOf(item) != null);
      cardsByKey = new Map(entryRows.map((item) => [String(cardKeyOf(item)), item]));
    }
    return entryRows;
  };
  const closeMenu = () => {
    if (menu) closeFloatingMenu();
    menu = null;
    button.setAttribute("aria-expanded", "false");
  };

  function sync() {
    if (syncing) return;
    syncing = true;
    try {
      controller.refresh({ invalidate: false });
      const { active, busy, count } = controller.status();
      panel?.classList.toggle("is-selecting-cards", active);
      button.classList.toggle("is-active", active);
      button.classList.toggle("is-selection-ready", active && count > 0);
      button.setAttribute("aria-pressed", String(active));
      button.title = !active ? "Select cards" : count ? `Selection options (${count} selected)` : "Selection options";
      button.setAttribute("aria-label", button.title);
      button.disabled = busy;
      if (!active || !panel) return;
      entries();
      for (const card of panel.querySelectorAll(".krc-lora-list .krc-lora-card[data-krc-selection-key]")) {
        const item = cardsByKey.get(card.dataset.krcSelectionKey);
        if (!item) continue;
        let toggle = card.querySelector(":scope > .krc-card-selection-toggle");
        if (!toggle) {
          toggle = el("button", "krc-card-selection-toggle", { type: "button", draggable: false });
          toggle.setAttribute("role", "checkbox");
          stopCanvasEvents(toggle);
          toggle.addEventListener("dragstart", (event) => { event.preventDefault(); event.stopPropagation(); });
          card.append(toggle);
        }
        const checked = controller.has(keyOf(item));
        toggle.disabled = busy;
        const glyph = checked ? "✓" : "";
        if (toggle.textContent !== glyph) toggle.textContent = glyph;
        toggle.setAttribute("aria-checked", String(checked));
        toggle.title = `${checked ? "Deselect" : "Select"} ${item.display_name || item.name || item.title || "card"}`;
        toggle.setAttribute("aria-label", toggle.title);
      }
    } finally { syncing = false; }
  }

  // Capture before provider card handlers: selection must not also focus, load or
  // open a card. Thumbnail gestures and explicit card controls retain their behavior.
  let draggedCard = null;
  const cardFrom = event => {
    const target = event.target?.closest ? event.target : event.target?.parentElement;
    const card = target?.closest(".krc-lora-card");
    if (!card || !panel?.contains(card) || !card.closest(".krc-lora-list") || !card.dataset.krcSelectionKey) return null;
    return { card, target };
  };
  const cardClick = event => {
    if (event.button != null && event.button !== 0) return;
    const hit = cardFrom(event);
    if (!hit) return;
    const { card, target } = hit;
    const checkbox = target.closest(".krc-card-selection-toggle");
    if (!checkbox && (target.closest(".krc-card-thumbnail")
      || target.closest('button, a, input, textarea, select, [contenteditable], [role="button"], [role="checkbox"]'))) return;
    const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "";
    const mac = /mac|iphone|ipad/i.test(platform);
    const shortcut = event.shiftKey || (mac ? event.metaKey : event.ctrlKey);
    const { active } = controller.status();
    if (!active && !(shortcut && panel.closest(".krc-library-modal"))) return;
    entries();
    const item = cardsByKey.get(card.dataset.krcSelectionKey);
    if (!item) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === "dblclick" || controller.status().busy || draggedCard === card) return;
    if (!active) {
      // Resolve focus against all current results, including virtualized/offscreen
      // cards. cardKeyOf may differ from the membership ID (Prompt Vault).
      const anchor = event.shiftKey ? cardsByKey.get(String(focusedKey() ?? "")) : null;
      controller.enter();
      if (anchor) controller.toggle(String(keyOf(anchor)));
    }
    controller.toggle(String(keyOf(item)), { range: event.shiftKey });
    closeMenu();
  };
  const resetDrag = () => { draggedCard = null; };
  const cardDrag = event => { draggedCard = cardFrom(event)?.card || null; };
  function removeCardInteraction(root) {
    root?.removeEventListener("click", cardClick, true);
    root?.removeEventListener("dblclick", cardClick, true);
    root?.removeEventListener("pointerdown", resetDrag, true);
    root?.removeEventListener("dragstart", cardDrag, true);
    draggedCard = null;
  }

  function done() {
    closeMenu();
    controller.exit();
  }

  function openMenu() {
    controller.refresh();
    const { active, count, busy } = controller.status();
    if (!active || busy) return;
    controller.touch();
    const rows = entries();
    const chosen = controller.selectedItems();
    const quickActions = {};
    const modes = {};
    const mixedLabels = [];
    const apply = async (field, value) => {
      closeMenu();
      const result = await executeBulkAttribute(controller, attributes, field, value);
      notify(result.ok ? `${result.updated || 0} updated · ${result.skipped || 0} already matched` : result.error);
      if (!result.ok) openMenu();
      return false;
    };
    if (count) {
      for (const [kind, field, label] of [["color", "cardColor", "Card color"], ["customBadge", "customBadge", "Custom badge"], ["favorite", "favorite", "Favorite"], ["pin", "pinned", "Pin"], ["nsfw", "nsfw", "NSFW tag"]]) {
        if (!attributes) { quickActions[kind] = { disabled: true, title: `${label} (preview)` }; continue; }
        const state = bulkAttributeState(chosen, attributes.read, field);
        if (state.mixed) mixedLabels.push(label);
        const action = { value: state.mixed ? "" : state.value, active: !state.mixed && Boolean(state.value), mixed: state.mixed,
          hasValue: state.any, title: `${label}${state.mixed ? " (mixed)" : ""}`, onChange: (value) => apply(field, value), onSave: (value) => apply(field, value) };
        quickActions[kind] = action;
        if (["favorite", "pin", "nsfw"].includes(kind)) {
          action.mode = `bulk-${kind}`;
          modes[action.mode] = (_config, _context, setMode) => {
            const wrap = el("div", "krc-card-menu-bulk-values");
            const back = el("button", "krc-card-menu-mode-back", { type: "button", textContent: "‹", title: "Back" });
            back.addEventListener("click", () => setMode("quick"));
            wrap.append(back, el("div", "krc-selection-summary", { textContent: `${label}: ${state.mixed ? "Mixed" : state.value ? "Set" : "Clear"}` }));
            const labels = kind === "favorite" ? ["Favorite selected", "Unfavorite selected"] : kind === "pin" ? ["Pin selected", "Unpin selected"] : ["Tag selected as NSFW", "Clear NSFW tag"];
            for (const [index, value] of [true, false].entries()) {
              const disabled = kind === "pin" && value && count > 5;
              const option = el("button", "krc-card-menu-item", { type: "button", textContent: labels[index], disabled,
                title: disabled ? "Pinning is limited to 5 selected cards; unpinning remains available" : labels[index] });
              option.addEventListener("click", () => { if (!option.disabled) return apply(field, value); });
              wrap.append(option);
            }
            return wrap;
          };
        }
      }
    }
    const providerActions = count ? actions(chosen).map((action) => {
      const applicable = action.eligible ? chosen.filter(action.eligible).length : null;
      const supported = Boolean(action.operation);
      return { ...action, label: applicable === null ? action.label : `${action.label} (${applicable})`,
        disabled: !supported || applicable === 0 || Boolean(action.disabled), title: supported ? action.title || action.label : `${action.label} (preview)`,
        onClick: async () => {
          closeMenu();
          try {
            const { openSelectionOperation } = await import("./selection_operations.js");
            openSelectionOperation({ controller, operation: action.operation });
          } catch (error) { notify(String(error?.message || error)); }
          return false;
        },
      };
    }) : [];
    const allLabel = `${isFiltered() ? "Select all matching" : "Select all"} (${rows.length})`;
    closeMenu();
    menu = buildCardContextMenu({
      quickActions,
      modes,
      actions: [
        ...providerActions,
        ...(providerActions.length ? [{ kind: "separator" }] : []),
        { id: "select-all", label: allLabel, disabled: !rows.length, onClick: () => controller.selectAll() },
        ...(count ? [{ id: "clear-selection", label: "Clear selection", onClick: () => controller.clear() }] : []),
        { id: "selection-done", label: "Done", onClick: done },
      ],
    });
    menu.classList.add("krc-browser-selection-menu");
    menu.prepend(el("div", "krc-selection-summary", { textContent: `${count} selected`, role: "status" }));
    if (mixedLabels.length) menu.append(el("div", "krc-selection-preview-note", { textContent: `Mixed: ${mixedLabels.join(", ")}` }));
    if (providerActions.some((action) => action.disabled)) menu.append(el("div", "krc-selection-preview-note", { textContent: "Disabled provider actions are not wired yet." }));
    installActivity(menu);
    toggleFloatingMenu(button, menu, { align: "right", onClose: () => { menu = null; button.setAttribute("aria-expanded", "false"); } });
    button.setAttribute("aria-expanded", "true");
  }

  button.addEventListener("click", () => {
    if (!controller.status().active) controller.enter();
    else openMenu();
  });
  function escape() {
    if (!controller.status().active) return false;
    if (controller.status().busy) return true;
    if (hasFloatingMenu()) closeFloatingMenu(); else done();
    controller.touch();
    return true;
  }
  const activity = () => controller.touch();
  const keydown = (event) => {
    if (event.key === "Escape" && escape()) { event.preventDefault(); event.stopPropagation(); }
  };
  function installActivity(root) {
    for (const type of ["pointerdown", "keydown", "input", "wheel"]) root.addEventListener(type, activity, true);
    root.addEventListener("keydown", keydown, true);
  }
  function removeActivity(root) {
    if (!root) return;
    for (const type of ["pointerdown", "keydown", "input", "wheel"]) root.removeEventListener(type, activity, true);
    root.removeEventListener("keydown", keydown, true);
  }
  const unsubscribe = controller.subscribe(() => { if (!controller.status().active) closeMenu(); sync(); });
  sync();

  const ui = {
    button, controller, escape,
    refresh() { entrySource = null; controller.refresh(); sync(); },
    endForEdit: controller.endForEdit,
    remap(oldId, newId) { entrySource = null; controller.remap(oldId, newId); },
    remapIds(resolve) { entrySource = null; controller.remapIds(resolve); },
    mount(nextPanel, { after = null } = {}) {
      closeMenu();
      observer?.disconnect();
      removeActivity(activityRoot);
      removeCardInteraction(panel);
      if (panel) mountedSelections.delete(panel);
      panel?.classList.remove("is-selecting-cards");
      panel = nextPanel;
      panel.classList.add("krc-selection-surface");
      mountedSelections.set(panel, ui);
      panel.addEventListener("click", cardClick, true);
      panel.addEventListener("dblclick", cardClick, true);
      panel.addEventListener("pointerdown", resetDrag, true);
      panel.addEventListener("dragstart", cardDrag, true);
      activityRoot = panel.closest(".krc-node") || panel;
      installActivity(activityRoot);
      const header = panel.querySelector(".krc-panel-header");
      const controls = header?.querySelector(".krc-browser-actions, .krc-header-controls");
      if (!controls) throw new Error("Selection UI requires a browser controls row");
      controls.classList.add("krc-selection-actions");
      button.classList.toggle("is-after-action", Boolean(after));
      if (after) after.after(button);
      else controls.append(button);
      observer = new MutationObserver(sync);
      // Some consumers replace the whole list while keeping the browser shell.
      observer.observe(panel, { childList: true, subtree: true });
      sync();
    },
    destroy() {
      done(); unsubscribe(); controller.destroy(); observer?.disconnect();
      removeActivity(activityRoot);
      removeCardInteraction(panel);
      if (panel) { mountedSelections.delete(panel); panel.classList.remove("krc-selection-surface", "is-selecting-cards"); }
      observer = null; panel = null; activityRoot = null;
    },
  };
  return ui;
}
