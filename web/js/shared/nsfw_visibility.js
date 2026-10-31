// The shared visibility policy. Consumers supply their effective global/local
// settings and, for prompts, the category's NSFW flag as part of the item flag.
export function nsfwDisplayState(item, { showNsfw = false, displayMode = "hide" } = {}) {
  const restricted = Boolean(item?.nsfw) && !showNsfw;
  return {
    hidden: restricted && displayMode !== "blur",
    blurred: restricted && displayMode === "blur",
  };
}
