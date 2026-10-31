// Config Switcher DYNAMIC COMBO (CS_DYNAMIC_COMBO_GAMEPLAN.md): the pure rules. Pure: no
// DOM, graph or app. Mirrored by utils/config_switcher_dynamic.py; keep the two in step.
//
// A DYNAMIC COMBO field drives a V3 DynamicCombo input. Its schema is captured from the
// target and stored on the field (`field.dynamicCombo`, D4):
//   {inputId, options: [{key, unsupported, settings: [{name, type, default, min, max, step,
//    multiline, options}]}]}
// `unsupported` is "" for an option CS can drive, else why not (a socket, a nested
// DynamicCombo; D11 / D12). Each config stores the picked key under the field id and each
// setting under `<id>:<option>:<setting>`, remembered per option (D8). Keys are always built
// from the schema, never parsed. The pick and every option's settings are one set (D15).
// `field.dynamicHidden` lists supported option keys hidden from the dropdown (D14): a pick
// on one falls back like an unsupported pick; their remembered settings stay.

export const DYNAMIC_COMBO_TYPE = "dynamic_combo";
export const SETTING_TYPES = ["FLOAT", "INT", "BOOLEAN", "STRING", "COMBO"];

export function settingKey(fieldId, optionKey, settingName) {
    return `${fieldId}:${optionKey}:${settingName}`;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function finite(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function cleanStrings(values) {
    return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value ?? "").trim()).filter(Boolean))];
}

// One setting as stored: its name, a supported type and that type's spec. null when unusable.
export function cleanSetting(raw) {
    if (!isObject(raw)) return null;
    const name = String(raw.name ?? "").trim();
    const type = String(raw.type ?? "").toUpperCase();
    if (!name || !SETTING_TYPES.includes(type)) return null;
    const setting = { name, type };
    if (type === "FLOAT" || type === "INT") {
        for (const key of ["default", "min", "max", "step"]) {
            const n = finite(raw[key]);
            if (n !== null) setting[key] = type === "INT" ? Math.trunc(n) : n;
        }
        if (setting.step !== undefined && setting.step <= 0) delete setting.step;
    } else if (type === "BOOLEAN") {
        if (typeof raw.default === "boolean") setting.default = raw.default;
    } else if (type === "STRING") {
        if (raw.default !== undefined && raw.default !== null) setting.default = String(raw.default);
        if (raw.multiline === true) setting.multiline = true;
    } else {
        setting.options = cleanStrings(raw.options);
        if (!setting.options.length) return null;
        if (raw.default !== undefined && setting.options.includes(String(raw.default))) setting.default = String(raw.default);
    }
    return setting;
}

// The stored schema, cleaned. null without an input id or a single option.
export function cleanDynamicSchema(raw) {
    if (!isObject(raw)) return null;
    const inputId = String(raw.inputId ?? "").trim();
    const seen = new Set();
    const options = [];
    for (const option of Array.isArray(raw.options) ? raw.options : []) {
        const key = String(option?.key ?? "").trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const unsupported = String(option?.unsupported ?? "").trim();
        const names = new Set();
        const settings = [];
        for (const item of unsupported ? [] : (Array.isArray(option?.settings) ? option.settings : [])) {
            const setting = cleanSetting(item);
            if (!setting || names.has(setting.name)) continue;
            names.add(setting.name);
            settings.push(setting);
        }
        options.push({ key, unsupported, settings });
    }
    return inputId && options.length ? { inputId, options } : null;
}

export function supportedOptions(schema) {
    return (schema?.options || []).filter((option) => !option.unsupported);
}

// The hidden option keys, cleaned against the schema; never every supported option.
export function cleanDynamicHidden(schema, hidden) {
    const supported = supportedOptions(schema).map((option) => option.key);
    const keys = [...new Set((Array.isArray(hidden) ? hidden : []).map(String))].filter((key) => supported.includes(key));
    return keys.length >= supported.length ? [] : keys;
}

// The options the dropdown offers: supported and not hidden.
export function visibleOptions(field) {
    const hidden = new Set(cleanDynamicHidden(field.dynamicCombo, field.dynamicHidden));
    return supportedOptions(field.dynamicCombo).filter((option) => !hidden.has(option.key));
}

// Every value key the field owns, as one set (D15): the pick, then each supported option's
// settings. Share, presets and Save As move exactly these.
export function dynamicValueKeys(field) {
    const keys = [field.id];
    for (const option of supportedOptions(field.dynamicCombo)) {
        for (const setting of option.settings) keys.push(settingKey(field.id, option.key, setting.name));
    }
    return keys;
}

// A config's values for the field as a preset keeps them: every key of the set that's
// present (remembered settings of options that aren't picked included), as text.
export function dynamicConfigValues(field, values) {
    const source = isObject(values) ? values : {};
    const out = {};
    for (const key of dynamicValueKeys(field)) {
        if (Object.prototype.hasOwnProperty.call(source, key)) out[key] = String(source[key] ?? "");
    }
    return out;
}

// The picked option: the stored key when it's a visible option, else the first one.
export function pickedOption(field, values) {
    const options = visibleOptions(field);
    const stored = String(values?.[field.id] ?? "");
    return options.find((option) => option.key === stored) || options[0] || null;
}

const roundHalfUp = (n) => Math.floor(n + 0.5);

function clampAndSnap(n, setting) {
    let value = n;
    if (setting.min !== undefined) value = Math.max(value, setting.min);
    if (setting.max !== undefined) value = Math.min(value, setting.max);
    if (setting.step) {
        const base = setting.min ?? 0;
        value = base + roundHalfUp((value - base) / setting.step) * setting.step;
        if (setting.max !== undefined && value > setting.max) value -= setting.step;
        if (setting.min !== undefined && value < setting.min) value += setting.step;
    }
    return value;
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

// One setting's value as the node gets it (D7): its type, in range and on step; missing or
// invalid -> the default (or the type's zero / first option).
export function coerceSetting(setting, raw) {
    const missing = raw === undefined || raw === null;
    switch (setting.type) {
        case "FLOAT": {
            const n = (missing ? null : finite(raw)) ?? setting.default ?? setting.min ?? 0;
            return Number(clampAndSnap(n, setting).toFixed(10));
        }
        case "INT": {
            const parsed = missing ? null : finite(raw);
            const n = parsed === null ? (setting.default ?? setting.min ?? 0) : Math.trunc(parsed);
            return Math.trunc(clampAndSnap(n, setting));
        }
        case "BOOLEAN": {
            const word = String(raw ?? "").trim().toLowerCase();
            if (raw === true || TRUE_WORDS.has(word)) return true;
            if (raw === false || FALSE_WORDS.has(word)) return false;
            return setting.default ?? false;
        }
        case "STRING":
            return missing ? (setting.default ?? "") : String(raw);
        default: {
            const text = missing ? "" : String(raw);
            if (setting.options.includes(text)) return text;
            return setting.default ?? setting.options[0];
        }
    }
}

// The dict the node gets for one config (D7): the picked key under the input id plus every
// setting of that option. null when no option is supported.
export function resolveDynamicValue(field, values) {
    const option = pickedOption(field, values);
    if (!option) return null;
    const out = { [field.dynamicCombo.inputId]: option.key };
    for (const setting of option.settings) {
        out[setting.name] = coerceSetting(setting, values?.[settingKey(field.id, option.key, setting.name)]);
    }
    return out;
}

// One config's values after the field takes a (new) schema: the pick follows a value that
// is a supported option key, else the first supported option (D9); setting keys the schema
// no longer has are dropped, remembered ones kept. Mutates `values`.
export function adoptDynamicSchema(field, values) {
    if (!isObject(values)) return values;
    const prefix = `${field.id}:`;
    const keep = new Set(dynamicValueKeys(field));
    for (const key of Object.keys(values)) {
        if (key.startsWith(prefix) && !keep.has(key)) delete values[key];
    }
    const option = pickedOption(field, values);
    if (option) values[field.id] = option.key;
    return values;
}

// Back to a COMBO (D3): the pick stays as the combo value; every setting key goes.
export function dropDynamicSettings(field, values) {
    if (!isObject(values)) return values;
    const prefix = `${field.id}:`;
    for (const key of Object.keys(values)) if (key.startsWith(prefix)) delete values[key];
    return values;
}

// Two schemas describe the same input (D10): identical once cleaned (input id, option keys,
// support, and every setting's name, type and spec).
export function sameDynamicSchema(a, b) {
    return JSON.stringify(cleanDynamicSchema(a)) === JSON.stringify(cleanDynamicSchema(b));
}
