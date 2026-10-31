/*
 * KRC verification shield — the read-side glyph for a record's `verification` object
 * (schema doc §3; utils/library/metadata.py VERIFICATION_DEFAULT). Shared by the LoRA
 * Loadout + Model Library Info Panel footer and More Info modal footer.
 *
 * A record is "verified" when verification.status === "verified"; the provider picks the
 * initials inside the shield: HF (Hugging Face), CAI (Civitai), M (manual). One shield at
 * a time — verification carries a single provider. Rendered as an outlined SVG shield in
 * currentColor (white on the dark panels) so it inherits the text color and dodges the
 * emoji-zoom bug that a 🛡 glyph would hit ([[firefox-emoji-zoom-wontfix]]).
 */

const PROVIDER_META = {
  huggingface: { initials: "HF", label: "Hugging Face" },
  civitai: { initials: "CAI", label: "Civitai" },
  manual: { initials: "M", label: "manually" },
};

export function verificationProviderMeta(provider) {
  return PROVIDER_META[String(provider || "").toLowerCase()] || null;
}

// The verification object for a manual "Mark verified" action, and the cleared
// (unverified) default. Shapes mirror utils/library/metadata.py VERIFICATION_DEFAULT.
export function manualVerification(hash = "") {
  return { status: "verified", provider: "manual", hash: String(hash || ""), checkedAt: Date.now(), scannedAt: "", resultUrl: "", notes: "" };
}

export function clearedVerification() {
  return { status: "unknown", provider: "", hash: "", checkedAt: 0, scannedAt: "", resultUrl: "", notes: "" };
}

export function isVerified(verification) {
  return Boolean(
    verification
    && verification.status === "verified"
    && verificationProviderMeta(verification.provider),
  );
}

// Format either our checkedAt (millis number) or a provider scannedAt (ISO-8601 string).
function formatDateValue(value) {
  if (!value) return "";
  try {
    const date = new Date(typeof value === "number" ? value : String(value));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "";
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";

// Build the outlined shield with the provider initials centered inside.
function shieldSvg(initials) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "krc-verify-shield-svg");
  svg.setAttribute("viewBox", "0 0 28 30");
  svg.setAttribute("aria-hidden", "true");

  const path = document.createElementNS(SVG_NS, "path");
  // Classic shield: flat top, shoulders, tapering to a rounded point.
  path.setAttribute("d", "M14 1.5 L25 5 V14 C25 21.5 20.5 26.5 14 28.5 C7.5 26.5 3 21.5 3 14 V5 Z");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);

  const text = document.createElementNS(SVG_NS, "text");
  text.setAttribute("class", "krc-verify-shield-initials");
  text.setAttribute("x", "14");
  text.setAttribute("y", "15.5");
  text.setAttribute("text-anchor", "middle");
  text.setAttribute("dominant-baseline", "central");
  text.setAttribute("fill", "currentColor");
  // Fewer letters can be larger; CAI (3) is squeezed to fit the shield's width.
  text.setAttribute("font-size", initials.length >= 3 ? "10" : "13");
  text.textContent = initials;
  svg.append(text);

  return svg;
}

/**
 * Render the verification shield for a record's `verification` object, or null when the
 * record isn't verified. The caller places it to the LEFT of the KRC ID / SHA.
 */
export function renderVerificationShield(verification) {
  if (!isVerified(verification)) return null;
  const meta = verificationProviderMeta(verification.provider);

  const wrap = document.createElement("span");
  wrap.className = "krc-verify-shield";
  wrap.append(shieldSvg(meta.initials));

  const via = verification.provider === "manual"
    ? `Verified ${meta.label}`
    : `Verified by ${meta.label}`;
  // Prefer the provider's OWN scan date (Civitai scannedAt), phrased as "scanned";
  // fall back to our by-hash check date when the provider gave none.
  const scanned = formatDateValue(verification.scannedAt);
  if (scanned) {
    wrap.title = `${via} · scanned ${scanned}`;
  } else {
    const checked = formatDateValue(verification.checkedAt);
    wrap.title = checked ? `${via} · ${checked}` : via;
  }

  return wrap;
}
