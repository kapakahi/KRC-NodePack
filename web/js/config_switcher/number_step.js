// The − / + buttons on a Config Switcher number field. Pure (no app import) so it's tested.
//
// Step: Integer 1; Float 0.1; Auto 0.1 when the value is written with a decimal point,
// else 1 (Auto emits a whole number as an integer, so `5` must not turn into `5.1`).
// The result keeps the value's decimal places (at least the step's), so binary float
// noise (1.6 - 0.1 = 1.5000000000000002) never reaches the field, and `1.0` stays a float.

function decimalsOf(text) {
  const match = String(text).trim().match(/\.(\d*)/);
  return match ? match[1].length : 0;
}

export function numberStepFor(text, mode = "auto") {
  if (mode === "integer") return 1;
  if (mode === "float") return 0.1;
  return String(text ?? "").includes(".") ? 0.1 : 1;
}

// `text` stepped once in `direction` (+1 / -1) → the new field text.
export function stepNumberText(text, direction, mode = "auto") {
  const raw = String(text ?? "").trim();
  const step = numberStepFor(raw, mode);
  const current = mode === "integer" ? Number.parseInt(raw, 10) : Number.parseFloat(raw);
  const base = Number.isFinite(current) ? current : 0;
  const next = base + Math.sign(direction || 1) * step;
  if (mode === "integer") return String(Math.round(next));
  const decimals = Math.max(Number.isFinite(current) ? decimalsOf(raw) : 0, decimalsOf(String(step)));
  const fixed = next.toFixed(decimals);
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;   // never "-0.0"
}
