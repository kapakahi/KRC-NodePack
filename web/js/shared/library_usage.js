// Live usage counts for library items (LoRAs and models), from the server's per-run
// counter (utils/library/run_usage.py, the krc-library-usage event: {kind, usage:
// {library id: {count, lastUsedMs}}}). Display-only, like Prompt Vault's: patches the
// loaded items in place; the list isn't re-sorted (that catches up on the next refresh).

export const LIBRARY_USAGE_EVENT = "krc-library-usage";

// Patch every item whose id is in `usage`. -> how many were patched.
export function patchItemUsage(items, usage, keyOf = (item) => item?.sha256) {
  if (!usage || typeof usage !== "object") return 0;
  let patched = 0;
  for (const item of items || []) {
    const stats = usage[keyOf(item)];
    if (!stats || typeof stats !== "object") continue;
    item.useCount = Math.max(0, Number(stats.count) || 0);
    item.lastUsedMs = Math.max(0, Number(stats.lastUsedMs) || 0);
    patched += 1;
  }
  return patched;
}
