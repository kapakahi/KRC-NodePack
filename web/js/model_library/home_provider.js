// The KRC Portal's Home tab (the header's house button): a browser of the KRC menu cards
// only (Collections, Refresh Library, Fetch, Stats, Import and Export, Options, Extra
// Options) and the info column: the Home page, or the page a menu card opened.
//
// The Home page: the 4 most recently added models (big thumbnails, titles that open the
// model in the Models tab), the placeholder KRC logo with NodePack's version and month
// (shared/version.js) and the GitHub link, and a dimmed line of library counts.
//
// The cards are the Model Library's (home_menu.js) on the Portal's one ML panel. A page
// card (Fetch, Stats, Import and Export, Options, Extra Options) opens its page in Home's
// info column (the panel's Info Panel is lent there: modal_provider.js lendInfoPage), the
// card ringed; the same card again, or the house button, brings the Home page back.
// Collections goes to the Models tab; Refresh rescans in place.
import { thumbnailBox } from "../shared/browser_cards.js";
import { el } from "../shared/dom.js";
import { PORTAL_HOME_ID, setLibraryModalInfoOpen, showLibraryProvider } from "../shared/library_modal.js";
import { renderModelCard } from "../shared/model_card.js";
import { createNodeHostStub } from "../shared/node_host_stub.js";
import { setNodePalette } from "../shared/node_palette.js";
import { nsfwDisplayState } from "../shared/nsfw_visibility.js";
import { KRC_NODEPACK_HOMEPAGE, KRC_NODEPACK_RELEASED, KRC_NODEPACK_VERSION } from "../shared/version.js";
import { fetchPromptLibraryJson } from "../prompt_vault/api.js";
import { lendInfoPage, modelLibraryPanel, reclaimInfoPage } from "./modal_provider.js";

// Menu cards whose page opens on Home (home_menu.js / extra_options_page.js ids).
const PAGE_CARDS = new Set(["civitai-fetch", "stats", "import-export", "options", "profiles", "extra-options"]);
const RECENT_COUNT = 4;

const plural = (count, one, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;

// The prompt count for the stats line: the shared library read (category → name → record).
async function promptCount() {
  const data = await fetchPromptLibraryJson();
  if (!data || typeof data !== "object" || data.error) return null;
  let count = 0;
  for (const category of Object.values(data)) {
    if (!category || typeof category !== "object") continue;
    for (const [name, entry] of Object.entries(category)) {
      if (name !== "__meta__" && entry && typeof entry === "object") count += 1;
    }
  }
  return count;
}

// The library loaded (the Portal's panel may still be scanning, or not have started).
async function libraryReady(panel) {
  for (let i = 0; i < 30 && panel.isLoadingLibrary; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  if (!panel.loras?.length && !panel.isLoadingLibrary) await panel.loadLibrary?.({ focusSelection: false });
}

export function createHomeProvider() {
  const stub = createNodeHostStub({ key: PORTAL_HOME_ID });
  const root = el("div", "krc-node krc-portal-mode krc-portal-home-mode");
  const grid = el("div", "krc-portal-mode-grid");
  const browser = el("section", "krc-panel krc-browser krc-portal-home-browser");
  // The menu cards' look is the Model Library's (scoped to .krc-model-library).
  const menu = el("div", "krc-model-library krc-portal-home-menu");
  browser.append(menu);
  const info = el("div", "krc-portal-mode-info krc-portal-home-info");
  const recent = el("div", "krc-portal-recent");
  const brand = el("div", "krc-portal-home-center");
  brand.append(
    el("div", "krc-portal-logo", { textContent: "KRC" }),
    el("div", "krc-portal-home-version", { textContent: `KRC NodePack · v${KRC_NODEPACK_VERSION} · ${KRC_NODEPACK_RELEASED}` }),
    el("a", "krc-portal-home-link", { href: KRC_NODEPACK_HOMEPAGE, target: "_blank", rel: "noopener noreferrer", textContent: "GitHub" }),
  );
  const stats = el("div", "krc-portal-home-stats");
  const homePage = el("div", "krc-portal-home-page");
  // The logo block centred on the page; Recently added and the counts at the bottom.
  const bottom = el("div", "krc-portal-home-bottom");
  bottom.append(recent, stats);
  homePage.append(brand, bottom);
  // A page card's page: the panel's Info Panel, lent here (ML's page CSS is scoped to
  // .krc-model-library).
  const pages = el("div", "krc-model-library is-detached krc-portal-home-pages");
  pages.hidden = true;
  info.append(homePage, pages);
  grid.append(browser, info);
  root.append(grid);

  let activeCard = "";   // the page card whose page shows ("" = the Home page)
  let prompts = null;

  // ---- the menu ------------------------------------------------------------------------
  const renderMenu = () => {
    const panel = modelLibraryPanel();
    const base = panel.homeCardSource();
    const source = {
      ...base,
      isSelected: (shortcut) => shortcut.id === activeCard,
      installInteractions: (card, shortcut) => {
        if (shortcut.disabled || typeof shortcut.action !== "function") return;
        const open = () => openCard(shortcut);
        card.addEventListener("click", open);
        card.addEventListener("keydown", (event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          open();
        });
      },
    };
    const list = el("div", "krc-lora-list is-thumb krc-home-menu");
    for (const item of panel.homeShortcutItems()) list.append(renderModelCard(item, source, { viewMode: "thumb-list" }));
    menu.replaceChildren(list);
  };

  const showHomePage = () => {
    reclaimInfoPage();
    activeCard = "";
    pages.hidden = true;
    pages.replaceChildren();
    homePage.hidden = false;
    renderMenu();
    renderHomePage();
  };

  const openCard = (shortcut) => {
    const panel = modelLibraryPanel();
    if (PAGE_CARDS.has(shortcut.id)) {
      if (activeCard === shortcut.id) {
        showHomePage();
        return;
      }
      activeCard = shortcut.id;
      homePage.hidden = true;
      pages.hidden = false;
      // The page's opener also opens a collapsed info column (one click).
      lendInfoPage(pages, (lent) => shortcut.action.call(lent));
      setLibraryModalInfoOpen(true);
      renderMenu();
      return;
    }
    if (shortcut.id === "refresh") {
      Promise.resolve(shortcut.action.call(panel)).finally(() => {
        renderMenu();
        if (!activeCard) renderHomePage();
      });
      renderMenu();
      return;
    }
    // Collections (and anything else): a browser view, on the Models tab.
    showLibraryProvider("models");
    shortcut.action.call(panel);
  };

  // ---- the Home page -------------------------------------------------------------------
  // A model in the Models tab: All Models (every model in the Portal), selected, its info.
  const openModel = (item) => {
    const panel = modelLibraryPanel();
    showLibraryProvider("models");
    if (panel.collectionModeActive?.()) panel.exitCollectionMode?.();
    panel.query = "";
    panel.setFolder?.("__model_home__");
    panel.refreshBrowser?.({ focusSelection: false });
    panel.selectLora?.(item.sha256, { focus: true });
    setLibraryModalInfoOpen(true);
  };

  const recentTile = (panel, item) => {
    const blurred = panel.shouldBlurNsfw?.(item);
    const video = item.thumbnailType === "video";
    // Never autoplays: a still (a video's poster) that plays while hovered.
    const animated = video && panel.webmThumbnailsEnabled && !blurred;
    const thumb = thumbnailBox({
      className: "krc-portal-recent-img",
      url: item.thumbnail ? panel.thumbnailUrl(item, animated ? "animated" : (video && item.thumbnailHasPoster ? "poster" : "")) : "",
      draggable: false,
      mediaType: animated ? "video" : "image",
      playOnHover: animated,
      posterUrl: animated && item.thumbnailHasPoster ? panel.thumbnailUrl(item, "poster") : "",
      placeholderKind: item.previewWithheld && !item.thumbnail ? "nsfw" : (item.thumbnailNeedsPoster || video ? "video" : "image"),
      blurred,
    });
    const name = panel.browserLabel?.(item) || item.name || item.file || "Model";
    const tile = el("div", "krc-portal-recent-tile");
    const frame = el("button", "krc-portal-recent-frame", { type: "button", title: name });
    frame.append(thumb);
    frame.addEventListener("click", () => openModel(item));
    const title = el("a", "krc-portal-recent-title", { href: "#", textContent: name, title: name });
    title.addEventListener("click", (event) => {
      event.preventDefault();
      openModel(item);
    });
    tile.append(frame, title);
    return tile;
  };

  const renderHomePage = () => {
    const panel = modelLibraryPanel();
    const loras = panel.loras || [];
    const settings = { showNsfw: panel.showNsfw, displayMode: panel.nsfwDisplayMode };
    // Newest first; a model the NSFW setting hides isn't featured (the next one is).
    const items = loras
      .filter((item) => item.dateAdded && !nsfwDisplayState(item, settings).hidden)
      .map((item) => ({ item, at: Date.parse(item.dateAdded) || 0 }))
      .sort((a, b) => b.at - a.at)
      .slice(0, RECENT_COUNT)
      .map(({ item }) => item);
    const row = el("div", "krc-portal-recent-row");
    for (const item of items) row.append(recentTile(panel, item));
    recent.replaceChildren(el("div", "krc-portal-recent-label", { textContent: "Recently added" }), row);
    recent.hidden = !items.length;

    const count = (type) => loras.filter((item) => item.modelType === type).length;
    const parts = [plural(count("lora"), "LoRA"), plural(count("diffusion_models"), "Diffusion Model")];
    if (prompts !== null) parts.push(plural(prompts, "Prompt"));
    stats.textContent = loras.length ? parts.join(" · ") : "";
  };

  const loadHomePage = () => {
    const panel = modelLibraryPanel();
    renderHomePage();
    libraryReady(panel).then(() => !activeCard && renderHomePage()).catch(() => {});
    promptCount().then((value) => {
      prompts = value;
      if (!activeCard) renderHomePage();
    }).catch(() => {});
  };

  // A page card by id (Remember where I was).
  const openCardById = (id) => {
    const shortcut = modelLibraryPanel().homeShortcutItems().find((item) => item.id === id);
    if (shortcut && PAGE_CARDS.has(id) && activeCard !== id) openCard(shortcut);
  };

  return {
    getRoot: () => root,
    // The house button (or the Home tab shown again): the Home page.
    onShow: () => {
      showHomePage();
      loadHomePage();
    },
    setPalette: (id) => setNodePalette(stub, root, id),
    getState: () => ({ page: activeCard }),
    restoreState: (state) => {
      if (PAGE_CARDS.has(state?.page)) openCardById(state.page);
    },
  };
}
