/*
 * KRC shared library filter/sort pass — the predicate + compare that LoRA Loadout
 * and Model Library ran over their item lists. The two nodes' `filteredLoras` /
 * `visibleLoras` were byte-identical except the primary-group predicate (LL's inline
 * disk-folder logic vs ML's `modelFolderMatch`); that lone divergence is now the
 * `groupMatch` seam — i.e. `GroupSource.matches`. Everything else (favorite / NSFW /
 * card-colour filtering, the sort-mode compare, pinned-first ordering) lives here once.
 *
 * Pure and node-agnostic: the node passes its own field-schema accessors
 * (`fieldText`, `effectiveColor`, `label`) and the group predicate.
 */
import { filterAndSortItems } from "./search.js";
import { normalizeCardColorId } from "./card_colors.js";
import { nsfwDisplayState } from "./nsfw_visibility.js";

function matchesCardColorFilter(item, colorFilter, effectiveColor) {
  if (!colorFilter) return true;
  const color = normalizeCardColorId(effectiveColor(item));
  return colorFilter === "__none__" ? !color : color === normalizeCardColorId(colorFilter);
}

// Favorite + NSFW + card-colour + primary-group. `groupMatch` is the GroupSource.matches
// seam; absent (or returning true for everything) means "no group filter active".
function libraryPredicate(item, options) {
  const {
    showFavorites = false,
    showNsfw = false,
    nsfwDisplayMode = "hide",
    colorFilter = "",
    effectiveColor = (it) => it.cardColor || "",
    groupMatch,
  } = options;
  const matchesFavorite = !showFavorites || item.favorite;
  const matchesNsfw = !nsfwDisplayState(item, { showNsfw, displayMode: nsfwDisplayMode }).hidden;
  const matchesColor = matchesCardColorFilter(item, colorFilter, effectiveColor);
  const matchesGroup = !groupMatch || groupMatch(item);
  return matchesFavorite && matchesNsfw && matchesColor && matchesGroup;
}

function libraryCompare(options) {
  const { sortMode = "alpha", label = (it) => it.name || "" } = options;
  return (a, b) => {
    if (sortMode === "date-desc") return Number(b.dateAdded || 0) - Number(a.dateAdded || 0);
    if (sortMode === "date-asc") return Number(a.dateAdded || 0) - Number(b.dateAdded || 0);
    if (sortMode === "mod-desc") return Number(b.dateModified || 0) - Number(a.dateModified || 0);
    if (sortMode === "mod-asc") return Number(a.dateModified || 0) - Number(b.dateModified || 0);
    // Usage sorts (silent per-emit ledger, joined in on read as useCount/lastUsedMs).
    // Ties fall through to the A-Z name compare below so ordering stays stable.
    if (sortMode === "used-most") {
      const diff = Number(b.useCount || 0) - Number(a.useCount || 0);
      if (diff) return diff;
    } else if (sortMode === "used-recent") {
      const diff = Number(b.lastUsedMs || 0) - Number(a.lastUsedMs || 0);
      if (diff) return diff;
    }
    const comparison = label(a).localeCompare(label(b), undefined, { sensitivity: "base" });
    return sortMode === "alpha-desc" ? -comparison : comparison;
  };
}

// Filter + sort + pinned-first — parity with the old `visibleLoras`.
export function visibleLibraryItems(items = [], options = {}) {
  return filterAndSortItems(items, {
    query: options.query || "",
    aliases: options.aliases,
    fieldText: options.fieldText,
    predicate: (item) => libraryPredicate(item, options),
    compare: libraryCompare(options),
    // Pins are a record field (shared by every node), sorted like the rest.
    isPinned: (item) => !!item?.pinned,
  });
}
