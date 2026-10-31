// `has:` / `missing:` for model items, shared by LoRA Loadout and the Model Library (one
// alias table, one search hint, so a LoRA matches the same in both). Pure: no DOM.
//
//   has:thumb  has:animated  has:badge  has:favorite  has:metadata  has:file
//   missing:…  the same words, for items without it (missing:file = the file is gone)
//
// "metadata" means fetched from Civitai or Hugging Face (an original name, version or
// creator came with it).

const PRESENCE = [
  ["thumb thumbnail", (item) => !!item.thumbnail],
  ["animated", (item) => !!item.thumbnailHasAnimation],
  ["badge", (item) => !!item.customBadge],
  ["favorite", (item) => !!item.favorite],
  ["metadata", (item) => !!(item.originalName || item.version || item.creator?.username)],
  ["file", (item) => !item.unavailable],
];

// The words `has:` (present = true) or `missing:` (present = false) searches for an item.
export function modelPresenceText(item, present) {
  return PRESENCE.filter(([, test]) => test(item || {}) === present).map(([words]) => words).join(" ");
}
