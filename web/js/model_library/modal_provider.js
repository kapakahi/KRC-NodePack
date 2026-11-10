// Model provider for the shared library modal. Wraps a DETACHED Model Library
// panel (its class is exported as LoraStackerPanel) driven by a NodeHost stub, so
// the full model browser + info editor runs inside the modal with no graph node.
// The panel is built lazily and kept alive across opens (the modal is a singleton).
import { ensureStylesheet } from "./helpers.js";
import { LoraStackerPanel } from "./panel.js";
import { createNodeHostStub } from "../shared/node_host_stub.js";
import { setNodePalette } from "../shared/node_palette.js";
import { showLibraryProvider } from "../shared/library_modal.js";

// scope token -> ML folder-rail id. Model types are backend-supplied folders with
// ids `__type__:<modelType>` (utils/model_library/browser_rows.py _type_row_id), so ANY
// model type (checkpoint, diffusion, unet, vae, clip, text_encoder, controlnet, upscaler,
// embedding, lora) scopes generically. The unscoped/parent view is HOME — used for
// "all", the untyped fallback, and "other". LL mini opens scope "lora".
function scopeFolderId(scope) {
  const s = String(scope || "").trim();
  if (!s || s === "all" || s === "other") return "__model_home__";
  return `__type__:${s}`;
}

function selectionTokens(select) {
  if (!select) return [];
  if (typeof select === "string") return [select].filter(Boolean);
  return [
    select.sha256,
    select.libraryId,
    select.id,
    select.value,
    select.relativePath,
    select.relative_path,
    select.file,
    select.path,
  ].map((value) => String(value || "").trim()).filter(Boolean);
}

function waitFrame() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// The ids of the Info panel pages a remembered state may reopen (model_library/*_page.js).
const RESTORABLE_PAGES = new Set(["civitaiFetch", "stats", "transfer", "options", "profiles", "extraOptions", "api"]);

// The Portal's ONE Model Library panel: the Models tab and the Home tab (its menu cards,
// home_provider.js) drive the same detached panel.
let sharedPanel = null;
// The last LoRA selected (LoRA Loadout's Browse resumes it, API 1.18), kept apart from
// the last model of any type.
let lastLora = "";

export function modelLibraryPanel() {
  if (sharedPanel) return sharedPanel;
  ensureStylesheet(); // ML's clone CSS may not be loaded when opened from another node
  const node = createNodeHostStub({ key: "models" });
  sharedPanel = new LoraStackerPanel(node, { surface: "detached" });
  // Every user selection goes through selectLora: note the LoRAs.
  const selectLora = sharedPanel.selectLora;
  sharedPanel.selectLora = function (sha256, ...rest) {
    const result = selectLora.call(this, sha256, ...rest);
    if ((this.loras || []).find((item) => item.sha256 === sha256)?.modelType === "lora") lastLora = sha256;
    return result;
  };
  return sharedPanel;
}

// The Home tab borrows the panel's Info Panel for a page (Fetch, Stats, Options…): the
// panel's `.krc-info` lookups (querySurface) find `host` first, so the page renders and
// refreshes there. `savedPage` is the Models tab's own page, put back when it's returned.
let lent = null;

// Open `open(panel)`'s page in `host` (a `.krc-model-library` element on the Home tab).
export function lendInfoPage(host, open) {
  const panel = modelLibraryPanel();
  if (!lent) lent = { savedPage: panel.infoPage || "" };
  panel.infoHost = host;
  // A page's "show these models" (a Stats cell, a Fetch row) goes to the Models tab, the
  // page along with it.
  panel.leaveHome = () => {
    reclaimInfoPage({ keepPage: true });
    showLibraryProvider("models");
  };
  host.replaceChildren(document.createElement("section"));
  host.firstChild.className = "krc-panel krc-info";
  open(panel);
}

// The Info Panel back to the Models tab. `keepPage`: the page goes along (a Stats cell or a
// Fetch row hands over to Models); otherwise the Models tab's own page comes back.
export function reclaimInfoPage({ keepPage = false } = {}) {
  if (!lent || !sharedPanel) return;
  const panel = sharedPanel;
  panel.infoHost = null;
  panel.leaveHome = null;
  if (!keepPage) panel.infoPage = lent.savedPage;
  lent = null;
  panel.refreshInfo();
}

export function createModelProvider() {
  let panel = null;
  const ensurePanel = () => (panel ||= modelLibraryPanel());

  // The library loaded (select / restore wait for it).
  const libraryReady = async (p) => {
    for (let i = 0; i < 30 && p.isLoadingLibrary; i++) {
      await waitFrame();
    }
    if (!p.loras?.length && !p.isLoadingLibrary) {
      await p.loadLibrary?.({ focusSelection: false });
    }
  };

  return {
    id: "models",
    label: "Models",

    // The DOM the modal mounts (browser + info; info is CSS-collapsed by the modal
    // until the Info button reveals it).
    getRoot() {
      return ensurePanel().root;
    },

    // Opener intent wins for scope: force the requested model type each open.
    applyScope(scope) {
      const p = ensurePanel();
      const folder = scopeFolderId(scope);
      if (typeof p.setFolder === "function") {
        p.setFolder(folder);
        p.refreshBrowser?.({ focusSelection: true });
      }
    },

    // Called when this provider becomes the active/visible one.
    onShow() {
      reclaimInfoPage();
      panel?.rehydrateFromNode?.();
    },

    // Store a palette on the panel's stub node (via the standard per-node seam)
    // so it survives re-renders and rehydration — the portal drives this to keep
    // one modal-wide palette. "" clears the override (inherit the global palette).
    setPalette(id) {
      const p = ensurePanel();
      setNodePalette(p.node, p.root, id);
    },

    // An Info Panel page by id (Fetch, Import and Export, Options): opener intent from a
    // node's home menu or the Options note.
    openPage(page) {
      ensurePanel().openPortalPage?.(page);
    },

    async select(select) {
      const p = ensurePanel();
      const tokens = new Set(selectionTokens(select));
      if (!tokens.size) return;
      await libraryReady(p);
      const match = (p.loras || []).find((item) => [
        item.sha256,
        item.libraryId,
        item.id,
        item.relativePath,
        item.relative_path,
        item.file,
        item.path,
        item.filename,
      ].some((value) => tokens.has(String(value || "").trim())));
      if (match?.sha256) {
        p.selectLora?.(match.sha256, { focus: true });
      }
    },

    // "Remember where I was" (API 1.18). The folder is already kept by the stub node
    // (mlBrowserFolder); this adds the selection, the last LoRA, the Info page and the
    // collection view (a temporary folder the stub doesn't keep).
    getState() {
      if (!panel) return null;
      const inCollections = Boolean(panel.collectionModeActive?.());
      // While Home has the Info Panel, the Models tab's own page is the one it set aside.
      const page = lent ? lent.savedPage : panel.infoPage;
      return {
        selected: panel.selectedSha || "",
        lastLora,
        page: RESTORABLE_PAGES.has(page) ? page : "",
        collection: inCollections ? panel.activeCollectionId || "" : null,
      };
    },

    async restoreState(state) {
      const p = ensurePanel();
      lastLora = String(state?.lastLora || "");
      await libraryReady(p);
      if (state?.collection !== null && state?.collection !== undefined) p.viewCollection?.(state.collection);
      if (state?.selected) await this.select({ sha256: state.selected });
      // A page last: selecting a card clears it.
      if (RESTORABLE_PAGES.has(state?.page)) p.openInfoPage?.(state.page);
    },

    // resume("lora"): the LoRA folder on the last LoRA selected; false when there's none
    // (the opener's own scope applies).
    async resume(as) {
      if (as !== "lora" || !lastLora) return false;
      const p = ensurePanel();
      await libraryReady(p);
      if (!(p.loras || []).some((item) => item.sha256 === lastLora)) return false;
      if (p.collectionModeActive?.()) p.exitCollectionMode?.();
      p.setFolder?.(scopeFolderId("lora"));
      p.refreshBrowser?.({ focusSelection: true });
      p.selectLora?.(lastLora, { focus: true });
      return true;
    },

    // The selected model item (pick mode), or null.
    getSelection() {
      if (!panel?.selectedSha) return null;
      return (panel.loras || []).find((item) => item.sha256 === panel.selectedSha) || null;
    },

    destroy() {
      panel?.destroy?.();
      if (sharedPanel === panel) sharedPanel = null;
      panel = null;
    },
  };
}
