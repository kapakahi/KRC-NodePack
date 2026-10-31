import { configValueStores } from "./shared_values.js";
/*
 * Config Switcher references that follow their source: pure helpers.
 *
 * - Models (PATH_HEALING_GAMEPLAN.md step 4): a model field outputs a path, but its option
 *   also stores the model's library id. When the model moves (same id), the new path
 *   replaces the old one.
 * - Prompts (CS_LIVE_PROMPTS_GAMEPLAN.md step 1): a prompt field outputs text, but its
 *   option also stores the Prompt Vault record id. When the prompt is edited and saved
 *   (same id), the new text replaces the old one.
 *
 * Either way the new value lands in the option, in every config that selected it, and in
 * the preset's saved baseline + global signature, so it never reads as Modified. A model
 * stabilized mid-session (step 2) only changes the option's id, which isn't in the
 * signature. Kept apart from config.js so it can be checked in Node.
 */

// A model that moved is the same model: its option's path follows its library id. The new
// path replaces the old one in the option, in every config that selected it, and in the
// preset's saved baseline + global signature, so the move never reads as Modified. `moves`
// is {library id: {relativePath, path}} (a krc-library-healed push or the load-time
// catch-up). Returns whether anything changed.
export function applyModelPathMoves(node, moves) {
    if (!moves || typeof moves !== "object") return false;
    const changes = [];
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            const id = String(option?.libraryId || option?.sha256 || "").trim();
            const move = id ? moves[id] : null;
            const next = String(move?.relativePath || "");
            if (!next || option.value === next) continue;
            const old = option.value;
            option.value = next;
            option.relativePath = next;
            if (move.path) option.path = String(move.path);
            for (const config of configValueStores(node)) {
                if (config?.[field.id] === old) config[field.id] = next;
            }
            changes.push({ fieldId: field.id, from: old, to: next });
        }
    }
    return rewriteSignatures(node, changes);
}

// A prompt edited in Prompt Vault is the same prompt: its option's text follows its record
// id. `texts` is {record id: new text} (a Prompt Vault save seen by this node, the
// load-time catch-up, or the server finding it at run time). Hand-typed options (no id)
// are left alone. Returns whether anything changed.
export function applyPromptTextChanges(node, texts) {
    if (!texts || typeof texts !== "object") return false;
    const changes = [];
    for (const field of node._fields || []) {
        if (field?.type !== "prompt" || !Array.isArray(field.promptOptions)) continue;
        for (const option of field.promptOptions) {
            const id = String(option?.id || "").trim();
            // A record id in `texts` is followed even to "" (the prompt was emptied).
            if (!id || typeof texts[id] !== "string" || option.value === texts[id]) continue;
            const next = texts[id];
            const old = option.value || "";
            option.value = next;
            // A blank option's configs can't be told from unpicked ones (both ""), so only
            // a real old text moves the configs that picked it.
            if (old) {
                for (const config of configValueStores(node)) {
                    if (config?.[field.id] === old) config[field.id] = next;
                }
            }
            changes.push({ fieldId: field.id, from: old, to: next, optionsKey: "promptOptions" });
        }
        // Two snapshots of the same prompt (the old text and the new) are now one card.
        const seen = new Set();
        field.promptOptions = field.promptOptions.filter((option) => {
            const key = option?.id ? `${option.id}\u0000${option.value}` : null;
            if (!key) return true;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
    }
    return rewriteSignatures(node, changes);
}

// The node's saved baseline + global signature take the same value changes, so the
// followed reference never reads as Modified or Stale.
function rewriteSignatures(node, changes) {
    if (!changes.length) return false;
    const baseline = node._configPresetBaseline;
    if (baseline?.signature) baseline.signature = moveSignatureValues(baseline.signature, changes);
    if (node.properties?.configPresetBaseline?.signature && node.properties.configPresetBaseline !== baseline) {
        node.properties.configPresetBaseline.signature = moveSignatureValues(node.properties.configPresetBaseline.signature, changes);
    }
    if (node._configPresetGlobalSignature) {
        node._configPresetGlobalSignature = moveSignatureValues(node._configPresetGlobalSignature, changes);
    }
    return true;
}

// The same value changes applied to a stored normalizedPresetSignature (the field's
// option values + config values), keeping its exact shape so an unchanged preset still
// matches. A change names its option list (`optionsKey`, model options by default).
export function moveSignatureValues(signature, changes) {
    let parsed;
    try {
        parsed = JSON.parse(signature);
    } catch {
        return signature;
    }
    for (const { fieldId, from, to, optionsKey = "modelOptions" } of changes) {
        const field = (parsed.fields || []).find((item) => item.id === fieldId);
        // The signature lists only non-empty option values (presets.js optionValues), so a
        // prompt emptied ("" to) drops out and one refilled ("" from) joins.
        if (field && Array.isArray(field[optionsKey]) && (!from || field[optionsKey].includes(from))) {
            const values = from ? field[optionsKey].map((value) => (value === from ? to : value)) : [...field[optionsKey], to];
            field[optionsKey] = [...new Set(values.filter(Boolean))].sort();
        }
        if (!from) continue;   // unpicked configs are "" too: never touch them
        for (const values of [...Object.values(parsed.configs || {}), parsed.shared_values]) {
            if (values && values[fieldId] === from) values[fieldId] = to;
        }
    }
    return JSON.stringify(parsed);
}

// Library options (libraryItemToModelOption) whose id matches one of this node's options
// but whose path differs: those models moved. -> {library id: {relativePath, path}}
export function modelMovesFromLibrary(node, libraryOptions) {
    const byId = new Map();
    for (const option of libraryOptions || []) {
        const id = String(option?.libraryId || option?.sha256 || "").trim();
        if (id) byId.set(id, option);
    }
    const moves = {};
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            const id = String(option?.libraryId || option?.sha256 || "").trim();
            const hit = id ? byId.get(id) : null;
            if (hit?.value && hit.value !== option.value) moves[id] = { relativePath: hit.value, path: hit.path || "" };
        }
    }
    return moves;
}

// Prompt options whose Prompt Vault record was saved since the option took its text:
// the record's dateModified differs from the one stored on the option. Only these need
// their text fetched. `prompts` is the Prompt Vault library ({category: {name: record}}).
// -> [{id, category, name, dateModified}]
export function editedPromptRecords(node, prompts) {
    if (!prompts || typeof prompts !== "object") return [];
    const byId = new Map();
    for (const [category, bucket] of Object.entries(prompts)) {
        if (!bucket || typeof bucket !== "object") continue;
        for (const [name, record] of Object.entries(bucket)) {
            if (name === "__meta__" || !record || typeof record !== "object" || !record.id) continue;
            byId.set(String(record.id), { id: String(record.id), category: record.category || category, name: record.name || name, dateModified: String(record.dateModified || "") });
        }
    }
    const edited = new Map();
    for (const field of node._fields || []) {
        if (field?.type !== "prompt" || !Array.isArray(field.promptOptions)) continue;
        for (const option of field.promptOptions) {
            const hit = option?.id ? byId.get(String(option.id)) : null;
            if (hit && hit.dateModified && hit.dateModified !== String(option.dateModified || "")) edited.set(hit.id, hit);
        }
    }
    return [...edited.values()];
}

// Record the Prompt Vault dateModified each option's text now matches ({record id: date}).
// Bookkeeping only (not in the signature). Returns whether anything changed.
export function stampPromptDates(node, dates) {
    if (!dates || typeof dates !== "object") return false;
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "prompt" || !Array.isArray(field.promptOptions)) continue;
        for (const option of field.promptOptions) {
            const date = option?.id ? dates[String(option.id)] : undefined;
            if (date && option.dateModified !== date) { option.dateModified = date; changed = true; }
        }
    }
    return changed;
}

// An id promotion ({oldId, newId}, CS_LIVE_PROMPTS_GAMEPLAN.md step 2): model options
// holding the old id take the new one, and a thumbnail URL built from it follows (the
// stabilize moved the image to the new id). Returns whether anything changed.
export function applyModelIdentityChange(node, identity) {
    const oldId = String(identity?.oldId || "");
    const newId = String(identity?.newId || "");
    if (!oldId || !newId || oldId === newId) return false;
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            if (!option || ![option.id, option.libraryId, option.sha256].includes(oldId)) continue;
            option.id = newId;
            option.libraryId = newId;
            option.sha256 = newId;
            if (option.thumbnail) option.thumbnail = option.thumbnail.split(encodeURIComponent(oldId)).join(encodeURIComponent(newId));
            changed = true;
        }
    }
    return changed;
}
