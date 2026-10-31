// Loadout Kit Options gear: slot appearance toggles + the node palette.
import { switchToggle } from "../browser_controls.js";
import { krcModalSection, openKrcModal } from "../modal.js";
import { buildNodePaletteField } from "../node_palette.js";
import { stopCanvasEvents } from "../dom.js";

export const controlMethods = {
  renderConfigMenu() {
    const wrap = document.createElement("div");
    wrap.className = "krc-config";

    const button = document.createElement("button");
    button.className = "krc-icon-button krc-config-button";
    button.type = "button";
    button.title = "Options";
    button.setAttribute("aria-label", "Options");
    const glyph = document.createElement("span");
    glyph.className = "krc-gear-glyph";
    button.append(glyph);
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const appearanceBody = document.createElement("div");
      appearanceBody.className = "krc-options-appearance";
      appearanceBody.append(switchToggle({
        label: "Show thumbnails in preset slots",
        active: !!this.listThumbs,
        title: "Show a small thumbnail on each preset slot.",
        onClick: (toggleEvent) => {
          this.setListThumbs(!this.listThumbs);
          toggleEvent.currentTarget?.classList.toggle("is-on", !!this.listThumbs);
        },
      }));
      appearanceBody.append(switchToggle({
        label: "Show badge row in preset slots",
        active: this.slotBadgeRow !== false,
        title: "Off = simpler slots: title only, allowed to wrap to a second line.",
        onClick: (toggleEvent) => {
          this.setSlotBadgeRow(this.slotBadgeRow === false);
          toggleEvent.currentTarget?.classList.toggle("is-on", this.slotBadgeRow !== false);
        },
      }));
      appearanceBody.append(buildNodePaletteField({ node: this.node, root: this.root }));
      openKrcModal({
        node: this.node,
        title: `${this.kit.title} options`,
        body: [krcModalSection({ title: "Appearance", body: appearanceBody })],
      });
    });
    stopCanvasEvents(button);

    wrap.append(button);
    return wrap;
  },
};
