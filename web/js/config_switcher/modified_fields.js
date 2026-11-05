// Config Switcher's per-field Modified state: the orange dots on the fields you changed
// in the active config (shared/modified_dot.js), and the Modified badge's change list
// across every config (shared/change_list.js).
//
// Both diff the same two snapshots: the node's preset as the signature sees it
// (presets.js currentPresetSnapshot) against the saved one (the loaded baseline's
// signature JSON, else the library copy's). So a dot or a row always means the badge
// reads Modified. Only your own edits (Modified / Conflict); Stale marks nothing.
import { changedFields, markModifiedFields, savedValueTitle } from "../shared/modified_dot.js";
import { LOCAL_STATUS, stableSignature } from "../shared/local_status.js";
import { activeName } from "./config.js";
import { SECTION_TYPE } from "./section_field.js";
import { parseSeedState, presetConfigValues, seedStateKey } from "./seed_values.js";
import { activeConfigPresetBaseline, classifyConfigPreset, currentPresetSnapshot } from "./presets.js";

const SHOWS_CHANGES = new Set([LOCAL_STATUS.MODIFIED, LOCAL_STATUS.CONFLICT]);
// Fields that hold long text: the list says just "Changed".
const LONG_TEXT = (field) => field.type === "prompt" || field.type === "note" || (field.type === "string" && field.stringMultiline);

function savedPreset(node) {
    const text = activeConfigPresetBaseline(node)?.signature || node._configPresetGlobalSignature || "";
    try {
        const saved = text ? JSON.parse(text) : null;
        return saved && typeof saved === "object" ? saved : null;
    } catch {
        return null;
    }
}

const fieldName = (field) => String(field?.name || "").trim() || (field?.type === SECTION_TYPE ? "Section" : "Unnamed");

// A value as the dot tooltip / the list show it; null = long text ("Changed").
function valueText(field, values, liveField) {
    if (field.type === "seed") {
        const state = parseSeedState(values[seedStateKey(field.id)]);
        return state.locked ? `${values[field.id] || "empty"} (locked)` : `${state.mode}, unlocked`;
    }
    if (LONG_TEXT(field)) return null;
    const raw = values[field.id];
    if (raw === undefined || raw === "") return "empty";
    if (field.type === "boolean") return raw === "true" ? "on" : "off";
    if (field.type === "model") {
        const option = (liveField?.modelOptions || []).find((item) => item?.value === raw);
        return String(option?.title || String(raw).split(/[\\/]/).pop());
    }
    return String(raw).replace(/\s+/g, " ");
}

// One config's fields, current vs saved. Fields are the snapshot's (signatureField shape).
function configDescriptor(current, saved, configName) {
    const savedFields = new Map((saved?.fields || []).map((field) => [field.id, field]));
    const nowConfig = current.configs?.[configName];
    const wasConfig = saved?.configs?.[configName];
    const values = (field, snapshot, config, definition) => presetConfigValues([field], definition.shared ? snapshot.shared_values : config);
    return {
        fields: (current.fields || []).filter((field) => field.id && field.type !== SECTION_TYPE),
        current: (field) => ({ definition: field, values: values(field, current, nowConfig, field) }),
        saved: (field) => {
            const definition = savedFields.get(field.id);
            return definition ? { definition, values: values(field, saved, wasConfig, definition) } : undefined;
        },
        wasConfig,
    };
}

const sameValues = (a, b) => stableSignature(a.values) === stableSignature(b.values);

// Dots on the active config's rows: on every Modified re-check (updatePresetModifiedSlot)
// and after the rows are rebuilt (renderFields). -> how many fields carry a dot.
export function renderModifiedFields(node, status = classifyConfigPreset(node)) {
    const rows = node._ddp?.fields;
    if (!rows) return 0;
    const saved = SHOWS_CHANGES.has(status) ? savedPreset(node) : null;
    const current = currentPresetSnapshot(node);   // always: a clean node clears its dots
    const descriptor = configDescriptor(current, saved, String(activeName(node) || "").trim());
    const liveFields = new Map((node._fields || []).map((field) => [field.id, field]));
    const rowOf = (id) => [...rows.children].find((row) => row.dataset?.fieldId === id) || null;
    return markModifiedFields({
        ...descriptor,
        element: (field) => rowOf(field.id)?.querySelector(".ddp-name-wrap") || null,
        title: (field, was) => {
            if (!was) return "Modified (new parameter, not saved yet)";
            if (!descriptor.wasConfig && !was.definition.shared) return "Modified (this config isn't saved yet)";
            if (sameValues(descriptor.current(field), was)) return "Modified (parameter settings changed)";
            return savedValueTitle(valueText(field, was.values, liveFields.get(field.id)));
        },
    }, { enabled: Boolean(saved) });
}

// The Modified badge's list (change_list.js rows): "Preset" (parameters, configs and the
// default), "Shared" (shared values), then each config's value changes, the active config
// first, then A-Z. A config added since the save is one "Preset" row.
export function presetChangeRows(node) {
    const saved = savedPreset(node);
    if (!saved) return [];
    const current = currentPresetSnapshot(node);
    const liveFields = new Map((node._fields || []).map((field) => [field.id, field]));
    const nowFields = new Map((current.fields || []).map((field) => [field.id, field]));
    const wasFields = new Map((saved.fields || []).map((field) => [field.id, field]));
    const rows = [];
    const preset = (row) => rows.push({ group: "Preset", ...row });

    for (const field of saved.fields || []) if (!nowFields.has(field.id)) preset({ label: fieldName(field), note: "Removed" });
    for (const field of current.fields || []) {
        const was = wasFields.get(field.id);
        if (!was) {
            preset({ label: fieldName(field), note: "Added" });
            continue;
        }
        if (fieldName(was) !== fieldName(field)) preset({ label: "Renamed", before: fieldName(was), after: fieldName(field) });
        const settings = (definition) => stableSignature({ ...definition, name: "" });
        if (settings(was) !== settings(field)) preset({ label: fieldName(field), note: "Settings changed" });
    }
    const order = (snapshot, other) => (snapshot.fields || []).map((field) => field.id).filter((id) => other.has(id)).join();
    if (order(current, wasFields) !== order(saved, nowFields)) preset({ label: "Parameter order", note: "Changed" });

    const nowConfigs = Object.keys(current.configs || {});
    const wasConfigs = Object.keys(saved.configs || {});
    for (const name of wasConfigs) if (!nowConfigs.includes(name)) preset({ label: name, note: "Config deleted" });
    for (const name of nowConfigs) if (!wasConfigs.includes(name)) preset({ label: name, note: "Config added" });
    if (String(current.default_config || "") !== String(saved.default_config || "")) {
        preset({ label: "Default config", before: saved.default_config || "none", after: current.default_config || "none" });
    }

    // A field's value change: before → after, or "Changed" for long text. Fields whose
    // only change is their settings were listed above.
    const valueRows = (descriptor, group, keep) => {
        for (const { field, saved: was } of changedFields({ ...descriptor, same: sameValues })) {
            if (!was || !keep(field, was)) continue;
            const live = liveFields.get(field.id);
            const before = valueText(field, was.values, live);
            const after = valueText(field, descriptor.current(field).values, live);
            rows.push(before === null || after === null
                ? { group, label: fieldName(field), note: "Changed" }
                : { group, label: fieldName(field), before, after });
        }
    };
    const anyConfig = nowConfigs[0];
    if (anyConfig !== undefined) {
        valueRows(configDescriptor(current, saved, anyConfig), "Shared", (field, was) => field.shared && was.definition.shared);
    }
    const active = String(activeName(node) || "").trim();
    const names = nowConfigs.filter((name) => wasConfigs.includes(name))
        .sort((a, b) => (a === active ? -1 : b === active ? 1 : a.localeCompare(b)));
    for (const name of names) {
        valueRows(configDescriptor(current, saved, name), name, (field, was) => !field.shared && !was.definition.shared);
    }
    return rows;
}
