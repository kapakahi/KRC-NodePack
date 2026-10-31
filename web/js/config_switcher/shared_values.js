// Shared fields own one node-local value, independent of any config snapshot. Each config
// keeps its own value for a shared field, hidden while shared: turning Share off brings
// every config's own value back.
import { seedStateKey } from "./seed_values.js";
import { dynamicValueKeys } from "./dynamic_combo.js";

// Every value key a field owns, moved as one set by Share (a DYNAMIC COMBO's pick and all
// its options' settings: CS_DYNAMIC_COMBO_GAMEPLAN.md D15).
export function fieldValueKeys(field) {
    if (field.type === "seed") return [field.id, seedStateKey(field.id)];
    if (field.type === "dynamic_combo") return dynamicValueKeys(field);
    return [field.id];
}

export function sharedKeys(node) {
    return new Set((node._fields || []).filter(field => field.shared).flatMap(fieldValueKeys));
}

// Every raw value store: each config (hidden shared-field values included) and the shared one.
export function configValueStores(node) {
    return [...Object.values(node._configs || {}), node._sharedValues || {}];
}

// All existing value controls use this view: shared writes have a single owner.
export function configValueView(node, config) {
    if (!config) return null;
    const keys = sharedKeys(node);
    if (!keys.size) return config;
    node._sharedValues ||= {};
    const owner = key => keys.has(key) ? node._sharedValues : config;
    return new Proxy(config, {
        get: (_, key) => owner(key)[key],
        set: (_, key, value) => { owner(key)[key] = value; return true; },
        deleteProperty: (_, key) => delete owner(key)[key],
        has: (_, key) => key in owner(key),
        ownKeys: () => [...new Set([...Reflect.ownKeys(config).filter(key => !keys.has(key)), ...Reflect.ownKeys(node._sharedValues).filter(key => keys.has(key))])],
        getOwnPropertyDescriptor: (_, key) => Object.hasOwn(owner(key), key)
            ? { configurable: true, enumerable: true, writable: true, value: owner(key)[key] } : undefined,
    });
}

// The shared store holds only shared fields' values; configs' hidden values stay.
export function pruneSharedValues(node) {
    const keys = sharedKeys(node);
    node._sharedValues ||= {};
    for (const key of Object.keys(node._sharedValues)) if (!keys.has(key)) delete node._sharedValues[key];
}

// On: the shared value starts as the active config's (`values`). Off: the shared value
// goes and each config outputs its own kept value again.
export function setFieldShared(node, field, enabled, values) {
    node._sharedValues ||= {};
    if (Boolean(field.shared) === Boolean(enabled)) return false;
    if (enabled) {
        const current = Object.fromEntries(fieldValueKeys(field).map(key => [key, values?.[key] ?? ""]));
        field.shared = true;
        Object.assign(node._sharedValues, current);
    } else {
        delete field.shared;
        for (const key of fieldValueKeys(field)) delete node._sharedValues[key];
    }
    return true;
}
