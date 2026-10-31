// Shared info-panel view methods (L3-2b). Selection navigation, the missing-record
// (tombstone) view + its purge/fetch, file-path display, and the two date
// formatters were byte-identical across LoRA Loadout and Model Library. The only
// node-local dependencies are the record fetch and the thumbnail route base, so
// they're injected: each node calls makeInfoPanelViewMethods() with its own
// fetchLora + loraApiUrl and spreads the result into its exported infoPanelMethods,
// keeping its divergent renderInfo / selectLora per-node. The shared kind:"lora"
// PanelSource (loraPanelSource, below) also lives here now — it was byte-identical in
// both nodes; Model Library keeps only its own kind:"model" source per-node.
// Bodies are verbatim — the injected identifiers read exactly like the old imports.
import { formatDateTime, formatDateYmd } from "./dates.js";
import { renderTombstonePanel } from "./info_panel.js";
import { krcAlert } from "./modal.js";

export function makeInfoPanelViewMethods({ fetchLora, loraApiUrl }) {
  return {


  displayFilePath(selected) {
    // LoRA records carry relative_path; generic-model records carry relativePath.
    const path = selected?.relative_path || selected?.relativePath || selected?.filename || "";
    return path.replace(/^loras[\\/]/i, "");
  },

  formatDate(value) {
    // Bare "date, time" (no label). The subline adds "Date Added:" and the
    // More Info meta cells add their own label.
    return formatDateTime(value, { empty: "" });
  },

  formatDateOnly(value) {
    // Date without time — used for Date Added, which doesn't need the minute.
    return formatDateYmd(value, { empty: "" });
  },

  cycleSelection(delta) {
    const list = this.visibleLoras();
    if (!list.length) {
      return;
    }
    const current = list.findIndex((lora) => lora.sha256 === this.selectedSha);
    const nextIndex = current < 0 ? 0 : (current + delta + list.length) % list.length;
    const next = list[nextIndex];
    if (next) {
      this.selectLora(next.sha256, { focus: true });
    }
  },

  selectMissingLora(id) {
    if (!id) {
      return;
    }
    this.missingSelection = id;
    this.missingInfo = null;
    this.infoPage = "";  // a selection always wins over a home-menu page (ML)
    this.refreshInfo();
    this.fetchMissingInfo(id);
  },

  async fetchMissingInfo(id) {
    let info = null;
    try {
      const response = await fetchLora(`/missing/${encodeURIComponent(id)}`);
      if (response.ok) {
        info = await response.json();
      }
    } catch {
      info = null;
    }
    // Ignore a stale response if the selection changed while awaiting.
    if (this.missingSelection !== id) {
      return;
    }
    this.missingInfo = info || { id, known: false };
    this.refreshInfo();
  },

  renderMissingInfo() {
    return renderTombstonePanel(this.tombstoneSource(), this.missingSelection, this.missingInfo);
  },

  // TombstoneSource for the shared missing-record panel (shared/info_panel.js).
  // Built fresh each call so the webm flags read live. The only node-specific
  // seam is the missing-thumbnail route (LoRA api prefix); the LoRA-flavored
  // strings are the shared defaults.
  tombstoneSource() {
    const ctl = this;
    return {
      webmEnabled: this.webmThumbnailsEnabled,
      webmAutoplay: this.webmThumbnailAutoplayEnabled,
      thumbnailUrl: (id, { animated, poster } = {}) => loraApiUrl(`/missing-thumbnail/${encodeURIComponent(id)}${animated ? "?kind=animated" : (poster ? "?kind=poster" : "")}`),
      onCopy: (text) => ctl.copyText(text),
      onPurge: (id) => ctl.purgeMissingLora(id),
    };
  },

  // PanelSource descriptor for the shared InfoPanel shell (shared/info_panel.js),
  // kind "lora". Was defined identically in both LoRA Loadout and Model Library
  // (ML dispatches to it for a LoRA record, to its own model source otherwise); the
  // two copies were byte-identical, so they live here once. Memoized per controller;
  // each region reads the passed record live. All referenced methods (renderField,
  // renderInfoActions, renderInfoLeft/Right/Footer, markMetadataEdited, cycleSelection,
  // formatDateOnly) exist on both controllers.
  loraPanelSource() {
    if (this._loraPanelSource) return this._loraPanelSource;
    const ctl = this;
    this._loraPanelSource = {
      kind: "lora",
      title: "Info Panel",
      cycleLabels: { prev: "Previous LoRA", next: "Next LoRA" },
      onCycle: (delta) => ctl.cycleSelection(delta),
      renderActions: (selected) => ctl.renderInfoActions(selected),
      renderName: (selected) => {
        const nameField = ctl.renderField("Name", selected?.display_name || "", (value) => {
          if (selected) {
            selected.display_name = value;
            ctl.markMetadataEdited();
          }
        }, { limitToVisible: true });
        nameField.classList.add("krc-info-name-field");
        return nameField;
      },
      renderSubline: (selected) => {
        const subline = document.createElement("div");
        subline.className = "krc-info-subline";
        const filename = document.createElement("span");
        filename.textContent = selected?.filename || "";
        subline.append(filename);
        if (selected?.originalName) {
          const managerName = document.createElement("span");
          managerName.textContent = `Original Name: ${selected.originalName}`;
          subline.append(managerName);
        }
        const metaRow = document.createElement("div");
        metaRow.className = "krc-info-meta-row";
        const version = document.createElement("span");
        version.textContent = selected?.version ? `Version: ${selected.version}` : "";
        const dateAdded = document.createElement("span");
        dateAdded.className = "krc-info-date";
        const addedText = ctl.formatDateOnly(selected?.dateAdded);
        dateAdded.textContent = addedText ? `Date Added: ${addedText}` : "";
        metaRow.append(version, dateAdded);
        subline.append(metaRow);
        return subline;
      },
      renderLeft: (selected) => ctl.renderInfoLeft(selected),
      renderRight: (selected) => ctl.renderInfoRight(selected),
      renderFooter: (selected) => ctl.renderInfoFooter(selected),
    };
    return this._loraPanelSource;
  },

  async purgeMissingLora(id) {
    if (!id) {
      return;
    }
    let response;
    try {
      response = await fetchLora(`/missing/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      krcAlert("Could not purge LoRA (network error).", this.node);
      return;
    }
    if (!response.ok) {
      krcAlert(response.status === 409
        ? "This LoRA is present in the library, so it can't be purged."
        : `Could not purge LoRA (HTTP ${response.status}).`, this.node);
      return;
    }
    // Metadata is gone, but the preset entry is left untouched — the user
    // removes the stack slot themselves. Refresh the tombstone so it reflects
    // that there are no saved details anymore.
    if (this.missingSelection === id) {
      this.missingInfo = null;
      this.fetchMissingInfo(id);
    }
  },
  };
}
