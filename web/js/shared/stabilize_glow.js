// Shared hash-field stabilization glow, used by the LoRA Loadout and Model Library
// InfoPanels so an in-flight SHA256 extraction is indicated identically in both. Importing
// this module also loads its stylesheet, so a consumer only needs the JS import.

import { ensureStylesheet } from "./stylesheets.js";

ensureStylesheet("krc-stabilize-glow-css", "./stabilize_glow.css", import.meta.url, { version: "0.2.1-tokens" });

export const STABILIZE_GLOW_CLASS = "is-stabilizing";

// The browser card's "stabilizing" pip: leads the card's badge row while its SHA256 is
// computed in the background (same green as the hash-field glow).
export function stabilizeDot() {
  const dot = document.createElement("span");
  dot.className = "krc-card-stabilize-dot";
  dot.title = "Extracting SHA256…";
  dot.setAttribute("aria-label", "Extracting SHA256");
  return dot;
}

// Toggle the glow on a hash-field (.krc-sha) element, with a matching aria-busy state and
// an "extracting" tooltip while active (restored on clear). Safe with a missing element.
export function applyStabilizeGlow(shaEl, active, { title = "Extracting SHA256…" } = {}) {
  if (!shaEl) return;
  const on = !!active;
  shaEl.classList.toggle(STABILIZE_GLOW_CLASS, on);
  if (on) {
    shaEl.setAttribute("aria-busy", "true");
    if (!("krcTitleBefore" in shaEl.dataset)) {
      shaEl.dataset.krcTitleBefore = shaEl.getAttribute("title") || "";
    }
    shaEl.setAttribute("title", title);
  } else {
    shaEl.removeAttribute("aria-busy");
    if ("krcTitleBefore" in shaEl.dataset) {
      const prev = shaEl.dataset.krcTitleBefore;
      if (prev) shaEl.setAttribute("title", prev);
      else shaEl.removeAttribute("title");
      delete shaEl.dataset.krcTitleBefore;
    }
  }
}
