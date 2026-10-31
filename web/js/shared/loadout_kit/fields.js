// Loadout Kit fields, JS side: the descriptor's field list (from the Python kit — one
// source of truth) coerced, formatted and dimmed exactly like
// utils/loadout_kit/fields.py coerces them for the loader.

const FALSE_WORDS = new Set(["", "0", "false", "no", "off", "none"]);

function decimalsOf(step) {
  const text = String(step ?? "");
  const dot = text.indexOf(".");
  return dot === -1 ? 0 : text.length - dot - 1;
}

// Shown decimals (the step's) and stored precision (at least 3, so signatures stay stable).
export function fieldDecimals(field) {
  return decimalsOf(field.step ?? 0.01);
}

function storedDecimals(field) {
  return Math.max(3, fieldDecimals(field));
}

export function coerceField(field, value) {
  switch (field.type) {
    case "float": {
      if (value === null || value === undefined || value === "") return field.default;
      const number = Number(value);
      if (!Number.isFinite(number)) return field.default;
      return Number(Math.max(field.min, Math.min(field.max, number)).toFixed(storedDecimals(field)));
    }
    case "int": {
      if (value === null || value === undefined || value === "") return field.default;
      const number = Math.round(Number(value));
      if (!Number.isFinite(number)) return field.default;
      return Math.max(field.min, Math.min(field.max, number));
    }
    case "enum":
      return field.options.includes(value) ? value : field.default;
    default:
      if (value === null || value === undefined) return field.default;
      if (typeof value === "string") return !FALSE_WORDS.has(value.trim().toLowerCase());
      return Boolean(value);
  }
}

// An entry's field values, coerced (a missing field == its default). For preset payloads
// and Modified / Stale signatures.
export function entryFieldValues(fields, entry = {}) {
  const out = {};
  for (const field of fields) out[field.key] = coerceField(field, entry?.[field.key]);
  return out;
}

export function formatField(field, value) {
  const coerced = coerceField(field, value);
  switch (field.type) {
    case "float":
      return coerced.toFixed(fieldDecimals(field));
    case "int":
      return String(coerced);
    case "enum":
      return coerced;
    default:
      return coerced ? "on" : "off";
  }
}

// dim_when: { otherKey: [values] } — dimmed while another field holds one of the values.
export function isFieldDimmed(field, fields, entry) {
  const rules = field.dimWhen;
  if (!rules) return false;
  return Object.entries(rules).some(([otherKey, values]) => {
    const other = fields.find((item) => item.key === otherKey);
    return other ? values.includes(String(coerceField(other, entry?.[otherKey]))) : false;
  });
}

// Typing filters for the numeric popover: digits, one dot (floats), a leading minus only
// when the range allows negatives.
export function sanitizeFieldInput(field, value) {
  const allowMinus = field.min < 0;
  let text = String(value ?? "");
  const negative = allowMinus && text.trim().startsWith("-");
  text = text.replace(field.type === "float" ? /[^\d.]/g : /\D/g, "");
  if (field.type === "float") {
    const dot = text.indexOf(".");
    if (dot !== -1) text = `${text.slice(0, dot + 1)}${text.slice(dot + 1).replace(/\./g, "")}`;
  }
  return negative ? `-${text}` : text;
}
