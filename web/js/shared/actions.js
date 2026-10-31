/*
 * KRC shared action vocabulary.
 *
 * Canonical glyph + label for functions that recur across more than one KRC
 * node, so identical actions look and read identically everywhere.
 *
 * Rule: only genuinely *similar* functions belong here. Node-unique options
 * (e.g. WordBank's "Import word bank…" .txt upload) keep their own bespoke
 * glyph and wording inline — do not force them through this vocabulary. Add an
 * entry here only when a second node needs the same function.
 *
 * Direction convention: down = out to a file (export), up = in from a file
 * (import). Arrow-to-bar glyphs (U+2913/2912) read like "save down to disk" /
 * "lift up from disk"; they render as monochrome text (unlike the heavier ⬇/⬆,
 * which show as color emoji on some platforms).
 */
export const ACTION_EXPORT = { glyph: "⤓", label: "EXPORT" };
export const ACTION_IMPORT = { glyph: "⤒", label: "IMPORT" };
