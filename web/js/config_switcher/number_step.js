// The − / + buttons on a Config Switcher number field. Pure (no app import) so it's tested.
//
// Step: the field's own Step (numberStep, schema 1.7) when set; else Integer 1; Float 0.1;
// Auto 0.1 when the value is written with a decimal point, else 1 (Auto emits a whole
// number as an integer, so `5` must not turn into `5.1`).
// The result keeps the value's decimal places (at least the step's), so binary float
// noise (1.6 - 0.1 = 1.5000000000000002) never reaches the field, and `1.0` stays a float.

function decimalsOf(text) {
  const match = String(text).trim().match(/\.(\d*)/);
  return match ? match[1].length : 0;
}

// A field's own Step: a positive number (rounded to a whole one, at least 1, for Integer),
// or null for the default. Anything else (0, negative, not a number) is no step.
export function cleanNumberStep(value, mode = "auto") {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const step = Number(value);
  if (!Number.isFinite(step) || step <= 0) return null;
  return mode === "integer" ? Math.max(1, Math.round(step)) : step;
}

export function numberStepFor(text, mode = "auto", custom = null) {
  const own = cleanNumberStep(custom, mode);
  if (own !== null) return own;
  if (mode === "integer") return 1;
  if (mode === "float") return 0.1;
  return String(text ?? "").includes(".") ? 0.1 : 1;
}

// `text` stepped once in `direction` (+1 / -1) → the new field text.
export function stepNumberText(text, direction, mode = "auto", custom = null) {
  const raw = String(text ?? "").trim();
  const step = numberStepFor(raw, mode, custom);
  const current = mode === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  const base = Number.isFinite(current) ? current : 0;
  const next = base + Math.sign(direction || 1) * step;
  if (mode === "integer") return String(Math.round(next));
  const decimals = Math.max(Number.isFinite(current) ? decimalsOf(raw) : 0, decimalsOf(String(step)));
  const fixed = next.toFixed(decimals);
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;   // never "-0.0"
}

// What the Step box shows when the field has no own step.
export function defaultStepLabel(mode = "auto") {
  if (mode === "integer") return "1";
  if (mode === "float") return "0.1";
  return "1 / 0.1";
}

// The popover's example: the value, then two presses of +. "" → starts at 0.
export function stepExample(text, mode = "auto", custom = null) {
  const start = String(text ?? "").trim() || (mode === "float" ? "0.0" : "0");
  const once = stepNumberText(start, 1, mode, custom);
  return [start, once, stepNumberText(once, 1, mode, custom)].join(" → ");
}
