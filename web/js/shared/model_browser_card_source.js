import { stabilizeDot } from "./stabilize_glow.js";

// Shared card-source hooks for the model/LoRA browser family — the Model Library
// and LoRA Loadout *browsers*. These ten hooks were byte-identical in both nodes
// (they encode the "models/LoRA provider" contract), so they live here once. The
// two hooks that genuinely diverge — notchMenu and installInteractions — are passed
// in per node via `overrides` and win over anything here (spread last).
//
// Contract: `ctl` (the browser view) must implement:
//   keyOf(item), selectedSha, isMetadataModified?(item), pinned[] (array),
//   effectiveLoraCardColor?(item), thumbnailUrl(item, variant?), shouldBlurNsfw?(item),
//   browserLabel(item), renderModifiedBadge(), _stabilizing? (key being hashed).
//
// NOT a consumer: the LoRA Loadout preset *slot* (stack_view.js). It is only a
// partial member of this family — it intentionally omits isModified/isPinned and
// carries slot-specific renderLeading/renderTrailing/installInteractions — so it
// keeps its own hand-built source. See CARD_BROWSER_CONSOLIDATION_GAMEPLAN.md (D).
export function createModelBrowserCardSource(ctl, overrides = {}) {
  return {
    keyOf: (lora) => ctl.keyOf(lora),
    setCardKey: (card, lora) => { card.dataset.loraSha = ctl.keyOf(lora); },
    isSelected: (lora) => ctl.selectedSha === ctl.keyOf(lora),
    isModified: (lora) => Boolean(ctl.isMetadataModified?.(lora)),
    isPinned: (lora) => !!lora.pinned,
    cardColor: (lora) => ctl.effectiveLoraCardColor?.(lora) || lora.cardColor || "",
    // hasNotch omitted: framework default shows the notch on every card.
    resolveThumbnail: (lora) => {
      const isVideoThumb = lora.thumbnailType === "video";
      return {
        previewVideoUrl: lora.thumbnail && isVideoThumb ? ctl.thumbnailUrl(lora, "animated") : "",
        url: lora.thumbnail && isVideoThumb && lora.thumbnailHasPoster
          ? ctl.thumbnailUrl(lora, "poster")
          : (lora.thumbnail && !isVideoThumb ? ctl.thumbnailUrl(lora) : ""),
        placeholderKind: lora.previewWithheld && !lora.thumbnail
          ? "nsfw"
          : (lora.thumbnailNeedsPoster || isVideoThumb ? "video" : "image"),
        blurred: ctl.shouldBlurNsfw?.(lora),
      };
    },
    nameText: (lora) => ctl.browserLabel(lora),
    subtitleText: (lora) => lora.baseModel || lora.category || "untagged",
    fillBadgeRow: (row, lora, modified) => {
      let count = 0;
      // Leads the row while this card's SHA256 is computed in the background.
      if (ctl._stabilizing && ctl._stabilizing === ctl.keyOf(lora)) {
        row.append(stabilizeDot());
        count++;
      }
      if (lora.favorite) {
        const star = document.createElement("span");
        star.className = "krc-badge-star";
        star.textContent = "★";
        row.append(star);
        count++;
      }
      if (lora.nsfw) {
        const nsfwBadge = document.createElement("span");
        nsfwBadge.className = "krc-card-badge krc-nsfw-badge";
        nsfwBadge.textContent = "NSFW";
        row.append(nsfwBadge);
        count++;
      }
      if (lora.customBadge) {
        const customBadge = document.createElement("span");
        customBadge.className = "krc-card-badge is-json";
        customBadge.textContent = lora.customBadge;
        row.append(customBadge);
        count++;
      }
      if ((lora.duplicateCount || 0) > 1) {
        const dupeBadge = document.createElement("span");
        dupeBadge.className = "krc-card-badge krc-duplicate-badge";
        dupeBadge.textContent = "DUPLICATE";
        dupeBadge.title = `${lora.duplicateCount} copies of this LoRA on disk`;
        row.append(dupeBadge);
        count++;
      }
      if (modified) {
        row.append(ctl.renderModifiedBadge());
        count++;
      }
      return count;
    },
    ...overrides,
  };
}
