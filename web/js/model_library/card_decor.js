import { applyCardColorStyle } from "../shared/card_colors.js";

// Live per-card decoration helpers, extracted from the (removed) stack_view.js clone.
// The browser and info panel call these on every card; they have no stack/preset
// dependencies — applyCardColor uses the shared card-color styler + the panel's
// effectiveLoraCardColor. Mixed into the panel prototype in panel.js.
export const cardDecorMethods = {
  applyCardColor(element, lora = {}, selected = false) {
    applyCardColorStyle(element, this.effectiveLoraCardColor?.(lora) || lora.cardColor || "", { selected });
  },
};
