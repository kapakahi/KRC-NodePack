export const DEFAULT_CARD_CACHE_LIMIT = 450;

function touchCacheEntry(cache, key, value) {
  cache.delete(key);
  cache.set(key, value);
}

function trimCache(cache, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) {
    return;
  }
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      return;
    }
    cache.delete(oldestKey);
  }
}

export function resetVersionedCache(owner, cacheProp, versionProp, version) {
  if (!owner[cacheProp] || owner[versionProp] !== version) {
    owner[cacheProp] = new Map();
    owner[versionProp] = version;
  }
  return owner[cacheProp];
}

export function cachedBySignature(cache, key, signature, render, { maxEntries = DEFAULT_CARD_CACHE_LIMIT } = {}) {
  const cached = cache.get(key);
  if (cached?.signature === signature) {
    touchCacheEntry(cache, key, cached);
    return cached.card;
  }
  const card = render();
  cache.set(key, { signature, card });
  trimCache(cache, maxEntries);
  return card;
}
