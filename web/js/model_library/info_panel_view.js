import { teardownMedia } from "../shared/browser_cards.js";
import { queryDataAttrAny } from "../shared/dom.js";
import { renderInfoPanel } from "../shared/info_panel.js";
import { fetchLora, loraApiUrl } from "./api.js";
import { setWidgetValue } from "./helpers.js";
import { makeInfoPanelViewMethods } from "../shared/info_panel_view.js";
import { CIVITAI_FETCH_PAGE } from "./civitai_fetch_page.js";
import { STATS_PAGE } from "./stats_page.js";
import { OPTIONS_PAGE } from "./options_page.js";
import { EXTRA_OPTIONS_PAGE } from "./extra_options_page.js";
import { TRANSFER_PAGE } from "./transfer_page.js";

// Selection nav + missing-record view + date formatters, injected with this node's
// record fetch and thumbnail route base (see L3-2b).
const infoPanelViewMethods = makeInfoPanelViewMethods({ fetchLora, loraApiUrl });

export const infoPanelMethods = {
  ...infoPanelViewMethods,

  renderInfo() {
    // A non-item page (home-menu destination) owns the Info Panel until a card is selected.
    if (this.infoPage === CIVITAI_FETCH_PAGE) {
      return this.renderCivitaiFetchPage();
    }
    if (this.infoPage === STATS_PAGE) {
      return this.renderStatsPage();
    }
    if (this.infoPage === TRANSFER_PAGE) {
      return this.renderTransferPage();
    }
    if (this.infoPage === "profiles") return this.renderProfilesPage();
    if (this.infoPage === "api") return this.renderApiPage();
    if (this.infoPage === OPTIONS_PAGE) {
      return this.renderOptionsPage();
    }
    if (this.infoPage === EXTRA_OPTIONS_PAGE) {
      return this.renderExtraOptionsPage();
    }
    if (this.missingSelection) {
      return this.renderMissingInfo();
    }
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || this.loras[0] || null;
    this.ensureMetadataBaseline?.(selected);
    if (this.isGenericModel?.(selected)) {
      return this.renderGenericModelInfo(selected);
    }
    if (this.hasDeferredLoraDetail?.(selected)) {
      const pendingSha = selected?.sha256;
      // Dedupe the deferred-detail load per sha. renderInfo runs on every panel
      // rebuild, and the fetch flow keeps swapping the selected object for a fresh
      // one that carries the SAME deferred flags (updateLibraryLora spreads them),
      // so without this guard each rebuild attaches another .then; when one resolves
      // it re-renders, which rebuilds and attaches more — a self-feeding storm that
      // freezes the tab (independent of library size). One load in flight per sha
      // breaks the cycle; the re-render still happens once when detail resolves.
      this._deferredDetailInFlight ||= new Set();
      if (pendingSha && !this._deferredDetailInFlight.has(pendingSha)) {
        this._deferredDetailInFlight.add(pendingSha);
        Promise.resolve(this.ensureLoraDetail?.(selected)).then((detail) => {
          this._deferredDetailInFlight.delete(pendingSha);
          if (this._destroyed || this.selectedSha !== pendingSha) {
            return;
          }
          // Only re-render when the detail actually loaded (deferred flags cleared).
          // If the fetch couldn't satisfy this record — e.g. an unscraped LoRA whose
          // local id has no /detail match — the flags stay set; re-rendering here
          // would re-enter this same fetch and spin an infinite render loop. Leaving
          // the panel as-is is correct for a metadata-less LoRA; a later
          // stabilize/refresh picks up real detail if it appears.
          if (detail && !this.hasDeferredLoraDetail(detail)) {
            this.refreshInfo();
            this.refreshLoraCard(detail.sha256);
          }
        }).catch(() => this._deferredDetailInFlight.delete(pendingSha));
      }
    }
    return this.withMetadataDots(renderInfoPanel(this.loraPanelSource(), selected));
  },

  selectLora(sha256, { focus = false } = {}) {
    if (!sha256) {
      return;
    }
    this.missingSelection = "";
    this.missingInfo = null;
    this.infoPage = "";
    const prevSha = this.selectedSha;
    this.selectedSha = sha256;
    setWidgetValue(this.node, "selected_lora_sha256", sha256);
    this.scheduleStabilize(sha256);   // dwell-triggered auto-stabilize for local ids

    const updateCard = (sha) => {
      const card = queryDataAttrAny([this.pickerPortal, this.root], ".krc-lora-card", "data-lora-sha", sha);
      if (!card) {
        return;
      }
      const lora = this.loras.find((item) => item.sha256 === sha) || {};
      const isSelected = sha === sha256;
      this.applyCardColor(card, lora, isSelected);
    };
    if (prevSha && prevSha !== sha256) {
      updateCard(prevSha);
    }
    updateCard(sha256);

    const info = this.querySurface(".krc-info");
    if (!info) {
      // Layout not present as expected; fall back to a full render.
      this.render({ preserveBrowserScroll: true, focusSelection: focus });
      return;
    }
    teardownMedia(info);
    info.replaceWith(this.renderInfo());
    if (focus) {
      this.focusSelectedLora();
    }
  }

};
