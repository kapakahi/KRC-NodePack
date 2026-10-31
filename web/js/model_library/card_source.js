/*
 * KRC Model Library — card source: the card ItemSource descriptor (notch menu, drag
 * payload), the Fetch-from sub-view, and rendering / refreshing a card.
 * Mixed onto the panel prototype (panel.js) right after browserMethods.
 */
import { refreshBrowserCard } from "../shared/browser_cards.js";
import { clearKrcDragPayload, setKrcDragPayload } from "../shared/drag_payload.js";
import { el, queryDataAttrAny } from "../shared/dom.js";
import { renderModelCard } from "../shared/model_card.js";
import { createModelBrowserCardSource } from "../shared/model_browser_card_source.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";
import { closeFloatingMenu } from "../shared/floating_menu.js";

export const cardSourceMethods = {
  // Sub-view for a non-LoRA card's "Fetch": a back button and the two sources. Civitai
  // fetches by hash; HuggingFace opens the same repo prompt as More Info's "Import from
  // HF". Styled like Prompt Vault's "Move to…" sub-view.
  renderFetchSourcePicker(lora, setMode, stableId) {
    const wrap = el("div", "krc-card-menu-move krc-card-menu-fetch");
    const back = el("button", "krc-card-menu-mode-back", { textContent: "‹", title: "Back" });
    back.type = "button";
    back.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      setMode("quick");
    });
    const head = el("div", "krc-card-menu-move-head");
    head.append(back, el("span", "krc-card-menu-move-title", { textContent: "Fetch from…" }));
    const list = el("div", "krc-card-menu-move-list");
    const source = (label, title, onPick) => {
      const row = el("button", "krc-card-menu-move-item", { type: "button", title });
      row.append(el("span", "krc-card-menu-move-name", { textContent: label }));
      row.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        // Consent gate first: off means no request and no prompt.
        if (!isNetworkAllowed()) {
          notifyNetworkDisabled();
          return;
        }
        closeFloatingMenu();
        onPick();
      });
      return row;
    };
    list.append(
      source("Civitai", stableId ? "Fetch metadata from Civitai by hash" : "Compute a stable hash, then fetch from Civitai",
        () => this.fetchCivitaiMetadata(lora)),
      source("HuggingFace…", "Import metadata from a HuggingFace repo (model card, author, license)",
        () => this.openHfImportModal(lora)),
    );
    wrap.append(head, list);
    return wrap;
  },

  // ItemSource descriptor for the Layer-1 card primitive. Bound once; seams read
  // this.selectedSha / draggedSha / pinned live. Same as LoRA Loadout's except the
  // drag payload (built in the installInteractions hook) is generic-model-aware via
  // isGenericModel: a generic model drags as kind "model" and omits the lora-only
  // x-krc-lora type.
  cardSource() {
    if (this._cardSource) return this._cardSource;
    const ctl = this;
    this._cardSource = createModelBrowserCardSource(ctl, {
      notchMenu: (lora, key) => {
        const isGeneric = ctl.isGenericModel?.(lora);
        const stableId = key && !String(key).startsWith("local-");
        const canStabilize = !!isGeneric && key && !stableId;
        const label = isGeneric ? "model" : "LoRA";
        return {
          context: "browser",
          kind: isGeneric ? "model" : "lora",
          id: key,
          title: ctl.browserLabel(lora) || label,
          quickActions: {
            color: {
              value: ctl.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
              title: isGeneric ? "Model color" : "LoRA color",
              onChange: (value) => ctl.setLoraCardColor(lora, value),
            },
            customBadge: {
              visible: true,
              active: !!lora.customBadge,
              value: lora.customBadge || "",
              title: "Letters, numbers, spaces. 10 max.",
              onSave: (value) => ctl.setLoraCustomBadge(lora, value),
            },
            favorite: {
              active: !!lora.favorite,
              title: lora.favorite ? "Remove favorite tag" : "Mark as favorite",
              onToggle: () => ctl.toggleFavorite(lora),
            },
            pin: {
              active: !!lora.pinned,
              title: lora.pinned ? "Unpin from top" : "Pin to top",
              onToggle: () => ctl.togglePin(lora),
            },
            nsfw: {
              active: !!lora.nsfw,
              title: lora.nsfw ? "Remove NSFW tag" : "Tag as NSFW",
              onToggle: () => ctl.toggleNsfw(lora),
            },
          },
          actions: [
            { id: "rename", icon: "✎", label: "Rename", title: `Rename this ${label}`, mode: "rename" },
            {
              id: "fetch",
              icon: "⬇︎",
              label: "Fetch",
              title: isGeneric ? "Fetch metadata from Civitai or HuggingFace"
                : !stableId ? "Compute a stable hash, then fetch from Civitai"
                : "Fetch metadata from Civitai — fills empty fields, keeps the ones you set",
              disabled: !key,
              // A LoRA fetches from Civitai straight away; any other model picks its
              // source first (the "fetch" sub-view below), like the info panel's Fetch.
              ...(isGeneric ? { mode: "fetch" } : {
                onClick: async () => {
                  if (!isNetworkAllowed()) {
                    notifyNetworkDisabled();
                    return false;
                  }
                  await ctl.fetchCivitaiMetadata(lora);
                },
              }),
            },
            {
              id: "stabilize",
              icon: "S",
              label: "Stabilize",
              title: "Create a stable SHA256 ID for this model",
              visible: canStabilize,
              confirm: true,
              confirmLabel: "Stabilize?",
              onClick: () => {
                ctl.selectLora(lora.sha256);
                return ctl.stabilizeSelected(lora.sha256, { manual: true });
              },
            },
            {
              id: "copy-sha",
              icon: "#",
              label: "Copy SHA ID",
              title: stableId ? "Copy full hash id" : `Stabilize this ${label} ID before copying a full hash`,
              disabled: !stableId,
              onClick: () => ctl.copyText(key),
            },
            {
              id: "more-info",
              icon: "i",
              label: "More Info",
              title: "More Info",
              onClick: () => ctl.openMoreInfoModal(lora),
            },
          ],
          rename: {
            value: lora.display_name || "",
            placeholder: "Name",
            title: isGeneric ? "Model name" : "LoRA name",
            normalize: (value) => {
              const name = String(value || "").trim();
              return name ? name : null;
            },
            onSave: (value) => ctl.renameLoraCard(lora, value),
          },
          modes: {
            fetch: (_config, _context, setMode) => ctl.renderFetchSourcePicker(lora, setMode, stableId),
          },
        };
      },
      installInteractions: (card, lora) => {
        if (ctl.draggedSha === lora.sha256) card.classList.add("is-dragging");
        if (lora.pinned) card.classList.add("is-pinned");
        card.draggable = true;
        card.addEventListener("dragstart", (event) => {
          const isGeneric = ctl.isGenericModel?.(lora);
          const dragSha = ctl.canonicalId?.(lora.sha256) || lora.sha256;
          const thumbUrl = lora.thumbnail
            ? ctl.thumbnailUrl(lora, lora.thumbnailType === "video" && lora.thumbnailHasPoster ? "poster" : "")
            : "";
          const payload = {
            kind: isGeneric ? "model" : "lora",
            id: dragSha,
            modelType: lora.modelType || "",
            path: lora.path || "",
            relativePath: lora.relativePath || lora.relative_path || "",
            file: lora.filename || "",
            title: lora.display_name || lora.filename || "",
            thumbnailUrl: thumbUrl,
            cardColor: ctl.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
            customBadge: lora.customBadge || "",
            favorite: Boolean(lora.favorite),
            nsfw: Boolean(lora.nsfw),
          };
          clearTimeout(ctl._stabilizeTimer);
          ctl.draggedSha = lora.sha256;
          card.classList.add("is-dragging");
          ctl.root.classList.add("is-dragging-lora");
          setKrcDragPayload(payload);
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData("application/x-krc-model", JSON.stringify(payload));
          if (!isGeneric) {
            event.dataTransfer.setData("application/x-krc-lora", dragSha);
          }
          event.dataTransfer.setData("text/plain", dragSha);
        });
        card.addEventListener("dragend", () => {
          ctl.draggedSha = "";
          ctl.root.classList.remove("is-dragging-lora");
          card.classList.remove("is-dragging");
          clearKrcDragPayload();
          ctl.scheduleStabilize?.(ctl.selectedSha);
        });
        card.addEventListener("click", () => {
          ctl.selectLora(lora.sha256);
        });
      },
    });
    return this._cardSource;
  },

  renderLoraCard(lora) {
    return renderModelCard(lora, this.cardSource());
  },

  refreshLoraCard(sha256) {
    const card = queryDataAttrAny([this.pickerPortal, this.root], ".krc-lora-card", "data-lora-sha", sha256);
    const virtualList = card?.closest?.(".krc-lora-list.is-virtualized");
    if (virtualList) {
      // The shared virtual list re-reads visibleLoras() live on every update, and
      // updateLibraryLora invalidates that memo — so dropping the stale card from the
      // cache and updating is enough to re-render it from the fresh object (no snapshot
      // swap needed, as when the old state.items snapshot could keep a just-uploaded
      // video's old thumbnailType and fail its variant into a placeholder).
      this._loraCardCache?.delete?.(sha256);
      this.updateVirtualLoraList(virtualList);
      return true;
    }
    refreshBrowserCard({
      key: sha256,
      replace: true,
      findCard: () => card,
      findItem: (key) => this.loras.find((item) => this.keyOf(item) === key),
      renderCard: (lora) => this.renderLoraCard(lora),
    });
  },
};
