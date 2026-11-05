// Per-field Modified state, shared: which of a node's fields differ from their saved
// values (changedFields), the small orange dot on each (markModifiedFields), and the rows
// the Modified badge's hover card lists (shared/change_list.js changeRows). A view of
// state the node already keeps: nothing new is saved. The dots and the list read the same
// descriptor, so they never disagree.
//
// A node describes its fields once:
//   {
//     fields,              // the fields to check (any shape the node uses)
//     current(field),      // the value now
//     saved(field),        // the saved value; undefined = the field isn't saved yet
//     same(a, b, field),   // optional; default compares stableSignature()
//     element(field),      // dots: where the dot goes (null = no dot for it)
//     inline(field),       // dots, optional: true = the dot follows the element's text
//                          //   (a label), else it's pinned to the element's right end
//                          //   (the element must be positioned)
//     title(field, saved), // dots, optional tooltip; default from text(): "Modified
//                          //   (saved: 24)", or "Modified" for long text
//     label(field),        // change list: the field's name
//     text(field, value),  // change list, optional: a value as shown; null = long
//                          //   text, listed as just "Changed"
//   }
import { stableSignature } from "./local_status.js";

export const MODIFIED_DOT_CLASS = "krc-modified-dot";

const sameSignature = (a, b) => stableSignature(a) === stableSignature(b);

// -> [{ field, saved }] for each field that differs (saved undefined = not saved yet).
export function changedFields(descriptor) {
  const { fields = [], current, saved, same = sameSignature } = descriptor;
  const changed = [];
  for (const field of fields) {
    const was = saved(field);
    if (was === undefined || !same(current(field), was, field)) changed.push({ field, saved: was });
  }
  return changed;
}

export function setFieldModified(element, modified, title = "Modified", { inline = false } = {}) {
  if (!element) return;
  let dot = [...element.children].find((child) => child.classList?.contains(MODIFIED_DOT_CLASS));
  if (!modified) {
    dot?.remove();
    return;
  }
  if (!dot) {
    dot = document.createElement("span");
    element.appendChild(dot);
  }
  dot.className = MODIFIED_DOT_CLASS + (inline ? " is-inline" : "");
  dot.title = title;
}

const DOT_TEXT_MAX = 48;

// A dot tooltip naming the saved value as shown: "Modified (saved: 24)", cut at 48
// characters; null (long text) = just "Modified".
export function savedValueTitle(text) {
  if (text === null || text === undefined) return "Modified";
  const shown = text.length > DOT_TEXT_MAX ? `${text.slice(0, DOT_TEXT_MAX - 1)}…` : text;
  return `Modified (saved: ${shown || "empty"})`;
}

// The default dot tooltip: the saved value via the descriptor's text().
function defaultTitle(descriptor, field, saved) {
  if (saved === undefined) return "Modified (not saved yet)";
  return savedValueTitle(descriptor.text ? descriptor.text(field, saved) : String(saved ?? ""));
}

// Dot every changed field, clear the rest. { enabled: false } clears every dot (clean,
// Stale, ...). -> how many fields are marked.
export function markModifiedFields(descriptor, { enabled = true } = {}) {
  const { fields = [], element, title, inline } = descriptor;
  const changed = new Map(enabled ? changedFields(descriptor).map((entry) => [entry.field, entry]) : []);
  for (const field of fields) {
    const entry = changed.get(field);
    const tip = entry ? (title ? title(field, entry.saved) : defaultTitle(descriptor, field, entry.saved)) : "";
    setFieldModified(element(field), Boolean(entry), tip || "Modified",
      { inline: Boolean(inline?.(field)) });
  }
  return changed.size;
}
