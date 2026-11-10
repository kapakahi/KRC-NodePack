/*
 * Info Panel pages — non-item views a home-menu card opens on the Info Panel side
 * (Fetch, Stats). While `infoPage` is set, renderInfo() shows that page instead of
 * the selected item; selecting any card clears it (selectLora / selectMissingLora).
 * There's no back/close button: selecting a card or another home-menu entry leaves a page.
 *
 * This module is the shared shell: open/close + the header / scrolling body /
 * section-card layout. Each page module supplies only its content.
 */
import { el } from "../shared/dom.js";
import { openLibraryModal, setLibraryModalInfoOpen } from "../shared/library_modal.js";

// The pages that belong to the KRC Portal (server-wide, not one node's): page id → the
// method that opens it. The ids match CIVITAI_FETCH_PAGE, TRANSFER_PAGE, OPTIONS_PAGE and
// EXTRA_OPTIONS_PAGE (their modules import this one, so they're spelled out here).
const PORTAL_PAGE_OPENERS = {
  civitaiFetch: "openCivitaiFetchPage",
  transfer: "openTransferPage",
  options: "openOptionsPage",
  profiles: "openProfilesPage",
  extraOptions: "openExtraOptionsPage",
  api: "openApiPage",
};

export const infoPageMethods = {
  // A Portal page from the home menu: in the Portal it opens right here; on a Model
  // Library node it opens the Portal on that page.
  openPortalPage(page) {
    const opener = PORTAL_PAGE_OPENERS[page];
    if (!opener) return;
    if (this.surface === "detached") this[opener]?.();
    else openLibraryModal({ provider: "models", page });
  },

  openInfoPage(page) {
    this.missingSelection = "";
    this.missingInfo = null;
    this.infoPage = page;
    // The portal collapses its info column by default — pages live there.
    if (this.surface === "detached") setLibraryModalInfoOpen(true);
    this.refreshInfo();
  },

  // → { panel, body }: the page's Info Panel section with its header built; the
  // caller appends content to `body`.
  infoPageShell(title, className = "") {
    const panel = el("section", `krc-panel krc-info krc-info-page${className ? ` ${className}` : ""}`);
    const header = el("div", "krc-panel-header");
    const nav = el("div", "krc-info-nav");
    nav.append(el("span", "krc-info-title", { textContent: title }));
    header.append(nav);
    const body = el("div", "krc-info-page-body");
    panel.append(header, body);
    return { panel, body };
  },
};

// A section card inside a page body; an empty title gives a header-less card, and
// null children are dropped.
export function infoPageSection(title, ...children) {
  const section = el("div", "krc-info-page-section");
  if (title) section.append(el("div", "krc-info-page-section-title", { textContent: title }));
  section.append(...children.flat().filter(Boolean));
  return section;
}
