// The preset link: what Prompt Vault's `preset` output sends to the loadouts
// (PRESET_LINK_GAMEPLAN.md, dev repo). A KRC_PRESET wire carries preset ids, never names,
// one entry per loadout it drives:
//
//   {v: 1, missing: "keep" | "clear", targets: {lora: {id, rev}, "<kit id>": {id, rev}}}
//
// id "" is the blank slate (--empty--); no entry means "no opinion" (the loadout keeps its
// stacks); rev is the preset's `modified` stamp (0 for empty or unknown); missing says what
// a loadout does with an id it can't find. Anything that isn't a version-1 link reads as
// no link, a malformed target as no entry. Mirrors utils/preset_link.py; linkSignature is
// byte-identical to Python's link_signature.

export const PRESET_LINK_TYPE = "KRC_PRESET";
export const PRESET_LINK_VERSION = 1;

// LoRA Loadout's target (both nodes). Kit ids can never be "lora".
export const LORA_TARGET = "lora";

export const MISSING_KEEP = "keep";
export const MISSING_CLEAR = "clear";
const MISSING = new Set([MISSING_KEEP, MISSING_CLEAR]);

// The stored "--empty--" link in a Prompt Vault record. Storage only: on the wire it is "".
export const STORED_EMPTY = "none:empty";

const TARGET_RE = /^[a-z][a-z0-9_]{1,47}$/;
// Printable ASCII without spaces, up to 200 (preset ids are uuid4 hex).
const ID_RE = /^[\x21-\x7e]{0,200}$/;
const ASCII_SPACE_RE = /^[ \t\r\n]+|[ \t\r\n]+$/g;

function cleanId(value) {
  if (typeof value !== "string") return null;
  const id = value.replace(ASCII_SPACE_RE, "");
  return ID_RE.test(id) ? id : null;
}

// A whole number in 0..2^53-1; only real numbers count (no strings, no booleans).
function cleanRev(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  const rev = Math.trunc(value);
  return rev > 0 && rev <= Number.MAX_SAFE_INTEGER ? rev : 0;
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const id = cleanId(entry.id);
  if (id === null) return null;
  return { id, rev: id ? cleanRev(entry.rev) : 0 };
}

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// {key: {id, rev}} -> a link. An entry whose id is null/undefined is left out (no opinion);
// invalid keys and ids are dropped. Keys are sorted, so the object serializes canonically.
export function buildLink(targets, missing = MISSING_KEEP) {
  const out = {};
  const source = isPlainObject(targets) ? targets : {};
  for (const key of Object.keys(source).sort()) {
    if (!TARGET_RE.test(key)) continue;
    const clean = cleanEntry(source[key]);
    if (clean) out[key] = clean;
  }
  return { missing: MISSING.has(missing) ? missing : MISSING_KEEP, targets: out, v: PRESET_LINK_VERSION };
}

// A link in canonical form, or null when the value isn't a version-1 link.
export function normalizeLink(value) {
  if (!isPlainObject(value) || value.v !== PRESET_LINK_VERSION) return null;
  if (!isPlainObject(value.targets)) return null;
  return buildLink(value.targets, value.missing);
}

// {id, rev} for key, or null (no entry, or not a link).
export function readEntry(link, key) {
  const clean = normalizeLink(link);
  return clean && Object.hasOwn(clean.targets, key) ? clean.targets[key] : null;
}

// The preset id key should load: an id, "" for empty, or null for no opinion.
export function readTarget(link, key) {
  const entry = readEntry(link, key);
  return entry ? entry.id : null;
}

// "keep" (also for no link) or "clear".
export function linkMissing(link) {
  return normalizeLink(link)?.missing || MISSING_KEEP;
}

// A stable string for a link; "" when it isn't one.
export function linkSignature(link) {
  const clean = normalizeLink(link);
  return clean ? JSON.stringify(clean) : "";
}

// A Prompt Vault record's stored link -> the target id: null for no link (""), "" for
// --empty--, else the preset id.
export function storedTargetId(value) {
  if (typeof value !== "string") return null;
  const stored = value.replace(ASCII_SPACE_RE, "");
  if (!stored) return null;
  if (stored === STORED_EMPTY) return "";
  return cleanId(stored);
}
