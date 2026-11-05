/*
 * The status badges' hover card (shared/badges.js `changes`): what a Modified badge's
 * discard would throw away, as a short list, for every node with a Modified badge.
 *
 *   Flux9B A                              <- group (sticky while the list scrolls)
 *     Megapixel        0.7   →  0.8
 *     Diffusion Model  Flux9B True V3…  →  Flux9B INT8…   (cut with …, full text on hover)
 *     Prompt A         Changed            <- long text: no values
 *   Click to discard them.                <- footer: the badge's own hint
 *
 * Rows come from the same descriptors as the per-field dots (changeRows +
 * shared/modified_dot.js changedFields), so the list and the dots always agree.
 * A row is { group, label, before, after } or { group, label, note } (one plain line,
 * e.g. "Added", "Changed"). Stale / Conflict cards carry only a heading and the hint.
 */
import { changedFields } from "./modified_dot.js";

// One row per changed field of `descriptor` (see modified_dot.js), under `group`.
// A field not saved yet reads "Added"; one whose text() is null reads "Changed".
export function changeRows(descriptor, { group = "" } = {}) {
  const { current, label, text } = descriptor;
  return changedFields(descriptor).map(({ field, saved }) => {
    const name = label(field);
    if (saved === undefined) return { group, label: name, note: "Added" };
    const before = text ? text(field, saved) : String(saved ?? "");
    const after = text ? text(field, current(field)) : String(current(field) ?? "");
    return before === null || after === null
      ? { group, label: name, note: "Changed" }
      : { group, label: name, before: before || "empty", after: after || "empty" };
  });
}

function cell(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  span.title = text;   // cut with … in the card; the full text on hover
  return span;
}

// The card's content: a heading, the rows grouped in order of first appearance, and a
// footer line. -> an element, or null when there's nothing to say.
export function renderChangeList({ heading = "", rows = [], footer = "" } = {}) {
  if (!heading && !rows.length && !footer) return null;
  const root = document.createElement("div");
  root.className = "krc-change-list";
  if (heading) root.append(cell("krc-change-list-heading", heading));
  if (rows.length) {
    const scroll = document.createElement("div");
    scroll.className = "krc-change-list-scroll";
    let group = null;
    let grid = null;
    for (const row of rows) {
      if (!grid || row.group !== group) {
        group = row.group;
        if (group) scroll.append(cell("krc-change-list-group", group));
        grid = document.createElement("div");
        grid.className = "krc-change-list-grid";
        scroll.append(grid);
      }
      grid.append(cell("krc-change-list-label", row.label));
      if (row.note !== undefined) {
        grid.append(cell("krc-change-list-note", row.note));
      } else {
        const arrow = cell("krc-change-list-arrow", "→");
        arrow.removeAttribute("title");
        grid.append(cell("krc-change-list-before", row.before), arrow, cell("krc-change-list-after", row.after));
      }
    }
    root.append(scroll);
  }
  if (footer) root.append(cell("krc-change-list-foot", footer));
  return root;
}
