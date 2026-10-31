import { app } from "../../scripts/app.js";
import { closeLibraryModal, isLibraryModalOpen, openLibraryModal, PORTAL_VISIBILITY_EVENT } from "./shared/library_modal.js";
import { readGlobalSetting } from "./shared/global_settings.js";
import { SIDEBAR_BUTTON_CHANGED_EVENT, SIDEBAR_BUTTON_DEFAULT, SIDEBAR_BUTTON_SETTING_ID } from "./shared/settings.js";
import { ensureStylesheet } from "./shared/stylesheets.js";

// A green BROWSE button directly under Templates in ComfyUI's left toolbar. Like the
// toolbar's own buttons it toggles: a click opens the KRC Portal (as the canvas
// right-click "KRC Portal" entry does), a click while it's open closes it, and it shows
// ComfyUI's selected state while the Portal is open (however it was opened). Opt-in:
// Portal ▸ Options ▸ Appearance ▸ "KRC button in the sidebar", on by default, live.
//
// ComfyUI's sidebar-tab API only adds panel tabs, which sit above Templates and open a
// panel, so this is our own button placed after `.templates-tab-button` (the one class it
// relies on). It copies that button's classes so it matches the toolbar's look, and a
// watcher puts it back when ComfyUI redraws the toolbar. No Templates button (an older or
// newer frontend) = no button; nothing breaks.

const BUTTON_CLASS = "krc-sidebar-button";
const STYLE_VERSION = "1.2-browse-fit";
const TEMPLATES_SELECTOR = ".templates-tab-button";

let button = null;
let observer = null;
let frame = 0;

function createButton(templates) {
  const el = document.createElement("button");
  el.type = "button";
  // Templates' look (size, hover, focus ring), minus its identity and selected state.
  el.className = [...templates.classList]
    .filter((name) => name !== "templates-tab-button" && name !== "side-bar-button-selected")
    .concat(BUTTON_CLASS)
    .join(" ");
  el.title = "KRC Portal";
  el.setAttribute("aria-label", "KRC Portal");
  // The Portal's click-outside close skips it, so this click is the one that toggles.
  el.dataset.krcPortalToggle = "";
  const mark = document.createElement("span");
  mark.className = "krc-sidebar-mark";
  mark.textContent = "BROWSE";
  el.append(mark);
  el.addEventListener("click", () => {
    if (isLibraryModalOpen()) closeLibraryModal();
    // "Remember where I was" on: the last view, whatever tab (else Models, all types).
    else openLibraryModal({ provider: "models", scope: "all", resume: { tabs: "any" } });
  });
  return el;
}

// The element to put the button after: Templates itself, or a wrapper that holds only it
// (a tooltip wrapper), so the button lands beside it in the toolbar's own list.
function anchorFor(templates) {
  let anchor = templates;
  while (anchor.parentElement && anchor.parentElement.children.length === 1 && anchor.parentElement !== document.body) {
    anchor = anchor.parentElement;
  }
  return anchor;
}

function place() {
  frame = 0;
  const templates = document.querySelector(TEMPLATES_SELECTOR);
  if (!templates) return;
  const anchor = anchorFor(templates);
  if (button?.isConnected && anchor.nextElementSibling === button) return;
  button ||= createButton(templates);
  syncSelected();
  anchor.after(button);
}

// ComfyUI's selected look while the Portal is open.
function syncSelected() {
  button?.classList.toggle("side-bar-button-selected", isLibraryModalOpen());
}

function schedulePlace() {
  if (!frame) frame = requestAnimationFrame(place);
}

function show() {
  ensureStylesheet("krc-sidebar-button", "./krc_sidebar_button.css", import.meta.url, { version: STYLE_VERSION });
  place();
  if (!observer) {
    observer = new MutationObserver(schedulePlace);
    observer.observe(document.body, { childList: true, subtree: true });
  }
}

function hide() {
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  button?.remove();
  button = null;
}

function apply(enabled) {
  if (enabled) show();
  else hide();
}

app.registerExtension({
  name: "KRC.SidebarButton",
  setup() {
    window.addEventListener(SIDEBAR_BUTTON_CHANGED_EVENT, (event) => apply(!!event.detail?.enabled));
    window.addEventListener(PORTAL_VISIBILITY_EVENT, syncSelected);
    apply(!!readGlobalSetting(SIDEBAR_BUTTON_SETTING_ID, SIDEBAR_BUTTON_DEFAULT));
  },
});
