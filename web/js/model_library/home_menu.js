/*
 * KRC Model Library — home menu: the home menu: shortcut cards (Civitai batch fetch and
 * the other pages) and their card source.
 * Mixed onto the panel prototype (panel.js) right after browserMethods.
 */
import { stopCanvasEvents } from "./helpers.js";
import { thumbnailBox } from "../shared/browser_cards.js";
import { renderModelCard } from "../shared/model_card.js";

// Menu card glyphs: inline SVG drawn about the box centre (a text glyph sits on its font's
// baseline, off-centre). Stats and the gear are drawn in CSS.
const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const COLLECTIONS_GLYPH = svg('<path d="M8 1.5 10.5 4 8 6.5 5.5 4zM4 5.5 6.5 8 4 10.5 1.5 8zM12 5.5 14.5 8 12 10.5 9.5 8zM8 9.5 10.5 12 8 14.5 5.5 12z" fill="currentColor" stroke-width="1"/>');
const REFRESH_GLYPH = svg('<path d="M14 8a6 6 0 1 1-1.76-4.24"/><path d="M12.6 1.6v2.6H10"/>');
const FETCH_GLYPH = svg('<path d="M8 2v8"/><path d="M4.5 6.5 8 10l3.5-3.5"/><path d="M3 13.5h10"/>');
const TRANSFER_GLYPH = svg('<path d="M5 13V3M2.5 5.5 5 3l2.5 2.5"/><path d="M11 3v10M8.5 10.5 11 13l2.5-2.5"/>');

export const homeMenuMethods = {
  homeShortcutItems() {
    // Attach to the (server-wide) Civitai batch job so the Fetch card's subtitle shows a
    // live "Fetching n/N…" on a node and in the Portal alike. Once per panel.
    this.ensureCivitaiBatchAttached?.();
    return [
      {
        id: "collections",
        name: "Collections",
        subtitle: "Browse model collections",
        cardColor: "yellow",
        glyphSvg: COLLECTIONS_GLYPH,
        action: () => this.enterCollectionMode?.(),
      },
      {
        id: "refresh",
        name: "Refresh Library",
        subtitle: this.isLoadingLibrary ? "Scanning..." : "Rescan model folders",
        cardColor: "purple",
        glyphSvg: REFRESH_GLYPH,
        action: () => this.refreshLibraryAndPresets?.(),
      },
      // Fetch, Import and Export and Options are KRC Portal pages (server-wide, not this
      // node's): on a node the card opens the Portal on that page (openPortalPage).
      {
        id: "civitai-fetch",
        name: "Fetch",
        subtitle: this.civitaiHomeSubtitle?.() || "Fetch missing LoRA metadata",
        cardColor: "orange",
        glyphSvg: FETCH_GLYPH,
        action: () => this.openPortalPage("civitaiFetch"),
      },
      {
        id: "stats",
        name: "Stats",
        subtitle: "Library overview",
        cardColor: "blue",
        glyphClass: "krc-home-stats-glyph",
        action: () => this.openStatsPage?.(),
      },
      {
        id: "import-export",
        name: "Import and Export",
        subtitle: "Every node's bundles and presets",
        cardColor: "gray",
        glyphSvg: TRANSFER_GLYPH,
        action: () => this.openPortalPage("transfer"),
      },
      {
        id: "profiles", name: "Profiles", subtitle: "Manage profiles for Prompt Vault.",
        cardColor: "purple", glyphSvg: svg('<circle cx="6" cy="5" r="2.5"/><path d="M1.5 14v-2a4.5 4.5 0 0 1 9 0v2M11 3a2.5 2.5 0 0 1 0 5M12 10a4 4 0 0 1 2.5 4"/>'),
        action: () => this.openPortalPage("profiles"),
      },
      // The global Options page; the gear opens this panel's own Options.
      {
        id: "options",
        name: "Options",
        subtitle: "Settings and preferences",
        cardColor: "green",
        glyphClass: "krc-gear-glyph",
        action: () => this.openPortalPage("options"),
      },
      // KRC sibling packs (Extras, future KRC packs): only while one is installed.
      this.extraOptionsHomeItem?.(),
    ].filter(Boolean);
  },

  homeCardSource() {
    if (this._homeCardSource) return this._homeCardSource;
    const ctl = this;
    this._homeCardSource = {
      keyOf: (shortcut) => shortcut.id,
      setCardKey: (card, shortcut) => { card.dataset.shortcutId = shortcut.id; },
      isSelected: () => false,
      isModified: () => false,
      isPinned: () => false,
      cardColor: (shortcut) => shortcut.cardColor || "",
      hasNotch: () => false,
      resolveThumbnail: () => ({ placeholderKind: "image" }),
      renderThumb: (shortcut) => {
        const thumb = thumbnailBox({ placeholderKind: "image" });
        thumb.classList.add("krc-home-menu-thumb");
        thumb.replaceChildren();
        const glyph = document.createElement("span");
        glyph.className = `krc-home-menu-glyph ${shortcut.glyphSvg ? "krc-home-menu-svg" : shortcut.glyphClass || ""}`.trim();
        if (shortcut.glyphSvg) glyph.innerHTML = shortcut.glyphSvg;
        thumb.append(glyph);
        return thumb;
      },
      nameText: (shortcut) => shortcut.name,
      subtitleText: (shortcut) => shortcut.subtitle || "",
      fillBadgeRow: () => 0,
      decorateCard: (card, shortcut) => {
        card.classList.add("krc-home-menu-card");
        card.classList.toggle("is-disabled", !!shortcut.disabled);
        card.setAttribute("role", "button");
        card.tabIndex = shortcut.disabled ? -1 : 0;
        card.title = shortcut.disabled ? `${shortcut.name} will be added later` : shortcut.name;
      },
      installInteractions: (card, shortcut) => {
        stopCanvasEvents(card);
        if (shortcut.disabled || typeof shortcut.action !== "function") return;
        const open = () => {
          shortcut.action.call(ctl);
        };
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        });
      },
    };
    return this._homeCardSource;
  },

  renderHomeMenu() {
    const list = document.createElement("div");
    list.className = "krc-lora-list is-thumb krc-home-menu";
    const items = this.homeShortcutItems();
    if (!items.length) {
      list.append(this.renderEmptyLibrary());
      return list;
    }
    items.forEach((folder) => {
      list.append(renderModelCard(folder, this.homeCardSource(), { viewMode: "thumb-list" }));
    });
    return list;
  },
};
