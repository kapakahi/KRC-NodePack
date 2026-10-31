/*
 * KRC Prompt Vault — preset sync.
 * Preset sync: the ⇄ button on a preset row reads the active preset of the loadout(s) the
 * `preset` output is wired to (through reroutes and subgraphs), or offers a menu.
 * Mixed onto PMRedesign.prototype via Object.assign.
 */
import { app } from "../../../scripts/app.js";
import { closeFloatingMenu, toggleFloatingMenu } from "../shared/floating_menu.js";
import { downstreamNodes, workflowNodes } from "../shared/graph_walk.js";
import { isLoadoutOf, loadoutPresetState } from "../shared/loadout_presets.js";
import { composeTrigger } from "../shared/preset_naming.js";
import { el } from "./dom.js";
import { EMPTY_PRESET_DISPLAY, EMPTY_PRESET_LINK } from "./constants.js";

const SYNC_GLYPH = "⇄";

export const presetSyncMethods = {
  // ── Preset sync (PRESET_SYNC_GAMEPLAN.md step 3) ──────────────────────────
  // The ⇄ button on a preset row reads the active preset of the loadout(s) PV's `preset`
  // output is wired to (through reroutes and subgraphs). One connected: adopt it. Several,
  // or none: a menu of the loadouts, connected first, then the rest of the workflow.
  presetSyncButton({ kind, noun, apply }) {
    const title = `Sync from the connected ${noun}`;
    const btn = el("button", "krc-icon-button krc-pv-preset-paste krc-pv-preset-sync", { title });
    btn.type = "button";
    btn.setAttribute("aria-label", title);
    btn.dataset.idleTitle = title;
    btn.append(el("span", "krc-pv-preset-paste-glyph", { textContent: SYNC_GLYPH }));
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      this.syncPresetFromGraph({ kind, noun, apply, btn });
    });
    return btn;
  },

  syncPresetFromGraph({ kind, noun, apply, btn }) {
    if (!this.draft) return;
    const root = app.graph;
    const accept = isLoadoutOf(kind);
    // The Portal's PV has no node, so nothing is "connected" there: always the menu.
    const connected = this.surface !== "detached" && this.node?.graph
      ? downstreamNodes(this.node, "preset", accept, { root })
      : [];
    if (connected.length === 1) {
      this.adoptLoadoutPreset(connected[0], { noun, apply, btn });
      return;
    }
    const others = workflowNodes(accept, root).filter((node) => !connected.includes(node));
    if (!connected.length && !others.length) {
      this.flashSyncButton(btn, false, `No ${noun} in this workflow`);
      this.toast?.(`No ${noun} in this workflow to sync from`);
      return;
    }
    this.openPresetSyncMenu({ connected, others, noun, apply, btn });
  },

  adoptLoadoutPreset(node, { noun, apply, btn }) {
    const state = loadoutPresetState(node);
    if (state.state === "preset" && state.presetId) {
      apply(state.presetId, state.presetName);
      this.flashSyncButton(btn, true, `Synced: ${state.presetName || state.presetId}`);
      return;
    }
    if (state.state === "empty") {
      apply(EMPTY_PRESET_LINK, EMPTY_PRESET_DISPLAY);
      this.flashSyncButton(btn, true, `Synced: ${EMPTY_PRESET_DISPLAY}`);
      return;
    }
    const message = state.state === "modified" || state.state === "unsaved"
      ? `Save the preset in ${noun} first`
      : `Couldn't read ${state.title || noun}'s preset`;
    this.flashSyncButton(btn, false, message);
    this.toast?.(message);
  },

  // One line per loadout: its title and what it has active. Lines that can't be synced
  // (unsaved edits, unsaved stack, unreadable) are shown but disabled.
  openPresetSyncMenu({ connected, others, noun, apply, btn }) {
    const menu = el("div", "krc-menu-select-menu krc-pv-sync-menu");
    menu.hidden = true;
    menu.setAttribute("role", "menu");
    const section = (label, nodes) => {
      if (!nodes.length) return;
      menu.append(el("div", "krc-pv-sync-menu-head", { textContent: label }));
      for (const node of nodes) {
        const state = loadoutPresetState(node);
        const usable = (state.state === "preset" && state.presetId) || state.state === "empty";
        const detail = state.state === "preset"
          ? composeTrigger(state.presetGroup, state.presetName) || state.presetName
          : state.state === "empty" ? EMPTY_PRESET_DISPLAY
            : state.state === "modified" ? `${state.presetName || "preset"} · unsaved edits`
              : state.state === "unsaved" ? "unsaved stack" : "unreadable";
        const option = el("button", "krc-menu-select-option krc-pv-sync-option");
        option.type = "button";
        option.setAttribute("role", "menuitem");
        option.disabled = !usable;
        option.append(
          el("span", "krc-pv-sync-option-title", { textContent: state.title || noun }),
          el("span", "krc-pv-sync-option-detail", { textContent: detail }),
        );
        if (!usable) option.title = `Save the preset in ${noun} first`;
        option.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          closeFloatingMenu();
          this.adoptLoadoutPreset(node, { noun, apply, btn });
        });
        menu.append(option);
      }
    };
    section("Connected", connected);
    section(connected.length ? "Elsewhere in this workflow" : "In this workflow", others);
    toggleFloatingMenu(btn, menu, { align: "right" });
  },

  flashSyncButton(btn, ok, message) {
    if (!btn) return;
    const glyph = btn.querySelector(".krc-pv-preset-paste-glyph");
    if (glyph) glyph.textContent = ok ? "✓" : "⚠";
    btn.title = message;
    window.clearTimeout(btn._krcFlashTimer);
    btn._krcFlashTimer = window.setTimeout(() => {
      if (!btn.isConnected) return;
      if (glyph) glyph.textContent = SYNC_GLYPH;
      btn.title = btn.dataset.idleTitle || "";
    }, 1400);
  },
};
