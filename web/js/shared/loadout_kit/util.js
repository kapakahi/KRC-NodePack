// Loadout Kit small helpers (no kit imports, so any kit module can use them).

export function parseJsonArray(value, fallback = []) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function truthyPropertyValue(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}
