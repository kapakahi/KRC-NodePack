// Provider-neutral, explicit-value attribute execution. Providers perform one
// atomic write; errors retain the selection for an idempotent retry.
import { normalizeCustomBadge } from "./card_context_menu.js";
import { CARD_COLOR_PALETTE } from "./card_colors.js";

export function bulkAttributeState(items, read, field) {
  const values = items.map((item) => read(item, field) ?? (field === "cardColor" || field === "customBadge" ? "" : false));
  return { value: values[0], mixed: values.some((value) => value !== values[0]), any: values.some(Boolean) };
}

export function normalizeBulkAttribute(field, value, count) {
  if (["favorite", "pinned", "nsfw"].includes(field)) {
    if (typeof value !== "boolean") throw new Error("Choose Set or Clear.");
    if (field === "pinned" && value && count > 5) throw new Error("Pinning is limited to 5 selected cards. Unpinning remains available.");
  } else if (field === "customBadge") {
    if (typeof value !== "string" || normalizeCustomBadge(value) === null) throw new Error("Invalid custom badge.");
    value = normalizeCustomBadge(value);
  } else if (field === "cardColor") {
    if (value !== "" && !CARD_COLOR_PALETTE.some((color) => color.id === value)) throw new Error("Unknown card color.");
  } else throw new Error("Unsupported bulk attribute.");
  return value;
}

export async function executeBulkAttribute(controller, adapter, field, value) {
  if (controller.status().busy) return { ok: false, error: "An operation is already running." };
  let started = false;
  try {
    controller.refresh();
    const state = controller.snapshot();
    if (!state.active || !state.count) throw new Error("Select at least one card.");
    value = normalizeBulkAttribute(field, value, state.count);
    const ids = controller.beginOperation(); started = true;
    const result = await adapter.apply(ids, field, value);
    if (!result || result.ok === false || result.success === false) throw new Error(result?.error || "Could not save attributes.");
    controller.finishOperation(); started = false;
    return { ...result, ok: true };
  } catch (error) {
    if (started) controller.finishOperation({ exit: false });
    return { ok: false, error: String(error?.message || error) };
  }
}
