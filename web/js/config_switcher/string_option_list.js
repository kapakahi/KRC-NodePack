// Config Switcher combo: the saved values as text (Add Value ▸ List). Pure, so the dev
// check can run it under node (tests/cs_combo_list_check.mjs).

// Most saved values a combo field keeps.
export const STRING_OPTION_CAP = 48;

const key = (value) => String(value ?? "").trim().toLowerCase();

// One value per line; a `;` ending a line only ends the value (optional). A `;` inside
// a line stays part of it. Blank lines go; repeats keep the first spelling.
export function parseStringOptionList(text) {
    const values = [];
    const seen = new Set();
    for (const line of String(text ?? "").split(/\r?\n/)) {
        const value = line.trim().replace(/;$/, "").trim();
        if (!value || seen.has(key(value))) continue;
        seen.add(key(value));
        values.push(value);
    }
    return values;
}

// The saved list as List mode shows it: one per line, each ending in `;` (so a value
// that itself ends in `;` survives the round trip).
export function formatStringOptionList(options) {
    return (options || []).map((value) => String(value ?? "").trim()).filter(Boolean).map((value) => `${value};`).join("\n");
}

// What saving `text` over `options` does. The text IS the new list, in its order,
// capped at STRING_OPTION_CAP. A value whose spelling only changed case is `renamed`
// (configs follow it); anything else missing is `removed`.
// -> { options, added, removed, renamed: [[old, new]], truncated, changed }
export function planStringOptionList(options, text, cap = STRING_OPTION_CAP) {
    const parsed = parseStringOptionList(text);
    const next = parsed.slice(0, cap);
    const old = (options || []).map((value) => String(value ?? "").trim()).filter(Boolean);
    const oldByKey = new Map(old.map((value) => [key(value), value]));
    const nextKeys = new Set(next.map(key));
    const added = next.filter((value) => !oldByKey.has(key(value)));
    const renamed = next.filter((value) => oldByKey.has(key(value)) && oldByKey.get(key(value)) !== value)
        .map((value) => [oldByKey.get(key(value)), value]);
    const removed = old.filter((value) => !nextKeys.has(key(value)));
    const changed = next.length !== old.length || next.some((value, index) => value !== old[index]);
    return { options: next, added, removed, renamed, truncated: parsed.slice(cap), changed };
}
