// KRC boot-settled signal (Perceived Loading gameplan, Stage 5).
//
// A one-shot, app-wide "the initial boot has settled" flag. Source panels
// (LoRA Loadout / Model Library / Prompt Vault) call markKrcBootSettled() once
// their first library load completes; consumers that must not act mid-boot —
// currently Config Switcher's external-card refresh — subscribe via
// onKrcBootSettled() to act once it fires.
//
// It is a settle signal, not a readiness gate: it only ever flips false → true,
// once per page. A bounded fallback timer guarantees it settles even in a graph
// with no source panels at all (e.g. a lone Config Switcher), so a gated control
// can never stay disabled forever.

let settled = false;
const listeners = new Set();
let fallbackTimer = null;

const FALLBACK_MS = 6000;

function armFallback() {
  if (settled || fallbackTimer !== null) return;
  fallbackTimer = setTimeout(markKrcBootSettled, FALLBACK_MS);
}

// Arm the safety net as soon as the module is first imported (app boot), so the
// signal settles on its own even if no source panel ever reports a load.
armFallback();

export function markKrcBootSettled() {
  if (settled) return;
  settled = true;
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // A listener throwing must not block the others.
    }
  }
  listeners.clear();
}

export function onKrcBootSettled(fn) {
  if (typeof fn !== "function") return () => {};
  if (settled) {
    try {
      fn();
    } catch {
      // ignore
    }
    return () => {};
  }
  listeners.add(fn);
  armFallback();
  return () => listeners.delete(fn);
}
