/*
 * The Modified badge's change list for a loadout preset (shared/change_list.js rows):
 * LoRA Loadout's Stack A / B and a Loadout Kit's stack (RefMod Loadout) compare their
 * normalized stacks ({ sha256, order, enabled, ...values }, as their preset signatures
 * do) against the saved ones, card by card:
 *
 *   Stack A
 *     Detail Tweaker            Added
 *     Film Grain                Removed
 *     Soft Light · Strength     0.8  →  1
 *     Soft Light · Slot         2  →  4
 *     Soft Light · On           on  →  off
 */
import { missingSlotItem } from "./card_snapshots.js";

// A card's name for the list: the library record's, else its card snapshot's, else the id.
export function stackEntryName(ctl, id) {
  const canonical = (value) => ctl.canonicalId?.(value) || value;
  const record = (ctl.loras || []).find((item) => canonical(item?.sha256) === canonical(id));
  return String(record?.display_name || missingSlotItem(ctl.node, id).display_name || String(id || "").slice(0, 10));
}

/**
 * stacks: [{ group, current, saved }] normalized entries; name(id) -> a card's name;
 * values: [{ key, label, text?(value) }] the per-card settings to compare (LL: strength;
 * a kit: its fields). -> change-list rows.
 */
export function stackChangeRows({ stacks = [], name, values = [] }) {
  const rows = [];
  for (const { group = "", current = [], saved = [] } of stacks) {
    const was = new Map(saved.map((entry) => [entry.sha256, entry]));
    const now = new Map(current.map((entry) => [entry.sha256, entry]));
    for (const entry of saved) if (!now.has(entry.sha256)) rows.push({ group, label: name(entry.sha256), note: "Removed" });
    for (const entry of current) {
      const before = was.get(entry.sha256);
      const label = name(entry.sha256);
      if (!before) {
        rows.push({ group, label, note: "Added" });
        continue;
      }
      const change = (what, a, b) => rows.push({ group, label: `${label} · ${what}`, before: a, after: b });
      for (const { key, label: what, text = String } of values) {
        if (String(before[key]) !== String(entry[key])) change(what, text(before[key]), text(entry[key]));
      }
      if (before.order !== entry.order) change("Slot", String(before.order + 1), String(entry.order + 1));
      if (before.enabled !== entry.enabled) change("On", before.enabled ? "on" : "off", entry.enabled ? "on" : "off");
    }
  }
  return rows;
}
