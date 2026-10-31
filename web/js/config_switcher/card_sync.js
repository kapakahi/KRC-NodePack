import { modelIdentityIndex } from "../shared/model_identity.js";
// Config Switcher live cards: library metadata / thumbnail broadcasts, MISSING status, the
// lifecycle catch-up from the model and prompt libraries, and live prompt text.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { currentReadRevision, jsonBodyInit } from "../shared/api.js";
import {
    applyModelPathMoves,
    applyPromptTextChanges,
    editedPromptRecords,
    modelMovesFromLibrary,
    stampPromptDates,
} from "./path_moves.js";
import { apiGet as getPromptJson, fetchPromptLibraryJson, withPromptReferences } from "../prompt_vault/api.js";
import { getSharedJson as getModelLibraryJson, libraryListPath } from "../model_library/api.js";
import { onKrcBootSettled } from "../shared/boot_state.js";
import { CARD_STATUS, modelCardStatus } from "../shared/card_status.js";
import { writeData } from "./config.js";
import {
    applyPromptLibraryToOptions,
    hasLibraryPromptFields,
    promptEmittedText,
} from "./prompt_field.js";
import { requestConfigSwitcherJson } from "./presets.js";
import {
    hasLibraryModelFields,
    libraryItemToModelOption,
} from "./model_field.js";
import { renderFields } from "./field_rows.js";

// Live metadata sync (METADATA_INSTANT_SYNC_GAMEPLAN.md step 4, CS_LIVE_CARDS_GAMEPLAN.md).
// Config Switcher is a read-only consumer of model metadata: when LoRA Loadout / Model
// Library broadcast a change, mirror the card's display data (title, colour, badge,
// favorite, NSFW) onto any of this node's model options that point at the affected
// record. Display data isn't part of the preset signature, so this never marks a preset
// changed. Returns whether anything changed, so the caller persists + repaints only then.
export function applyLibraryMetadataToOptions(node, detail = {}) {
    const affected = new Set(
        (Array.isArray(detail.affected) ? detail.affected : [detail.sha256])
            .map((sha) => String(sha || "").trim())
            .filter(Boolean),
    );
    if (!affected.size) return false;
    const metadata = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
    // The server always fills display_name (title, else source name, else filename);
    // an absent / empty one means this broadcast didn't carry the title.
    const title = typeof metadata.display_name === "string" ? metadata.display_name.trim() : "";
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            const sha = String(option?.sha256 || option?.libraryId || "").trim();
            if (!sha || !affected.has(sha)) continue;
            if (title && option.title !== title) { option.title = title; changed = true; }
            for (const key of ["cardColor", "customBadge"]) {
                if (key in metadata) {
                    const next = String(metadata[key] || "");
                    if (option[key] !== next) { option[key] = next; changed = true; }
                }
            }
            for (const key of ["favorite", "nsfw"]) {
                if (key in metadata) {
                    const next = Boolean(metadata[key]);
                    if (option[key] !== next) { option[key] = next; changed = true; }
                }
            }
        }
    }
    return changed;
}

// A thumbnail broadcast (upload, removal, refresh from source, Civitai preview): point
// matching model options at the new image — built like libraryThumbnailFromItem, with the
// broadcast's version (the item's new thumbnailVersion) so the URL changes with the image. Returns whether
// anything changed.
export function applyLibraryThumbnailToOptions(node, detail = {}) {
    const affected = new Set(
        (Array.isArray(detail.affected) ? detail.affected : [detail.sha256])
            .map((sha) => String(sha || "").trim())
            .filter(Boolean),
    );
    if (!affected.size) return false;
    const version = Number(detail.version) || Date.now();
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            const sha = String(option?.sha256 || option?.libraryId || "").trim();
            if (!sha || !affected.has(sha)) continue;
            const id = String(option.libraryId || option.sha256 || option.id || "").trim();
            const next = libraryItemToModelOption({ ...detail.thumbnail, id, thumbnailVersion: version });
            for (const key of ["thumbnail", "previewVideoUrl"]) {
                const value = next?.[key] || "";
                if (option[key] !== value) { option[key] = value; changed = true; }
            }
        }
    }
    return changed;
}

// ── Missing model cards (CARD_MISSING_STATUS_GAMEPLAN.md step 3) ─────────────────────
// A model option whose card a run won't find on this machine shows the shared MISSING look
// (shared/card_status.js decides like a run: id known -> ok; id unknown but the stored
// relative path exists -> by-path, runs fine, no badge; neither -> missing). Hand-typed
// options (no id) are never badged: they may point at folders the library doesn't scan.
// Prompt options are never badged either: a run uses their saved text. Display state
// only: node._cardMissing (ids), never saved, never Modified.

function modelStatusEntries(node) {
    const entries = [];
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            const id = String(option?.libraryId || option?.sha256 || "").trim();
            if (!id) continue;
            entries.push({ id, path: option.value, folder: option.modelType || field.modelType || "" });
        }
    }
    return entries;
}

// libraryPayload: the /library payload, or null when it couldn't be read (then nothing is
// missing). Returns whether the missing set changed.
function applyModelCardStatus(node, libraryPayload) {
    const status = modelCardStatus(modelStatusEntries(node), libraryPayload);
    const missing = new Set(Object.keys(status).filter((id) => status[id] === CARD_STATUS.MISSING));
    const before = node._cardMissing || new Set();
    node._cardMissing = missing;
    return missing.size !== before.size || [...missing].some((id) => !before.has(id));
}

// Reconcile both display and missing status after a library change (refresh,
// import, batch fetch, heal or stabilize).
export async function refreshModelCardStatus(node) {
    if (!modelStatusEntries(node).length && !node._cardMissing?.size) return;
    const { ok, data } = await getModelLibraryJson(libraryListPath()).catch(() => ({ ok: false, data: null }));
    if (!node._ddp || !node.graph) return;
    const displayChanged = ok && applyModelLibraryDisplay(node,
        (data?.items || data?.loras || []).map(libraryItemToModelOption).filter(Boolean), data?.aliases);
    const statusChanged = applyModelCardStatus(node, ok ? data : null);
    if (displayChanged) writeData(node);
    if (displayChanged || statusChanged) renderFields(node);
}

// A record invalidation is meaningful even without a display patch (HF imports,
// server writes and extensions). Share the targeted detail read across CS nodes.
export async function refreshModelCardRecords(node, detail = {}) {
    const held = new Set(modelStatusEntries(node).map(({ id }) => id));
    const affected = Array.isArray(detail.affected) ? detail.affected : [detail.sha256];
    const ids = [...new Set(affected.map(id => String(id || "").trim()))].filter(id => held.has(id));
    if (!held.size) return;
    if (!ids.length) return refreshModelCardStatus(node);
    const records = await Promise.all(ids.map(async id => {
        const { ok, data } = await getModelLibraryJson(`/detail/${encodeURIComponent(id)}`)
            .catch(() => ({ ok: false }));
        return ok && data?.sha256 === id ? libraryItemToModelOption(data) : null;
    }));
    if (!node._ddp || !node.graph) return;
    if (applyModelLibraryDisplay(node, records.filter(Boolean))) {
        writeData(node);
        renderFields(node);
    }
}

async function referencedPromptLibrary(node, library) {
    if (!library) return library;
    const ids = (node._fields || []).filter(field => field?.type === "prompt").flatMap(field => field.promptOptions || [])
        .map(option => option?.id);
    return await withPromptReferences(library, ids) || library;
}

export async function refreshPromptCards(node) {
    if (!hasLibraryPromptFields(node)) return;
    const prompts = await referencedPromptLibrary(node, await fetchPromptLibraryJson());
    if (!prompts || !node._ddp || !node.graph) return;
    if (applyPromptLibraryToOptions(node, prompts)) {
        writeData(node);
        renderFields(node);
    }
    await followPromptEdits(node, prompts);
}

export function isModelOptionMissing(node, option) {
    const id = String(option?.libraryId || option?.sha256 || "").trim();
    return Boolean(id && node?._cardMissing?.has(id));
}

// ── Load-time catch-up (CS_LIVE_CARDS_GAMEPLAN.md step 4) ─────────────────────────
// Cards stored with a workflow can predate edits made while no Config Switcher was
// listening (before a reload, in another tab, in the KRC Editor). On workflow
// load or preset application, after boot settles, each node copies its cards' current display data — never
// an output value — from the model and prompt libraries. All Config Switchers on the
// page share one fetch of each library.
const CARD_LIBRARIES_REUSE_MS = 15000;
let cardLibrariesLoad = null;   // { at, promise }

function loadCardLibraries() {
    const now = Date.now();
    const revision = currentReadRevision();
    if (cardLibrariesLoad?.revision === revision && now - cardLibrariesLoad.at < CARD_LIBRARIES_REUSE_MS) return cardLibrariesLoad.promise;
    // Both requests are shared with any Model Library / Prompt Vault node loading now.
    const promise = Promise.all([
        getModelLibraryJson(libraryListPath()).then(({ ok, data }) => (ok ? data : null), () => null),
        fetchPromptLibraryJson(),
    ]).then(([models, prompts]) => ({
        // The raw payload too: the missing-card status reads its items + identity aliases.
        models,
        modelOptions: (Array.isArray(models?.items) ? models.items : models?.loras || [])
            .map(libraryItemToModelOption)
            .filter(Boolean),
        prompts: prompts && typeof prompts === "object" && !prompts.error ? prompts : null,
    }));
    cardLibrariesLoad = { at: now, revision, promise };
    return promise;
}

// Moves this node found itself (the load-time catch-up): the server has no rescan event for
// them (e.g. the models moved while ComfyUI was down), so ask it to point the saved
// presets at the new paths too. Idempotent; best-effort.
function followModelMoves(node, moves) {
    if (!applyModelPathMoves(node, moves)) return false;
    requestConfigSwitcherJson("/presets/heal-paths", jsonBodyInit("POST", { moves })).catch(() => {});
    return true;
}

// Display data + identity from the model library onto matching model options, matched
// by canonical identity, then an unambiguous path within the model type. This also
// repairs cards stabilized while closed. Output values (value / path) stay unchanged.
const MODEL_CARD_DISPLAY_KEYS = ["previewVideoUrl", "id", "libraryId", "sha256", "title", "cardColor", "customBadge", "favorite", "nsfw"];

export function applyModelLibraryDisplay(node, libraryOptions, aliases = {}) {
    if (!Array.isArray(libraryOptions) || !libraryOptions.length) return false;
    const resolve = modelIdentityIndex(libraryOptions, aliases);
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "model" || !Array.isArray(field.modelOptions)) continue;
        for (const option of field.modelOptions) {
            if (!option) continue;
            const hit = resolve({ ...option, modelType: option.modelType || field.modelType });
            if (!hit) continue;
            for (const key of MODEL_CARD_DISPLAY_KEYS) {
                if (option[key] !== hit[key]) { option[key] = hit[key]; changed = true; }
            }
            // The URL carries the item's thumbnail version, stable while the image is
            // unchanged: a difference means a new image (or a first stable URL).
            if ((option.thumbnail || "") !== (hit.thumbnail || "")) {
                option.thumbnail = hit.thumbnail;
                changed = true;
            }
        }
    }
    return changed;
}

// Card display data is live, never saved state: applying a preset (a Discard, a load) must
// not bring back the display a card had when the preset was saved. Each option in `next`
// takes the display of the same card in `previous`, the node's current fields (model cards
// by output value, prompt cards by Prompt Vault id, else text). Output values and prompt
// text are never carried. -> whether anything changed.
const PROMPT_CARD_DISPLAY_KEYS = ["thumbnail", "previewVideoUrl", "title", "category", "name", "cardColor", "customBadge", "favorite", "nsfw"];

export function carryCardDisplay(previous, next) {
    const models = new Map();
    const prompts = new Map();
    for (const field of previous || []) {
        for (const option of field?.type === "model" ? field.modelOptions || [] : []) if (option?.value) models.set(`${option.modelType || field.modelType || ""}|${option.value}`, option);
        for (const option of field?.type === "prompt" ? field.promptOptions || [] : []) {
            if (option) prompts.set(option.id ? `id:${option.id}` : `text:${option.value}`, option);
        }
    }
    let changed = false;
    const copy = (target, source, keys) => {
        for (const key of keys) {
            if (source && target[key] !== source[key]) { target[key] = source[key]; changed = true; }
        }
    };
    for (const field of next || []) {
        for (const option of field?.type === "model" ? field.modelOptions || [] : []) {
            if (option) copy(option, models.get(`${option.modelType || field.modelType || ""}|${option.value}`), ["thumbnail", ...MODEL_CARD_DISPLAY_KEYS]);
        }
        for (const option of field?.type === "prompt" ? field.promptOptions || [] : []) {
            if (option) copy(option, prompts.get(option.id ? `id:${option.id}` : `text:${option.value}`), PROMPT_CARD_DISPLAY_KEYS);
        }
    }
    return changed;
}

export function scheduleCardCatchUp(node) {
    if (node._configCardCatchUpArmed) return;
    if (!(hasLibraryModelFields(node) || hasLibraryPromptFields(node))) return;
    node._configCardCatchUpArmed = true;
    onKrcBootSettled(async () => {
        try {
            const { models: modelPayload, modelOptions, prompts } = await loadCardLibraries();
            if (!node._ddp || !node.graph) return;   // removed meanwhile
            // A model that moved since the workflow was saved takes its new path (same id:
            // never Modified), then the display data catches up as before.
            const moved = followModelMoves(node, modelMovesFromLibrary(node, modelOptions));
            const models = applyModelLibraryDisplay(node, modelOptions, modelPayload?.aliases) || moved;
            const referenced = await referencedPromptLibrary(node, prompts);
            const promptCards = applyPromptLibraryToOptions(node, referenced);
            // After the catch-up (an option at a path this machine has took its id): which
            // cards a run won't find here.
            const missingChanged = applyModelCardStatus(node, modelPayload);
            if (models || promptCards) {
                writeData(node);
                renderFields(node);
            } else if (missingChanged) {
                renderFields(node);
            }
            // Prompts edited and saved since the workflow was saved take their new text.
            followPromptEdits(node, referenced);
        } finally {
            node._configCardCatchUpArmed = false;
        }
    });
}

// ── Live prompt text (CS_LIVE_PROMPTS_GAMEPLAN.md step 1) ─────────────────────────────
// A prompt option's text follows its Prompt Vault record id: once a prompt is saved with
// new text, every option for it, every config that selected it and the saved baseline
// take the text without reading Modified. The library announce carries no text, so only
// the records whose dateModified moved are fetched, once per page for all nodes.
const promptDetailLoads = new Map();   // `${id}|${dateModified}` -> Promise<detail|null>

function loadPromptDetail({ id, category, name, dateModified }) {
    const key = `${id}|${dateModified}`;
    if (!promptDetailLoads.has(key)) {
        const qs = new URLSearchParams(id ? { id } : { category, name });
        promptDetailLoads.set(key, getPromptJson(`/prompt-detail?${qs.toString()}`)
            .catch(() => null)
            .then((detail) => {
                if (!detail) promptDetailLoads.delete(key);   // retry on the next announce
                return detail;
            }));
    }
    return promptDetailLoads.get(key);
}

export async function followPromptEdits(node, prompts) {
    const edited = editedPromptRecords(node, prompts);
    if (!edited.length) return false;
    const texts = {};
    const dates = {};
    await Promise.all(edited.map(async (record) => {
        const detail = await loadPromptDetail(record);
        if (!detail || String(detail.id || record.id) !== record.id) return;
        // "" too: an emptied prompt makes its options (and the configs on it) emit nothing.
        texts[record.id] = promptEmittedText(detail);
        dates[record.id] = String(detail.dateModified || record.dateModified);
    }));
    if (!node._ddp || !node.graph) return false;   // removed meanwhile
    const followed = applyPromptTextChanges(node, texts);
    const stamped = stampPromptDates(node, dates);
    if (followed) {
        // The saved presets follow too (a no-op when the server already rewrote them).
        requestConfigSwitcherJson("/presets/heal-prompts", jsonBodyInit("POST", { texts })).catch(() => {});
        console.log(`[KRC Config Switcher] using the current text for ${Object.keys(texts).length} edited prompt(s)`);
    }
    if (followed || stamped) {
        writeData(node);
        renderFields(node);
    }
    return followed;
}
