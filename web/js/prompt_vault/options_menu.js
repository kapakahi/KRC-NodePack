/*
 * KRC Prompt Vault — options menu.
 * Options: the config menu button, the per-node Options modal and the reset-edits escape
 * hatch.
 * Mixed onto PMRedesign.prototype via Object.assign.
 */
import { switchToggle } from "../shared/browser_controls.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { krcModalSection, openKrcModal } from "../shared/modal.js";
import { KRC_SYNC_EVENTS } from "../shared/sync_bus.js";
import { nodeTransferRow } from "../shared/transfer/node_transfer_row.js";
import { buildNodePaletteField, portalPaletteNote } from "../shared/node_palette.js";
import { el } from "./dom.js";
import { loadPvKitsOnce, _pvKits } from "./preset_fields.js";

export const optionsMenuMethods = {
  renderConfigMenu() {
    const wrap = el("div", "krc-io-wrap");
    const btn = el("button", "krc-io-button", { title: "Options" });
    btn.setAttribute("aria-label", "Options");
    btn.append(el("span", "krc-gear-glyph"));
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openKrcModal({
        node: this.node,
        title: "Prompt Vault options",
        body: [
          ...(this.surface === "detached" ? [] : [krcModalSection({
            title: "Profile",
            body: this.renderProfileControl(),
          })]),
          krcModalSection({
            title: "Editor",
            body: this.renderEditorOptionsControl(),
          }),
          krcModalSection({
            // The vault as a KRC bundle section (one category: its chip's ▸ EXPORT).
            body: nodeTransferRow({
              promptProfile: () => this.effectiveProfileId(),
              node: this.node,
              sections: ["prompt_vault"],
              label: "prompts",
              sources: { [KRC_SYNC_EVENTS.PROMPTS_CHANGED]: this._pvSyncSource },
              onImported: () => this.reload(),
            }),
          }),
          krcModalSection({
            title: "Appearance",
            body: (() => {
              const wrap = el("div", "krc-options-appearance");
              wrap.append(switchToggle({
                label: "Show thumbnails in list view",
                active: !!this.listThumbs,
                title: "Show a small thumbnail on each card in the list view.",
                onClick: (toggleEvent) => {
                  this.setListThumbs(!this.listThumbs);
                  toggleEvent.currentTarget?.classList.toggle("is-on", !!this.listThumbs);
                },
              }));
              // In the Portal the palette is the Portal's own (Options ▸ Appearance).
              wrap.append(this.surface === "detached"
                ? portalPaletteNote()
                : buildNodePaletteField({ node: this.node, root: this.root }));
              return wrap;
            })(),
          }),
          krcModalSection({
            title: "Troubleshooting",
            body: this.renderResetEditsControl(),
          }),
        ],
      });
    });
    wrap.append(btn);
    return wrap;
  },

  renderEditorOptionsControl() {
    const wrap = el("div", "krc-options-editor");
    const toggle = switchToggle({
      label: "Include Prompt B during Find/Replace",
      active: this.replacePromptBEnabled?.(),
      title: "Replace matching whole words.",
      onClick: () => {
        const next = !this.replacePromptBEnabled?.();
        this.setReplacePromptBEnabled?.(next);
        toggle.classList.toggle("is-on", next);
      },
    });
    const desc = el("div", "krc-options-description", {
      textContent: "When enabled, replacements also affect Prompt B.",
    });
    wrap.append(toggle, desc);

    const newEmptyToggle = switchToggle({
      label: "Use --empty-- for new prompts",
      active: this.newPromptEmptyPresetEnabled?.(),
      title: "Start new prompts with the --empty-- LoRA Loadout preset selected",
      onClick: () => {
        const next = !this.newPromptEmptyPresetEnabled?.();
        this.setNewPromptEmptyPreset?.(next);
        newEmptyToggle.classList.toggle("is-on", next);
      },
    });
    const newEmptyDesc = el("div", "krc-options-description", {
      textContent: "New prompts start with --empty-- selected, so picking one clears the LoRA Loadout it drives by default.",
    });
    wrap.append(newEmptyToggle, newEmptyDesc);

    // "Disable Input on Swap" governs the node's prompt INPUT socket on a workflow
    // run — meaningless in the detached portal (no node), so omit it there.
    if (this.surface !== "detached") {
      const swapToggle = switchToggle({
        label: "Disable Input on Swap",
        active: this.promptInputDisableOnSwap?.(),
        title: "Turn off prompt INPUT after swapping Prompt A and Prompt B",
        onClick: () => {
          const next = !this.promptInputDisableOnSwap?.();
          this.setPromptInputDisableOnSwap?.(next);
          swapToggle.classList.toggle("is-on", next);
        },
      });
      const swapDesc = el("div", "krc-options-description", {
        textContent: "Turns off prompt input after swapping, so the next run does not overwrite Prompt A or B.",
      });
      wrap.append(swapToggle, swapDesc);

      const clearMissingToggle = switchToggle({
        label: "Clear loadouts when preset is missing",
        active: this.clearLoraWhenMissingEnabled?.(),
        title: "Clear the loadout when its linked LoRA Loadout or kit (e.g. RefMod) preset is missing",
        onClick: () => {
          const next = !this.clearLoraWhenMissingEnabled?.();
          this.setClearLoraWhenMissing?.(next);
          clearMissingToggle.classList.toggle("is-on", next);
        },
      });
      const clearMissingDesc = el("div", "krc-options-description", {
        textContent: "When a linked LoRA Loadout preset, or a kit row's preset (e.g. RefMod), can't be "
          + "found, that loadout clears its stack instead of leaving it as-is. Off by default.",
      });
      wrap.append(clearMissingToggle, clearMissingDesc);

      // One switch per kit that opted in (e.g. Extras' RefMod Loadout); none without one.
      const kitToggles = el("div", "krc-options-kit-rows");
      kitToggles.style.display = "contents";   // its switches sit in the Editor column's gap
      wrap.append(kitToggles);
      const fillKitToggles = () => kitToggles.replaceChildren(...this.renderKitRowToggles());
      fillKitToggles();
      if (!_pvKits.length) {
        loadPvKitsOnce({ retry: true }).then(() => {
          if (kitToggles.isConnected && _pvKits.length) fillKitToggles();
        });
      }
    }
    return wrap;
  },

  // Buried escape hatch mirroring LoRA Loadout's: clears any unsaved prompt edit and
  // resets the modified state, unsticking a phantom "modified" badge. Rare-use, so
  // it lives at the bottom of the Options modal, not in the panel.
  renderResetEditsControl() {
    const wrap = el("div", "krc-options-troubleshoot");
    const desc = el("div", "krc-options-description", {
      textContent: "Discard current unsaved edits. Fixes stuck modified states.",
    });
    const button = el("button", "krc-action-button krc-options-reset", {
      type: "button",
      textContent: "Clear unsaved edits",
    });
    armConfirmButton(button, {
      restoreText: "Clear unsaved edits",
      armedText: "Confirm — discards edits",
      onConfirm: () => {
        button.closest(".krc-modal-overlay")?._krcModalClose?.();
        this.resetPromptEditState();
      },
    });
    wrap.append(button, desc);
    return wrap;
  },
};
