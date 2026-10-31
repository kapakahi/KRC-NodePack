// KRC Portal — the shared library browse modal: a viewport-anchored SINGLETON that hosts a
// detached KRC browser+info experience (model / prompt providers) in a floating
// portal, independent of any graph node. See the universal library modal plan.
//
// Layering: this module is provider-agnostic. Nodes register providers into it at
// load (registerLibraryProvider), and openers (LL mini, CS / toolbar) call
// openLibraryModal({ provider, scope, select, infoOpen, page, pick, resume }). Provider instances are built lazily and
// kept alive across opens (singleton), so reopening is instant and per-provider
// state (scroll, last selection) persists. With "Remember where I was" (Portal Options,
// default on) it also survives reloads: each mode's getState() is saved on close and when
// the page goes away, and handed back to restoreState() the first time the mode is shown
// after a reload; an opener's `resume` reopens the most recently shown of the tabs it
// names (the plain BROWSE: any tab), instead of its own provider / scope.
import { ensureStylesheet } from "./stylesheets.js";
import { portalPaletteId } from "./palettes.js";
import { readGlobalSetting } from "./global_settings.js";
import { PORTAL_THEME_SETTING_ID, PORTAL_THEME_DEFAULT } from "./settings.js";
import { krcModalSection } from "./modal.js";
import { el } from "./dom.js";
import { switchToggle } from "./browser_controls.js";
import { endBrowserSelections, handleBrowserSelectionEscape } from "./browser_selection_ui.js";

const STYLE_ID = "krc-library-modal-css";
const STYLE_VERSION = "27";
const PORTAL_NAME = "KRC Portal";
const UI_STORE_KEY = "krc-library-modal:ui";
const CLOSE_ON_OUTSIDE_DEFAULT = true;
const REMEMBER_DEFAULT = true;

// Fixed anchor: right of the CUI left vertical toolbar. Re-applied on EVERY open
// (predictable placement); the modal is draggable within a session but resets here.
const ANCHOR_LEFT = 60;
const ANCHOR_TOP = 55; // just under the workflow-tabs bar (bottom ~53px)

// id -> { id, label, order, hidden, create() -> providerInstance }. Switcher tabs sort by
// `order` (lower first), not registration order — that follows extension load order.
// A `hidden` mode has no tab (Home: the header's house button shows it).
const providers = new Map();

// The Home mode's id (model_library/home_provider.js registers it).
export const PORTAL_HOME_ID = "home";

function providerIds({ hidden = false } = {}) {
  return [...providers.values()]
    .filter((spec) => hidden || !spec.hidden)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99))
    .map((spec) => spec.id);
}

export function registerLibraryProvider(spec) {
  if (!spec?.id || typeof spec.create !== "function") {
    throw new Error("registerLibraryProvider requires { id, create() }");
  }
  providers.set(spec.id, spec);
}

function loadUi() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(UI_STORE_KEY) || "") || {};
  } catch {
    return {};
  }
}

function saveUi(ui) {
  try {
    globalThis.localStorage?.setItem(UI_STORE_KEY, JSON.stringify(ui));
  } catch {
    // storage unavailable — degrade to session-only
  }
}

class LibraryModal {
  constructor() {
    this.portal = null;
    this.head = null;
    this.body = null;
    this.toggleWrap = null;
    this.infoBtn = null;
    this.pickBtn = null;
    // Pick mode (the public Card API's pickCard): { label, onPick(item, providerId),
    // onCancel() }. The provider is locked and a "Use" button hands back the selection.
    this.pick = null;
    this.activeId = null;
    this.instances = new Map(); // id -> provider instance
    // infoDefault is the PERSISTED default a plain Browse open starts from;
    // infoOpen is the live display state (which an opener's intent, e.g. a card
    // Info menu, can override transiently without touching the default).
    this.infoDefault = !!loadUi().infoOpen; // sticky across opens (and reloads)
    this.infoOpen = this.infoDefault;
    // Click-outside-to-close: default on; an explicit stored choice wins.
    this.closeOnOutside = loadUi().closeOnOutside ?? CLOSE_ON_OUTSIDE_DEFAULT;
    // "Remember where I was": the tabs' last-shown times and each mode's saved state
    // (its own JSON), across reloads; `restored` = modes already given theirs this session.
    this.remember = loadUi().remember ?? REMEMBER_DEFAULT;
    const resumeStore = loadUi().resume;
    this.lastShown = { ...(resumeStore?.lastShown || {}) };
    this.savedStates = { ...(resumeStore?.states || {}) };
    this.restored = new Set();
    window.addEventListener("pagehide", () => this.saveStates());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.saveStates();
    });
    // The Portal's palette choice (KRC Portal ▸ Options ▸ Appearance ▸ Portal palette):
    // "" follows the global palette. One palette for the chrome and every provider.
    this.portalTheme = String(readGlobalSetting(PORTAL_THEME_SETTING_ID, PORTAL_THEME_DEFAULT) || "");
    this.keyHandler = null;
    this.outsideHandler = null;
    window.addEventListener("krc-portal-palette-changed", (event) => {
      this.portalTheme = String(event?.detail?.id || "");
      this.applyPortalPalette();
    });
    // Following the global palette: a switch to or from Native changes the Portal's.
    window.addEventListener("krc-global-palette-changed", () => this.applyPortalPalette());
  }

  ensurePortal() {
    if (this.portal) return;
    ensureStylesheet(STYLE_ID, "./library_modal.css", import.meta.url, { version: STYLE_VERSION });

    const portal = document.createElement("div");
    portal.className = "krc-library-modal";
    portal.hidden = true;

    const head = document.createElement("div");
    head.className = "krc-library-modal-head";

    const brand = document.createElement("span");
    brand.className = "krc-library-modal-brand";
    brand.textContent = PORTAL_NAME;

    const toggleWrap = document.createElement("div");
    toggleWrap.className = "krc-library-modal-toggle";

    const infoBtn = document.createElement("button");
    infoBtn.type = "button";
    infoBtn.className = "krc-library-modal-info-btn";
    infoBtn.textContent = "Info";
    infoBtn.title = "Show / hide the info panel";
    infoBtn.addEventListener("click", () => this.toggleInfo());

    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "krc-library-modal-pick-btn";
    pickBtn.hidden = true;
    pickBtn.addEventListener("click", () => this.finishPick());

    const close = document.createElement("button");
    close.type = "button";
    close.className = "krc-library-modal-close";
    close.textContent = "✕";
    close.title = "Close";
    close.addEventListener("click", () => this.close());

    // The tabs (Home first) on the left, the name centred (hidden while the Portal is just
    // the browser), Use / Info / close on the right.
    head.append(toggleWrap, brand, pickBtn, infoBtn, close);
    this.installDrag(head, portal);

    const body = document.createElement("div");
    body.className = "krc-library-modal-body";
    // Double-clicking an item card (models or prompts) reveals a closed info panel;
    // the first click already selected it. Capture phase: cards stop dblclick from
    // bubbling (stopCanvasEvents). Only item cards count (a model's data-lora-sha, a
    // prompt's data-pm-key) — not home-menu shortcuts or skeletons. Transient, like
    // the card Info menu (the persisted default is untouched).
    // In pick mode a double-click uses the card instead (after the provider's own
    // click handler has selected it).
    body.addEventListener("dblclick", (event) => {
      const card = event.target?.closest?.(".krc-lora-card");
      if (!card || !(card.dataset.loraSha || card.dataset.pmKey || card.dataset.krcCardKey)) return;
      if (this.pick) {
        requestAnimationFrame(() => this.finishPick());
        return;
      }
      if (this.infoOpen) return;
      this.setInfoOpen(true);
    }, true);

    portal.append(head, body);
    document.body.append(portal);

    this.portal = portal;
    this.head = head;
    this.body = body;
    this.toggleWrap = toggleWrap;
    this.infoBtn = infoBtn;
    this.pickBtn = pickBtn;
    this.applyPortalPalette();
  }

  providerInstance(id) {
    if (this.instances.has(id)) return this.instances.get(id);
    const spec = providers.get(id);
    if (!spec) return null;
    const inst = spec.create();
    this.instances.set(id, inst);
    // A freshly built provider adopts the Portal palette so every panel shares one
    // theme (its stub node starts fresh each session; the choice is a global setting).
    inst.setPalette?.(portalPaletteId(this.portalTheme));
    return inst;
  }

  renderToggle() {
    if (!this.toggleWrap) return;
    this.toggleWrap.replaceChildren();
    const ids = providerIds();
    // A single provider needs no switch — show only its label. Pick mode is locked to
    // the provider the picker asked for.
    if (!this.pick && providers.has(PORTAL_HOME_ID)) this.toggleWrap.append(this.homeButton());
    if (ids.length < 2 || this.pick) {
      const label = document.createElement("span");
      label.className = "krc-library-modal-title";
      label.textContent = providers.get(this.activeId)?.label || "Library";
      this.toggleWrap.append(label);
      return;
    }
    for (const id of ids) {
      const spec = providers.get(id);
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = `krc-library-modal-tab${id === this.activeId ? " is-active" : ""}`;
      tab.textContent = spec.label || id;
      tab.addEventListener("click", () => this.setProvider(id));
      this.toggleWrap.append(tab);
    }
  }

  setProvider(id, scope, intent = {}) {
    if (this.activeId && this.activeId !== id && providers.has(id)) endBrowserSelections(this.body);
    const inst = this.providerInstance(id);
    if (!inst) return;
    this.activeId = id;
    const root = inst.getRoot();
    if (this.body.firstChild !== root) this.body.replaceChildren(root);
    // A resumed tab keeps its own folder / page (the opener's scope is only the fallback).
    if (scope !== undefined && !intent.resumed) inst.applyScope?.(scope);
    inst.onShow?.();
    // The first show after a reload: what this mode remembered (not when the opener asked
    // for a specific item or page, nor in pick mode).
    let restoring = Promise.resolve();
    if (this.remember && !this.restored.has(id)) {
      this.restored.add(id);
      const state = this.savedStates[id];
      if (state && intent.select === undefined && !intent.page && !this.pick && typeof inst.restoreState === "function") {
        restoring = Promise.resolve().then(() => inst.restoreState(state)).catch((error) => {
          console.warn("[KRC Library] restoring the provider's state failed", error);
        });
      }
    }
    // A resume with a flavour (LoRA Loadout's "the last LoRA"): the mode puts it back, or
    // says it has none and the opener's scope applies.
    if (intent.resumeAs) {
      restoring.then(() => inst.resume?.(intent.resumeAs)).then((done) => {
        if (!done && scope !== undefined) inst.applyScope?.(scope);
      }).catch((error) => console.warn("[KRC Library] provider resume failed", error));
    }
    if (!this.pick) this.markShown(id);
    if (intent.select !== undefined) {
      Promise.resolve(inst.select?.(intent.select)).catch((error) => {
        console.warn("[KRC Library] provider selection failed", error);
      });
    }
    // Opener intent: land on one of the provider's Info Panel pages (e.g. "transfer").
    if (intent.page) inst.openPage?.(intent.page);
    this.renderToggle();
  }

  // The ONE palette for the whole Portal: the chrome and every provider panel (stored on
  // its stub node, so it survives re-renders and its dialogs and menus match). Never
  // Native: following a Native global palette gives KRC Gray (portalPaletteId), since
  // the Portal floats over the page with no node colour behind it.
  applyPortalPalette() {
    const id = portalPaletteId(this.portalTheme);
    if (this.portal) {
      if (id) this.portal.dataset.krcTheme = id;
      else delete this.portal.dataset.krcTheme;
    }
    for (const inst of this.instances.values()) inst.setPalette?.(id);
  }

  // The Portal's behavior settings, as a section of the global Options page. Its palette
  // is an Appearance row there (PORTAL_THEME_SETTING_ID).
  buildBehaviorSection(section = krcModalSection) {
    // Same row markup as the Options page's own settings (label + KRC switch).
    const switchRow = (label, active, onChange) => {
      const toggle = switchToggle({
        active,
        title: label,
        onClick: () => {
          const next = !toggle.classList.contains("is-on");
          toggle.classList.toggle("is-on", next);
          onChange(next);
        },
      });
      const row = el("div", "krc-setting-row");
      const head = el("div", "krc-setting-head");
      head.append(el("span", "krc-setting-label", { textContent: label }), toggle);
      row.append(head);
      return row;
    };
    const infoField = switchRow("Open info panel by default (Browse)", this.infoDefault, (value) => this.setInfoDefault(value));
    const outsideField = switchRow("Click outside closes portal", this.closeOnOutside, (value) => this.setCloseOnOutside(value));
    const rememberField = switchRow("Remember where I was", this.remember, (value) => this.setRemember(value));
    rememberField.title = "Reopen the last tab, item and page (also after a reload). BROWSE opens the last view; "
      + "Config Switcher the last model or prompt; LoRA Loadout the last LoRA.";

    return section({ title: PORTAL_NAME, body: [infoField, outsideField, rememberField] });
  }

  // ---- Home ------------------------------------------------------------------------------
  // The header's house: the Home mode (the KRC menu cards and the Home page), from any tab.
  homeButton() {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `krc-library-modal-home${this.activeId === PORTAL_HOME_ID ? " is-active" : ""}`;
    button.title = "KRC home";
    button.setAttribute("aria-label", "KRC home");
    const glyph = document.createElement("span");
    glyph.className = "krc-portal-house-glyph";
    button.append(glyph);
    button.addEventListener("click", () => this.setProvider(PORTAL_HOME_ID));
    return button;
  }

  applyInfoState() {
    this.portal.classList.toggle("is-info-open", this.infoOpen);
    this.infoBtn?.classList.toggle("is-active", this.infoOpen);
  }

  // Header Info button: toggle the live panel AND remember it as the default a
  // plain Browse open starts from (the persistence behavior we keep).
  toggleInfo() {
    this.infoOpen = !this.infoOpen;
    this.applyInfoState();
    this.infoDefault = this.infoOpen;
    const ui = loadUi();
    ui.infoOpen = this.infoDefault;
    saveUi(ui);
  }

  position() {
    this.portal.style.left = `${ANCHOR_LEFT}px`;
    this.portal.style.top = `${ANCHOR_TOP}px`;
  }

  // Transient live state — used by opener intent (e.g. a card Info menu opens
  // with the panel shown). Never persisted, so it does not change the Browse
  // default.
  setInfoOpen(value) {
    this.infoOpen = Boolean(value);
    this.applyInfoState();
  }

  // The persisted default a plain Browse open starts from (the Options
  // checkbox). Persist only — does not yank the currently shown panel.
  setInfoDefault(value) {
    this.infoDefault = Boolean(value);
    const ui = loadUi();
    ui.infoOpen = this.infoDefault;
    saveUi(ui);
  }

  setCloseOnOutside(value) {
    this.closeOnOutside = Boolean(value);
    const ui = loadUi();
    ui.closeOnOutside = this.closeOnOutside;
    saveUi(ui);
    // Reflect the change immediately for an already-open portal.
    if (this.portal && !this.portal.hidden) {
      if (this.closeOnOutside) this.installOutside();
      else this.removeOutside();
    }
  }

  // ---- "Remember where I was" ----------------------------------------------------------
  markShown(id) {
    this.lastShown[id] = Date.now();
    this.persistResume();
  }

  // Every built mode's state (getState() -> its own JSON), saved for the next reload.
  saveStates() {
    if (!this.remember) return;
    for (const [id, inst] of this.instances) {
      if (typeof inst.getState !== "function") continue;
      try {
        const state = inst.getState();
        if (state) this.savedStates[id] = state;
        else delete this.savedStates[id];
      } catch (error) {
        console.warn("[KRC Library] reading the provider's state failed", error);
      }
    }
    this.persistResume();
  }

  persistResume() {
    const ui = loadUi();
    if (this.remember) ui.resume = { lastShown: this.lastShown, states: this.savedStates };
    else delete ui.resume;
    saveUi(ui);
  }

  setRemember(value) {
    this.remember = Boolean(value);
    const ui = loadUi();
    ui.remember = this.remember;
    saveUi(ui);
    if (!this.remember) {
      // Off: forget what was remembered (openers behave as before).
      this.lastShown = {};
      this.savedStates = {};
    } else {
      for (const id of this.instances.keys()) this.restored.add(id);   // live modes already hold their state
      if (this.activeId) this.lastShown[this.activeId] = Date.now();
    }
    this.persistResume();
  }

  // The tab a `resume` opens: the most recently shown of the tabs it names ("any" / true =
  // every tab), or null (then the opener's own provider / scope / select apply).
  resumeTarget(resume) {
    if (!resume || !this.remember) return null;
    const named = resume.tabs === "any" || resume.tabs === true || !resume.tabs ? providerIds({ hidden: true }) : resume.tabs;
    return named.filter((id) => providers.has(id) && this.lastShown[id])
      .sort((a, b) => this.lastShown[b] - this.lastShown[a])[0] || null;
  }

  open({ provider = "models", scope, select, infoOpen, page, pick, resume } = {}) {
    this.ensurePortal();
    // A new open replaces any pick in progress (that picker gets a cancel).
    this.cancelPick();
    this.pick = pick && typeof pick.onPick === "function" ? pick : null;
    this.pickBtn.hidden = !this.pick;
    this.pickBtn.textContent = this.pick?.label || "Use";
    this.pickBtn.title = this.pick?.title || "Use the selected card";
    const resumed = this.pick ? null : this.resumeTarget(resume);
    const target = resumed || (providers.has(provider) ? provider : providerIds()[0]);
    if (!target) {
      console.warn("[KRC Library] no providers registered");
      return;
    }
    if (infoOpen !== undefined) {
      this.setInfoOpen(infoOpen); // opener intent (e.g. card Info menu) — transient
    } else {
      this.setInfoOpen(this.infoDefault); // plain Browse → the persisted default
    }
    // Resumed: the tab as it was (the opener's scope only if the mode has nothing for
    // resume.as); otherwise the opener's own intent. Also mirrors the panel's theme.
    if (resumed) this.setProvider(target, scope, { resumed: true, resumeAs: resume?.as || "" });
    else this.setProvider(target, scope, { select, page });
    this.position();
    const wasHidden = this.portal.hidden;
    this.portal.hidden = false;
    this.installKey();
    if (this.closeOnOutside) this.installOutside();
    if (wasHidden) announceVisibility(true);
  }

  close() {
    if (!this.portal || this.portal.hidden) return;
    endBrowserSelections(this.body, "portal-close");
    this.saveStates();
    this.portal.hidden = true;
    this.removeKey();
    this.removeOutside();
    this.cancelPick();
    announceVisibility(false);
  }

  // Hand the active provider's selection to the picker. onPick returning false keeps
  // the Portal open (e.g. a card from the wrong folder). The pick is cleared BEFORE
  // close() so closing doesn't also cancel it.
  finishPick() {
    const pick = this.pick;
    if (!pick) return;
    const item = this.providerInstance(this.activeId)?.getSelection?.() || null;
    if (!item) return;
    let accepted = true;
    try {
      accepted = pick.onPick(item, this.activeId) !== false;
    } catch (error) {
      console.warn("[KRC Library] pick handler failed", error);
    }
    if (!accepted) return;
    this.pick = null;
    this.close();
  }

  cancelPick() {
    const pick = this.pick;
    this.pick = null;
    if (this.pickBtn) this.pickBtn.hidden = true;
    if (!pick) return;
    try {
      pick.onCancel?.();
    } catch (error) {
      console.warn("[KRC Library] pick cancel handler failed", error);
    }
  }

  installKey() {
    if (this.keyHandler) return;
    this.keyHandler = (event) => {
      if (event.key === "Escape") {
        if (document.querySelector(".krc-modal-overlay")) return;
        if (handleBrowserSelectionEscape(this.body, event)) return;
        this.close();
      }
    };
    document.addEventListener("keydown", this.keyHandler, true);
  }

  removeKey() {
    if (!this.keyHandler) return;
    document.removeEventListener("keydown", this.keyHandler, true);
    this.keyHandler = null;
  }

  // Click-outside-to-close (opt-in via portal Options). A pointerdown outside the
  // portal closes it — but NOT one landing on the portal's own floating layers:
  // full-screen KRC dialogs (.krc-modal-overlay, e.g. the Options / more-info
  // modals) and the small body-appended dropdown menus. Deferred one tick so the
  // click that opened the portal doesn't immediately close it.
  installOutside() {
    if (this.outsideHandler) return;
    const IGNORE = [
      ".krc-library-modal",
      ".krc-modal-overlay",
      ".krc-menu-select-menu",
      ".krc-floating-menu",
      ".krc-preset-menu",
      ".krc-preset-picker",
      // A Portal toggle (the sidebar BROWSE button) closes it itself on click; letting
      // this close it first would make that click reopen it.
      "[data-krc-portal-toggle]",
    ].join(", ");
    const handler = (event) => {
      if (event.target.closest?.(IGNORE)) return;
      this.close();
    };
    this.outsideHandler = handler;
    setTimeout(() => {
      if (this.outsideHandler === handler) document.addEventListener("pointerdown", handler, true);
    }, 0);
  }

  removeOutside() {
    if (!this.outsideHandler) return;
    document.removeEventListener("pointerdown", this.outsideHandler, true);
    this.outsideHandler = null;
  }

  installDrag(handle, portal) {
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, select, input, textarea")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const rect = portal.getBoundingClientRect();
      const startLeft = rect.left;
      const startTop = rect.top;
      handle.setPointerCapture?.(event.pointerId);
      const onMove = (moveEvent) => {
        const left = Math.max(0, Math.min(startLeft + moveEvent.clientX - startX, window.innerWidth - 80));
        const top = Math.max(0, Math.min(startTop + moveEvent.clientY - startY, window.innerHeight - 40));
        portal.style.left = `${left}px`;
        portal.style.top = `${top}px`;
      };
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });
  }
}

let instance = null;

// window event when the Portal opens or closes, however it was ({detail: {open}}): the
// sidebar BROWSE button shows its selected state from it.
export const PORTAL_VISIBILITY_EVENT = "krc-portal-visibility";

function announceVisibility(open) {
  window.dispatchEvent(new CustomEvent(PORTAL_VISIBILITY_EVENT, { detail: { open } }));
}

export function isLibraryModalOpen() {
  return !!instance?.portal && !instance.portal.hidden;
}

export function closeLibraryModal() {
  instance?.close();
}

function modal() {
  if (!instance) instance = new LibraryModal();
  return instance;
}

export function openLibraryModal(opts) {
  modal().open(opts);
}

// Switch the open Portal to a mode (its position, info column and pick stay as they are):
// the Home mode's menu cards hand over to the Models tab this way.
export function showLibraryProvider(id) {
  if (isLibraryModalOpen()) instance.setProvider(id);
}

// Transient show/hide of the portal's info column (never persisted as the Browse
// default) — for an in-portal page that lives on the info side, e.g. the Civitai
// fetch page opened from the home menu.
export function setLibraryModalInfoOpen(value) {
  instance?.setInfoOpen(value);
}

// The Portal's own settings (info-panel default + click-outside-to-close) as one
// section of the Portal's global Options page (model_library/options_page.js).
// `section({ title, body })` builds the cell — the page's section card.
export function portalOptionsSection(section) {
  return modal().buildBehaviorSection(section);
}
