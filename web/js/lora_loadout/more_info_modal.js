import { armConfirmButton } from "../shared/confirm_action.js";
import { openKrcModal } from "../shared/modal.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";


const MORE_INFO_MODAL_WIDTH = 720;
const MORE_INFO_MODAL_HEIGHT = 900;


export const moreInfoModalMethods = {

  renderMoreInfoBody(selected, { onEdited = null } = {}) {
    const body = document.createElement("div");
    body.className = "krc-modal-text-list krc-more-info-body";
    const scroll = document.createElement("div");
    scroll.className = "krc-more-info-scroll";
    const columns = document.createElement("div");
    columns.className = "krc-modal-text-columns";
    const left = document.createElement("div");
    left.className = "krc-modal-text-column";
    const right = document.createElement("div");
    right.className = "krc-modal-text-column krc-more-info-prompts-column";
    // Metadata fields are always editable here (mirroring the inline InfoPanel);
    // the modified/discard state guards against accidental edits. Identity fields
    // below stay read-only.
    const description = this.renderMoreInfoEditField("Description", selected?.description || "", (value) => {
      selected.description = value;
      this.markMetadataEdited();
    }, { multiline: true, prominent: true, onEdited, className: "krc-more-info-description-row" });
    const identitySection = this.renderMoreInfoSection("Identity", [
      this.renderMoreInfoEditField("Name", selected?.display_name || "", (value) => {
        selected.display_name = value;
        this.markMetadataEdited();
      }, { onEdited }),
      this.renderMoreInfoRow("Filename", selected?.filename || ""),
      this.renderMoreInfoRow("Original Name", selected?.originalName || ""),
      // The ID is already shown (dimmed) in the footer meta cells, so no
      // dedicated Identity row for it.
    ]);
    const metadataSection = this.renderMoreInfoSection("Metadata", [
      this.renderMoreInfoEditField("Base Model", selected?.baseModel || "", (value) => {
        selected.baseModel = value;
        this.markMetadataEdited();
      }, { onEdited }),
      this.renderMoreInfoEditField("Category", selected?.category || "", (value) => {
        selected.category = value;
        this.markMetadataEdited();
      }, { onEdited }),
      this.renderMoreInfoEditField("Version", selected?.version || "", (value) => {
        selected.version = value;
        this.markMetadataEdited();
      }, { onEdited }),
      this.renderMoreInfoEditField("Creator", this.formatMoreInfoCreator(selected), (value) => {
        if (!selected.creator || typeof selected.creator !== "object") {
          selected.creator = {};
        }
        selected.creator.username = value;
        this.markMetadataEdited();
      }, { onEdited }),
      // Civitai has no named-license string, only allow* permission flags; fold a
      // derived permissions summary in as the DISPLAY DEFAULT when no manual/HF license
      // is set. It is display-only: renderMoreInfoEditField sets the value without firing
      // onInput, so the summary is never persisted into usage.license unless the user
      // actually edits the field — a Force Refresh then recomputes it from fresh flags.
      this.renderMoreInfoEditField("License", selected?.usage?.license || this.formatMoreInfoUsage(selected), (value) => {
        if (!selected.usage || typeof selected.usage !== "object") {
          selected.usage = {};
        }
        selected.usage.license = value;
        this.markMetadataEdited();
      }, { onEdited }),
      this.renderMoreInfoNsfwField(selected, { onEdited }),
      this.renderMoreInfoEditField("Trained Words", this.formatMoreInfoList(selected?.trainedWords), (value) => {
        selected.trainedWords = this.parseMoreInfoList(value);
        this.markMetadataEdited();
      }, { multiline: true, onEdited, className: "krc-more-info-trained-row" }),
      this.renderMoreInfoEditField("Tags", this.formatMoreInfoList(selected?.tags), (value) => {
        selected.tags = this.parseMoreInfoList(value);
        this.markMetadataEdited();
      }, { multiline: true, onEdited, className: "krc-more-info-tags-row" }),
    ]);
    metadataSection.classList.add("krc-more-info-metadata-section");
    left.append(identitySection, metadataSection);
    const promptsSection = this.renderMoreInfoSection("Prompts", [
      this.renderMoreInfoEditField("Example Prompt 1", selected?.examplePrompts?.[0] || "", (value) => {
        const prompts = Array.isArray(selected.examplePrompts) ? [...selected.examplePrompts] : [];
        prompts[0] = value;
        selected.examplePrompts = prompts;
        this.markMetadataEdited();
      }, { multiline: true, onEdited, className: "krc-more-info-prompt-row" }),
      this.renderMoreInfoEditField("Example Prompt 2", selected?.examplePrompts?.[1] || "", (value) => {
        const prompts = Array.isArray(selected.examplePrompts) ? [...selected.examplePrompts] : [];
        prompts[1] = value;
        selected.examplePrompts = prompts;
        this.markMetadataEdited();
      }, { multiline: true, onEdited, className: "krc-more-info-prompt-row" }),
      this.renderMoreInfoEditField("Notes", selected?.notes || "", (value) => {
        selected.notes = value;
        this.markMetadataEdited();
      }, { multiline: true, onEdited, className: "krc-more-info-notes-row" }),
    ]);
    promptsSection.classList.add("krc-more-info-prompts-section");
    right.append(promptsSection);
    columns.append(left, right);
    scroll.append(
      description,
      columns
    );
    body.append(scroll, this.renderMoreInfoMetaFooter(selected));
    return body;
  },

  openMoreInfoModal(selected) {
    if (!selected) {
      return;
    }

    this._moreInfoModalOpen = true;   // pause auto-stabilize while the modal is open
    let modal = null;
    let headerBadgeSlot = null;
    let badgeFrame = 0;
    const footer = document.createElement("div");
    footer.className = "krc-modal-foot krc-more-info-foot";
    // Prefer the currently-selected sha so the modal follows an id change (e.g.
    // Refresh metadata can re-key the LoRA), falling back to the opened one.
    const selectedForModal = () =>
      this.loras.find((lora) => lora.sha256 === this.selectedSha)
      || this.loras.find((lora) => lora.sha256 === selected.sha256)
      || selected;
    const syncInfoPanel = () => {
      const current = selectedForModal();
      if (current?.sha256 && current.sha256 === this.selectedSha) {
        this.refreshInfo();
      }
    };
    // Coalesce the modified-badge refresh across a frame so fast typing doesn't
    // recompute it per keystroke. The badge is the only thing that must update
    // live while editing; the info panel behind the modal is reconciled once on
    // close, not on every character (which rebuilt the whole panel each time).
    const scheduleHeaderBadge = () => {
      if (badgeFrame) {
        return;
      }
      badgeFrame = requestAnimationFrame(() => {
        badgeFrame = 0;
        refreshHeaderBadge();
      });
    };
    const refreshModalEditState = () => {
      scheduleHeaderBadge();
    };
    const refreshHeaderBadge = () => {
      if (!modal) {
        return;
      }
      const current = selectedForModal();
      headerBadgeSlot?.replaceChildren();
      if (this.isMetadataModified(current)) {
        headerBadgeSlot?.append(this.renderModifiedBadge({
          discardable: true,
          onDiscard: () => {
            // discardMetadataDraft() already refreshes the info panel.
            this.discardMetadataDraft();
            modal.body.replaceChildren(this.renderMoreInfoBody(selectedForModal(), { onEdited: refreshModalEditState }));
            refreshHeaderBadge();
          },
        }));
      }
    };
    const renderModal = () => {
      if (!modal) {
        return;
      }
      const current = selectedForModal();
      modal.body.replaceChildren(this.renderMoreInfoBody(current, { onEdited: refreshModalEditState }));
      footer.replaceChildren();

      const save = document.createElement("button");
      save.className = "krc-save-button";
      save.type = "button";
      save.textContent = "save";
      save.disabled = !current;
      save.addEventListener("click", async () => {
        save.disabled = true;
        await this.saveSelected(current);
        renderModal();
      });

      // Civitai re-pull (public/no-auth). Placeholder: client + wiring land in the
      // next Stage-1 increment. Consent-gated — off shows the disabled notice,
      // no request.
      const civitai = document.createElement("button");
      civitai.className = "krc-modal-btn krc-force-refresh-civitai-button";
      civitai.type = "button";
      civitai.textContent = "Force Refresh";
      civitai.title = "Re-pull from Civitai and replace every field, including ones you set (Fetch keeps them)";
      civitai.disabled = !current;
      armConfirmButton(civitai, {
        armedText: "Replace edits?",
        armedTitle: "Click again — Civitai values replace the names, descriptions and other fields you set",
        restoreText: "Force Refresh",
        restoreTitle: "Re-pull from Civitai and replace every field, including ones you set (Fetch keeps them)",
        timeout: 2400,
        shouldArm: () => !!current,
        onConfirm: async () => {
          if (!isNetworkAllowed()) {
            notifyNetworkDisabled();
            return;
          }
          civitai.disabled = true;
          civitai.textContent = "Fetching…";
          const result = await this.fetchCivitaiMetadata(current, { force: true });
          if (result?.refreshed?.sha256) {
            selected = result.refreshed;
          }
          renderModal();
        },
      });

      const refreshThumbnail = document.createElement("button");
      refreshThumbnail.className = "krc-modal-btn krc-refresh-thumbnail-button";
      refreshThumbnail.type = "button";
      refreshThumbnail.textContent = "Refresh Thumbnail";
      refreshThumbnail.title = "Re-pull the thumbnail from this LoRA's current metadata source";
      armConfirmButton(refreshThumbnail, {
        armedText: "Confirm thumbnail",
        armedTitle: "Click again to refresh the thumbnail from its recorded source",
        restoreText: "Refresh Thumbnail",
        restoreTitle: "Re-pull the thumbnail from this LoRA's current metadata source",
        timeout: 2400,
        shouldArm: () => !!current,
        onConfirm: async () => {
          refreshThumbnail.disabled = true;
          refreshThumbnail.textContent = "Refreshing...";
          const refreshed = await this.refreshThumbnailFromSource(current);
          if (refreshed?.sha256) {
            selected = refreshed;
          }
          renderModal();
        },
      });

      // Blank slate: clear ALL metadata to an empty record under a stabilized
      // (content-SHA) id. Destructive/last-resort, so it
      // sits apart from the Save/Refresh row and arms to confirm.
      const blank = document.createElement("button");
      blank.className = "krc-modal-btn krc-blank-metadata-button";
      blank.type = "button";
      blank.textContent = "Reset ID";
      blank.title = "Re-read the file, give it its own ID and clear all its metadata (last-resort fix for a stuck card)";
      blank.disabled = !current;
      armConfirmButton(blank, {
        armedText: "Confirm Reset ID",
        armedTitle: "Click again: re-read the file and clear all its metadata",
        restoreText: "Reset ID",
        restoreTitle: "Re-read the file, give it its own ID and clear all its metadata (last-resort fix for a stuck card)",
        timeout: 2400,
        shouldArm: () => !!current,
        onConfirm: async () => {
          blank.disabled = true;
          blank.textContent = "Reading…";
          const refreshed = await this.blankMetadata(current);
          if (refreshed?.sha256) {
            selected = refreshed;
          }
          renderModal();
        },
      });

      // Import metadata from a HuggingFace repo (model card, author, license).
      // Placeholder (UI-first): the paste-URL modal + fetch land in a later increment.
      const hfImport = document.createElement("button");
      hfImport.className = "krc-modal-btn krc-import-hf-button";
      hfImport.type = "button";
      hfImport.textContent = "Import from HF";
      hfImport.title = "Import metadata from a HuggingFace repo (model card, author, license)";
      hfImport.disabled = !current;
      hfImport.addEventListener("click", () => {
        this.openHfImportModal(current, {
          onImported: (refreshed) => {
            // The import reloaded the library (and may return a fresh detailed
            // record); re-render the modal from it so the new fields show.
            if (refreshed?.sha256) {
              selected = refreshed;
            }
            renderModal();
          },
        });
      });

      // Order: Reset (blank slate) far left, source actions in the middle, Save far
      // right to mirror the info panel (footer is justify-content:flex-end, so the
      // last-appended button sits rightmost).
      const verify = this.renderVerifyAction(current, { onChanged: renderModal });

      footer.append(blank, verify, civitai, hfImport, refreshThumbnail, save);
      refreshHeaderBadge();
    };

    modal = openKrcModal({
      node: this.node,
      title: "More Info",
      body: this.renderMoreInfoBody(selected, { onEdited: refreshModalEditState }),
      footer,
      width: MORE_INFO_MODAL_WIDTH,
      height: MORE_INFO_MODAL_HEIGHT,
      resizable: true,
      onClose: () => {
        this._moreInfoModalOpen = false;
        if (badgeFrame) {
          cancelAnimationFrame(badgeFrame);
          badgeFrame = 0;
        }
        // Reconcile the info panel with any edits made in the modal, once.
        syncInfoPanel();
      },
    });
    headerBadgeSlot = document.createElement("div");
    headerBadgeSlot.className = "krc-modal-modified-slot krc-modal-header-badge-slot";
    modal.head.insertBefore(headerBadgeSlot, modal.head.querySelector(".krc-modal-x"));
    renderModal();
  },
};
