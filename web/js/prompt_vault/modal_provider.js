// Prompt provider for the shared library modal. Wraps a DETACHED Prompt Vault
// controller (PMRedesign) driven by a NodeHost stub, so the full prompt browser +
// A/B editor (with drafts) runs inside the modal with no graph node. Built lazily
// and kept alive across opens (the modal is a singleton).
import { PMRedesign } from "./controller.js";
import { injectStyle } from "./styles.js";
import { el } from "./dom.js";
import { fetchPromptLibraryJson, apiGet } from "./api.js";
import { createNodeHostStub } from "../shared/node_host_stub.js";
import { setNodePalette } from "../shared/node_palette.js";

export function createPromptProvider() {
  let ctrl = null;
  let root = null;
  let loading = null;

  const ensure = () => {
    if (ctrl) return ctrl;
    injectStyle(); // PV CSS may not be loaded when opened from another node
    const node = createNodeHostStub({ key: "prompts" });
    root = el("div", "krc-node krc-pm krc-solo-widget is-detached");
    ctrl = new PMRedesign(node, root, { surface: "detached" });
    ctrl.render();
    loading = ctrl.reload().finally(() => { loading = null; }).catch(() => {}); // load the prompt library (async, backend-backed)
    return ctrl;
  };

  return {
    id: "prompts",
    label: "Prompts",

    getRoot() {
      ensure();
      return root;
    },

    // Prompt scope is the category facet; default view shows all. (A future
    // opener could pass a category to preselect.)
    applyScope() {},

    // Showing the tab never rebuilds the panel: live sync (in-memory publishes, and
    // PROMPTS_CHANGED for out-of-band changes) already keeps it current. A quiet check
    // catches anything missed; only a library that differs takes the targeted refresh (the
    // list and chips, not the whole panel). The first show skips it: ensure() is loading.
    // (Was reload(true): a refetch + full re-render on every switch, so the tab flickered,
    // twice on the first open.)
    onShow() {
      if (!ctrl || loading) return;
      const shown = ctrl;
      fetchPromptLibraryJson(shown.effectiveProfileId()).then((data) => {
        if (!data || shown !== ctrl || shown._destroyed) return;
        if (JSON.stringify(data) === JSON.stringify(shown.data)) return;
        shown.reloadFromSync?.().catch?.(() => {});
      }).catch(() => {});
    },

    // Store a palette on the controller's stub node (via the standard per-node
    // seam) so it survives re-renders and reloads — the portal drives this to
    // keep one modal-wide palette. "" clears the override (inherit the global).
    setPalette(id) {
      ensure();
      setNodePalette(ctrl.node, root, id);
    },

    async select(select) {
      const c = ensure();
      if (loading) await loading;
      const category = String(select?.category || "").trim();
      const name = String(select?.name || select?.title || "").trim();
      let item = select?.id ? c.items.find(record => record.id === select.id) : category && name ? c.findByKey?.(c.keyOf(category, name)) : null;
      if (!item && select?.id) {
        const detail = await apiGet(`/prompt-detail?id=${encodeURIComponent(select.id)}`);
        if (detail?.id === select.id) item = detail;
      }
      if (item) {
        await c.select(item, { scroll: true });
      }
    },

    // "Remember where I was" (API 1.18): the active category (the stub node keeps it too)
    // and the selected saved prompt, by category + name.
    getState() {
      if (!ctrl) return null;
      const item = this.getSelection();
      return {
        category: String(ctrl.activeCategory || "__all__"),
        selected: item ? { id: item.id, category: item.category, name: item.name } : null,
      };
    },

    async restoreState(state) {
      const c = ensure();
      if (loading) await loading;
      const category = String(state?.category || "");
      // Only a category that still exists (a deleted one would show an empty list).
      const known = category === "__all__" || (c.visibleCategories?.() || []).includes(category);
      if (category && known && category !== c.activeCategory) c.setActiveCategory?.(category);
      if (state?.selected?.category && state?.selected?.name) await this.select(state.selected);
    },

    // The selected saved prompt (pick mode), or null — never an unsaved draft. The
    // click's request key is set at once, while select() awaits the prompt detail, so a
    // quick double-click picks the card just clicked rather than the previous one.
    getSelection() {
      const key = ctrl?._selectRequestKey || ctrl?.selKey;
      const item = key ? ctrl.findByKey?.(key) : null;
      return item && item.id && !item.__draft ? item : null;
    },

    destroy() {
      ctrl?.destroy?.();
      ctrl = null;
      root = null;
      loading = null;
    },
  };
}
