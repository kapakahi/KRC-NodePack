// Config Switcher presets — the server-backed library of complete Config Switcher
// configurations: load / save / revert, and the Modified / Stale baseline.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { api } from "../../../scripts/api.js";
import { carryCardDisplay, scheduleCardCatchUp } from "./card_sync.js";
import { getWidget, h } from "./helpers.js";
import { krcAlert, openKrcModal } from "../shared/modal.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { localStatusBadge } from "../shared/badges.js";
import { classifyLocalStatus, LOCAL_STATUS, statusOverwrites, localStatusCopy } from "../shared/local_status.js";
import { KRC_SYNC_LANES, publishKrcSync } from "../shared/sync_bus.js";
import { forgetInFlight, isWriteRequest, jsonBodyInit, sharedGetJson } from "../shared/api.js";
import { openPresetNameDialog } from "../shared/preset_name_dialog.js";
import { presetConfigValues } from "./seed_values.js";
import { fillUnsavedSeeds } from "./seed_field.js";
import {
    canonicalGroup,
    NONE_PRESET_GROUP,
    normalizePresetPrefixFilter,
    presetGroup,
    presetOptionsForPrefix,
    presetPrefixOptions,
    presetsForPrefix,
} from "../shared/preset_naming.js";
import {
    activeName,
    API_PREFIX,
    CONFIG_PRESETS_CHANGED_EVENT,
    CS_SCHEMA_VERSION,
    explicitDefaultConfig,
    FIELD_TYPES,
    fieldTypeBaseName,
    hasScratchConfig,
    isEditMode,
    MAX_OUTPUTS,
    normalizeField,
    PLACEHOLDER,
    PRESET_CYCLE_SESSION_MS,
    renderBar,
    resolvedDefaultConfig,
    uid,
    writeData,
} from "./config.js";
import { normalizePromptOption } from "./prompt_field.js";
import { numberOutputFormat } from "./value_controls.js";
import { normalizeModelOption } from "./model_field.js";
import { renderAll, resizeConfigNode } from "./field_rows.js";
import { closeConfigActionMenu, resetToBlankSlate, setActive } from "./config_ops.js";

export function requestConfigSwitcherJson(path, options = {}) {
    // Preset reads are shared by every Config Switcher asking at the same time.
    if (!isWriteRequest(options)) {
        return sharedGetJson(`${API_PREFIX}${path}`, () => api.fetchApi(`${API_PREFIX}${path}`, options))
            .then(({ ok, data }) => {
                if (!ok) throw new Error((data && data.error) || "Config Switcher preset request failed.");
                return data;
            });
    }
    return api.fetchApi(`${API_PREFIX}${path}`, options).finally(() => forgetInFlight()).then(async (response) => {
        let data = null;
        try {
            data = await response.json();
        } catch (e) {
            data = null;
        }
        if (!response.ok) {
            throw new Error((data && data.error) || "Config Switcher preset request failed.");
        }
        return data;
    });
}

async function nextPresetName() {
    // Auto-mint a unique label in the none group for the no-dialog initial create.
    const data = await requestConfigSwitcherJson("/presets");
    const taken = new Set(
        (Array.isArray(data?.presets) ? data.presets : [])
            .filter((preset) => presetGroup(preset) === NONE_PRESET_GROUP)
            .map((preset) => preset.name)
    );
    let index = 1;
    while (taken.has(`preset_${index}`)) index += 1;
    return { group: NONE_PRESET_GROUP, name: `preset_${index}` };
}

export async function createInitialPresetWithField(node, type) {
    if (!FIELD_TYPES.includes(type)) return;
    const presetIdentity = await nextPresetName();
    const configName = "config_1";
    node._fields = [{ id: uid(), name: type === "section" ? "" : fieldTypeBaseName(type), type, options: [], numberOutput: type === "number" ? "auto" : "", modelType: "", modelOptions: [], promptOptions: [], stringMultiline: false }];
    node._configs = { [configName]: {} };
    node._sharedValues = {};
    node._configPresetDefault = configName;
    persistConfigPresetDefault(node);
    setActive(node, configName);
    node._configEditMode = true;
    writeData(node);
    renderAll(node);
    const preset = await requestConfigSwitcherJson("/presets", jsonBodyInit("POST", currentPresetPayload(node, presetIdentity)));
    setLoadedPresetSnapshot(node, preset);
    broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.CONTENT);
    renderAll(node);
}

export async function openInitialLoadModal(node) {
    let presets = [];
    let selectedId = "";
    let prefix = node._configPresetPrefixFilter || node.properties?.configPresetPrefixFilter || "__all__";
    const prefixWrap = h("div", { class: "ddp-preset-prefix-wrap" });
    const presetWrap = h("div", { class: "ddp-preset-select-wrap" });
    const prefixSel = createSearchableSelect({
        options: [],
        value: prefix,
        placeholder: "All",
        searchPlaceholder: "Search groups...",
        emptyText: "No groups found.",
        buttonTitle: "Preset group",
        ariaLabel: "Preset group",
        fixedMenu: true,
        menuWidth: 160,
        onSelect: (value) => {
            resetCycleSession();
            prefix = normalizePresetPrefixFilter(presets, value || "__all__");
            node._configPresetPrefixFilter = prefix;
            node.properties ||= {};
            node.properties.configPresetPrefixFilter = prefix;
            selectedId = "";
            presetSel.setOptions(presetOptionsForPrefix(presets, prefix), "");
            refreshLoadControls();
            node.setDirtyCanvas(true, true);
        },
    });
    const presetSel = createSearchableSelect({
        options: [],
        value: "",
        placeholder: "-- none --",
        searchPlaceholder: "Search presets...",
        emptyText: "No presets found.",
        buttonTitle: "Choose a Config Switcher preset",
        ariaLabel: "Config Switcher preset",
        fixedMenu: true,
        menuWidth: 300,
        onSelect: (value) => {
            resetCycleSession();
            if (value) loadInitialPreset(value);
            else {
                selectedId = "";
                resetToBlankSlate(node);
                refreshLoadControls();
            }
        },
    });
    prefixWrap.append(prefixSel.el);
    presetWrap.append(presetSel.el);
    const prevBtn = h("button", {
        class: "krc-icon-button ddp-preset-cycle",
        text: "▲",
        title: "Previous preset",
        onclick: () => cycleInitialPreset(-1),
    });
    const nextBtn = h("button", {
        class: "krc-icon-button ddp-preset-cycle",
        text: "▼",
        title: "Next preset",
        onclick: () => cycleInitialPreset(1),
    });
    const body = h("div", { class: "ddp-options-panel ddp-initial-load-panel" }, [
        h("div", { class: "ddp-options-section" }, [
            h("div", { class: "ddp-options-title", text: "Load Preset" }),
            h("div", { class: "ddp-preset-row ddp-initial-load-row" }, [prefixWrap, presetWrap, prevBtn, nextBtn]),
        ]),
    ]);
    openKrcModal({
        node,
        title: "Load Config Switcher preset",
        body,
        draggable: true,
        dimBackdrop: false,
        onClose: () => resetCycleSession(),
    });
    try {
        const data = await requestConfigSwitcherJson("/presets");
        presets = Array.isArray(data?.presets) ? data.presets : [];
        prefix = normalizePresetPrefixFilter(presets, prefix);
        node._configPresetPrefixFilter = prefix;
        prefixSel.setOptions(presetPrefixOptions(presets).map(([value, name]) => ({ value, name })), prefix);
        presetSel.setOptions(presetOptionsForPrefix(presets, prefix), "");
        refreshLoadControls();
    } catch (e) {
        krcAlert(`Config Switcher: ${e.message || "could not load presets."}`, node);
    }

    function loadInitialPreset(id) {
        const preset = presets.find((item) => item.id === id);
        if (!preset) return;
        selectedId = id;
        presetSel.value = id;
        prefix = presetGroup(preset);
        node._configPresetPrefixFilter = prefix;
        node.properties ||= {};
        node.properties.configPresetPrefixFilter = prefix;
        prefixSel.setValue(prefix);
        presetSel.setOptions(presetOptionsForPrefix(presets, prefix), selectedId);
        if (!applyPreset(node, preset)) return;
        setLoadedPresetSnapshot(node, preset);
        refreshLoadControls();
    }

    function cycleInitialPreset(delta) {
        const scopedPresets = cycleSessionPresets();
        if (!scopedPresets.length) return;
        const index = scopedPresets.findIndex((preset) => preset.id === selectedId);
        const next = index < 0
            ? (delta > 0 ? 0 : scopedPresets.length - 1)
            : (index + delta + scopedPresets.length) % scopedPresets.length;
        loadInitialPreset(scopedPresets[next].id);
    }

    function refreshLoadControls() {
        const hasPresets = presetsForPrefix(presets, prefix).length > 0;
        prevBtn.disabled = !hasPresets;
        nextBtn.disabled = !hasPresets;
    }

    let cycleSession = null;

    function resetCycleSession() {
        if (cycleSession?.timer) clearTimeout(cycleSession.timer);
        cycleSession = null;
    }

    function cycleSessionPresets() {
        const now = Date.now();
        if (!cycleSession || now - cycleSession.lastAt > PRESET_CYCLE_SESSION_MS) {
            cycleSession = { presets: presetsForPrefix(presets, prefix), lastAt: now, timer: null };
        }
        cycleSession.lastAt = now;
        if (cycleSession.timer) clearTimeout(cycleSession.timer);
        cycleSession.timer = setTimeout(() => { cycleSession = null; }, PRESET_CYCLE_SESSION_MS);
        return cycleSession.presets;
    }
}

function normalizeConfigMap(configs) {
    if (!configs || typeof configs !== "object" || Array.isArray(configs)) return {};
    const out = {};
    for (const [name, values] of Object.entries(configs)) {
        if (!name || !values || typeof values !== "object" || Array.isArray(values)) continue;
        out[name] = { ...values };
    }
    return out;
}

function currentPresetPayload(node, identity = {}) {
    const active = activeName(node);
    return {
        id: identity.id || "",
        group: identity.group || "",
        name: identity.name || "",
        fields: (node._fields || []).map(normalizeField),
        shared_values: presetConfigValues((node._fields || []).filter(field => field.shared), node._sharedValues),
        // An unlocked seed's number isn't saved (seed_values.js presetConfigValues). Configs
        // keep their hidden values for shared fields too (restored when Share is off).
        configs: Object.fromEntries(Object.entries(normalizeConfigMap(node._configs))
            .map(([name, values]) => [name, presetConfigValues((node._fields || []).map(normalizeField), values)])),
        default_config: explicitDefaultConfig(node),
        active_config: active && (active !== PLACEHOLDER || hasScratchConfig(node)) ? active : "",
        schema: CS_SCHEMA_VERSION,
    };
}

// "1.5" -> [1, 5]; compared as numbers, so 1.10 is newer than 1.9. Unversioned = 1.0.
function parseSchema(value) {
    const match = /^(\d+)\.(\d+)$/.exec(String(value ?? "1.0").trim() || "1.0");
    return match ? [Number(match[1]), Number(match[2])] : null;
}

// Saved by a newer KRC NodePack (the server keeps such a preset as stored): this page
// would rewrite what it doesn't know, so it never loads one.
export function presetIsNewer(preset) {
    const version = parseSchema(preset?.schema);
    const own = parseSchema(CS_SCHEMA_VERSION);
    return !version || version[0] > own[0] || (version[0] === own[0] && version[1] > own[1]);
}

// The preset's Modified / Stale signature: only what the config is — its fields, the
// values each config outputs, and which model / prompt options each field offers (by
// the value it outputs, order-free). A card's display data (title, thumbnail, colour,
// badge, favorite, NSFW, a prompt's name / category) and a model's identity (id /
// SHA256, which change when it's stabilized) follow the libraries live and never make
// a preset read as changed.
function normalizedPresetSignature(payload) {
    const optionValues = (options, normalize) => [...new Set(
        (Array.isArray(options) ? options : [])
            .map((option) => normalize(option)?.value)
            .filter(Boolean)
            .map(String),
    )].sort();
    const fields = (Array.isArray(payload?.fields) ? payload.fields : [])
        .slice(0, MAX_OUTPUTS)
        .map(normalizeField)
        .map((field) => ({
            id: field.id,
            name: field.name,
            type: field.type,
            options: field.type === "combo" ? (field.options || []).map(String) : [],
            numberOutput: field.type === "number" ? numberOutputFormat(field).id : "",
            modelType: field.type === "model" ? String(field.modelType || "") : "",
            modelOptions: field.type === "model" ? optionValues(field.modelOptions, normalizeModelOption) : [],
            promptOptions: field.type === "prompt" ? optionValues(field.promptOptions, normalizePromptOption) : [],
            stringMultiline: field.type === "string" ? Boolean(field.stringMultiline) : false,
            ...(field.type === "dynamic_combo" ? { dynamicCombo: field.dynamicCombo, dynamicHidden: field.dynamicHidden || [] } : {}),
            ...(field.type === "section" && field.color ? { color: field.color } : {}),
            ...(field.shared ? { shared: true } : {}),
        }));
    // Configs as the server stores them (_clean_configs): names trimmed (blank ones
    // dropped), only the preset's fields, and a seed's number only while locked (its lock
    // and mode always). Comparing anything the save drops would read Modified right
    // after a save, or Stale once refetched.
    const configs = {};
    for (const [rawName, values] of Object.entries(normalizeConfigMap(payload?.configs))) {
        const name = String(rawName).trim();
        if (!name) continue;
        const kept = presetConfigValues(fields, values);
        configs[name] = Object.fromEntries(Object.keys(kept).sort().map((key) => [key, kept[key]]));
    }
    const sortedConfigs = Object.fromEntries(Object.keys(configs).sort().map((name) => [name, configs[name]]));
    return JSON.stringify({
        fields,
        ...(fields.some(field => field.shared) ? { shared_values: presetConfigValues(fields.filter(field => field.shared), payload?.shared_values) } : {}),
        configs: sortedConfigs,
        default_config: String(payload?.default_config || ""),
    });
}

export function configSyncSource(node) {
    node._configSyncSource ||= uid();
    return String(node.id || node._configSyncSource);
}

export function broadcastConfigPresetsChanged(node, lane = KRC_SYNC_LANES.CONTENT, extra = {}) {
    publishKrcSync(CONFIG_PRESETS_CHANGED_EVENT, {
        source: configSyncSource(node),
        lane,
        ...extra,
    });
}

// Load `preset` into the node. A fresh load selects the preset's default config. Discarding
// changes (`keepActive`) stays on the config the user is on when the saved preset has it:
// the default only means "the config a freshly loaded preset opens on".
// -> false (and says why) for a preset this page can't read.
export function applyPreset(node, preset, { keepActive = false } = {}) {
    if (presetIsNewer(preset)) {
        krcAlert(`Config Switcher: "${preset?.name || "this preset"}" was saved by a newer KRC NodePack (presets ${preset?.schema} vs ${CS_SCHEMA_VERSION}). Update KRC NodePack and reload the page to use it.`, node);
        return false;
    }
    const previous = activeName(node);
    const previousFields = node._fields || [];
    node._fields = (Array.isArray(preset?.fields) ? preset.fields : [])
        .slice(0, MAX_OUTPUTS)
        .map(normalizeField);
    // Card thumbnails / colours / badges are live, not saved state: keep the current ones.
    carryCardDisplay(previousFields, node._fields);
    node._configs = normalizeConfigMap(preset?.configs);
    node._sharedValues = { ...(preset?.shared_values || {}) };
    fillUnsavedSeeds(node);   // unlocked seeds aren't saved: each config gets a fresh one
    node._configPresetDefault = preset?.default_config && node._configs[preset.default_config]
        ? preset.default_config
        : "";
    persistConfigPresetDefault(node);
    const keep = keepActive && previous && previous !== PLACEHOLDER && node._configs[previous] ? previous : "";
    const active = keep || resolvedDefaultConfig(node) || PLACEHOLDER;
    setActive(node, active);
    writeData(node);
    renderAll(node);
    resizeConfigNode(node);
    scheduleCardCatchUp(node);
    return true;
}

function configPresetModifiedAt(preset) {
    return Number(preset?.modified) || 0;
}

function configPresetSnapshot(id, preset) {
    if (!id || !preset) return null;
    return {
        id,
        modifiedAt: configPresetModifiedAt(preset),
        signature: normalizedPresetSignature(preset),
    };
}

// The loaded global preset's id. node._configPresetId is what the editor reads; the
// hidden, declared config_preset_id widget mirrors it so an API-format export says which
// preset the node is (the run ignores it); node.properties keeps it with its baseline.
export const PRESET_ID_WIDGET = "config_preset_id";

export function setConfigPresetId(node, id) {
    node._configPresetId = String(id || "").trim();
    const widget = getWidget(node, PRESET_ID_WIDGET);
    if (widget && widget.value !== node._configPresetId) widget.value = node._configPresetId;
}

// The id a node was saved with: the widget (what an export carries), else node.properties.
export function persistedConfigPresetId(node) {
    const widget = getWidget(node, PRESET_ID_WIDGET);
    return String(widget?.value || node.properties?.configPresetId || node._configPresetId || "").trim();
}

export function activeConfigPresetBaseline(node) {
    const id = String(node._configPresetId || "").trim();
    const stored = node._configPresetBaseline || node.properties?.configPresetBaseline || null;
    return stored && stored.id === id ? stored : null;
}

// What the bottom-row label shows: the loaded preset's group + name, or `missing` once the
// library answered without the node's preset id.
function setConfigPresetInfo(node, preset) {
    node._configPresetInfo = preset ? { group: canonicalGroup(preset.group), name: String(preset.name || "") } : null;
}

// The node's preset id isn't in the library (deleted, or a workflow from another machine).
export function markConfigPresetMissing(node) {
    node._configPresetGlobalSignature = "";
    node._configPresetGlobalModifiedAt = 0;
    node._configPresetInfo = { missing: true };
    updatePresetModifiedSlot(node);
}

export function setCurrentConfigPresetGlobal(node, preset) {
    setConfigPresetInfo(node, preset);
    node._configPresetGlobalSignature = preset ? normalizedPresetSignature(preset) : "";
    node._configPresetGlobalModifiedAt = configPresetModifiedAt(preset);
    updatePresetModifiedSlot(node);
}

export function setLoadedPresetSnapshot(node, preset) {
    setConfigPresetId(node, preset?.id);
    setConfigPresetInfo(node, preset);
    const baseline = configPresetSnapshot(node._configPresetId, preset);
    node._configPresetBaseline = baseline;
    node._configPresetGlobalSignature = baseline?.signature || "";
    node._configPresetGlobalModifiedAt = baseline?.modifiedAt || 0;
    // Persist the selected preset id to node.properties (like the prefix filter)
    // so the picker restores its selection across a workflow reload / refresh. The
    // preset's baseline survives too, which lets a sibling save surface as Stale
    // after workflow restore instead of being misread as this node's own edit.
    node.properties ||= {};
    if (node._configPresetId) {
        node.properties.configPresetId = node._configPresetId;
        node.properties.configPresetBaseline = baseline;
    } else {
        delete node.properties.configPresetId;
        delete node.properties.configPresetBaseline;
    }
    updatePresetModifiedSlot(node);
}

export function persistConfigPresetDefault(node) {
    node.properties ||= {};
    if (explicitDefaultConfig(node)) node.properties.configPresetDefault = explicitDefaultConfig(node);
    else delete node.properties.configPresetDefault;
}

export function setConfigPresetDefault(node, name) {
    if (!name || !node._configs?.[name]) return;
    node._configPresetDefault = name;
    persistConfigPresetDefault(node);
    closeConfigActionMenu(node);
    renderBar(node);
    node.setDirtyCanvas(true, true);
}

export function classifyConfigPreset(node) {
    const id = String(node._configPresetId || "").trim();
    if (!id) return LOCAL_STATUS.CLEAN;
    const currentSignature = normalizedPresetSignature(currentPresetPayload(node));
    const globalSignature = node._configPresetGlobalSignature || "";
    const baseline = activeConfigPresetBaseline(node);
    if (!globalSignature && baseline && node._configPresetSnapshotLoading) {
        return currentSignature !== baseline.signature ? LOCAL_STATUS.MODIFIED : LOCAL_STATUS.CLEAN;
    }
    return classifyLocalStatus({
        currentSignature,
        globalSignature,
        loadedGlobalSignature: baseline?.signature || "",
        currentGlobalModifiedAt: node._configPresetGlobalModifiedAt || 0,
        loadedGlobalModifiedAt: baseline?.modifiedAt || 0,
        userTouched: baseline ? currentSignature !== baseline.signature : currentSignature !== globalSignature,
    });
}

function applyConfigPresetSaveButton(node) {
    const button = node._ddp?.savePreset;
    if (!button) return;
    const status = classifyConfigPreset(node);
    const copy = localStatusCopy(status, "preset");
    button.textContent = String(copy.action.label || "SAVE").toLowerCase();
    // In edit mode with nothing to save, the button finishes editing (saveOrFinishEditing).
    const finishes = isEditMode(node) && node._configPresetId && status === LOCAL_STATUS.CLEAN;
    button.title = finishes ? "Saved. Press to finish editing"
        : copy.action.title || "Save current Config Switcher preset";
    button.classList.toggle("is-sync", statusOverwrites(status));
    button.classList.toggle("is-save", !statusOverwrites(status));
}

export async function restorePersistedPresetSnapshot(node) {
    const id = persistedConfigPresetId(node);
    if (!id) {
        updatePresetModifiedSlot(node);
        return;
    }
    setConfigPresetId(node, id);
    const stored = node.properties?.configPresetBaseline;
    if (stored && stored.id === id) {
        node._configPresetBaseline = stored;
    }
    const token = uid();
    node._configPresetSnapshotRequest = token;
    node._configPresetSnapshotLoading = true;
    updatePresetModifiedSlot(node);
    try {
        const data = await requestConfigSwitcherJson("/presets");
        if (node._configPresetSnapshotRequest !== token) return;
        const preset = (Array.isArray(data?.presets) ? data.presets : []).find((item) => item.id === id);
        if (preset) {
            if (!Object.prototype.hasOwnProperty.call(node.properties || {}, "configPresetDefault")) {
                node._configPresetDefault = preset.default_config && node._configs?.[preset.default_config]
                    ? preset.default_config
                    : "";
                persistConfigPresetDefault(node);
                renderBar(node);
            }
            if (activeConfigPresetBaseline(node)) {
                setCurrentConfigPresetGlobal(node, preset);
            } else {
                setLoadedPresetSnapshot(node, preset);
            }
        } else {
            markConfigPresetMissing(node);
        }
    } catch (e) {
        console.warn("[KRC Config Switcher] Could not restore preset modified baseline", e);
        updatePresetModifiedSlot(node);
    } finally {
        if (node._configPresetSnapshotRequest === token) {
            node._configPresetSnapshotLoading = false;
            updatePresetModifiedSlot(node);
        }
    }
}

export async function refreshConfigPresetGlobalSnapshot(node) {
    const id = String(node._configPresetId || "").trim();
    if (!id) {
        updatePresetModifiedSlot(node);
        return;
    }
    try {
        const data = await requestConfigSwitcherJson("/presets");
        const preset = (Array.isArray(data?.presets) ? data.presets : []).find((item) => item.id === id);
        if (preset) {
            setCurrentConfigPresetGlobal(node, preset);
        } else {
            markConfigPresetMissing(node);
        }
    } catch (e) {
        console.warn("[KRC Config Switcher] Could not refresh preset global snapshot", e);
        updatePresetModifiedSlot(node);
    }
}

export function updatePresetModifiedSlot(node) {
    const slot = node._ddp?.presetModSlot;
    const status = classifyConfigPreset(node);
    if (slot) {
        slot.replaceChildren();
        if (status !== LOCAL_STATUS.CLEAN) {
            slot.appendChild(localStatusBadge({
                copy: localStatusCopy(status, "preset"),
                className: "krc-preset-modified-badge ddp-top-modified-badge",
                onDiscard: () => revertLoadedPreset(node),
                // Conflict: Keep my changes = save this node over the newer saved preset.
                onKeep: () => savePresetForNode(node),
            }));
        }
    }
    applyConfigPresetSaveButton(node);
    renderPresetLabel(node);
}

const MISSING_PRESET_TITLE = "This preset and its configs aren't on this server. Save to keep this workflow's configs.";

// Empty until the library has answered (a restore shows nothing rather than a guess).
function renderPresetLabel(node) {
    const label = node._ddp?.presetLabel;
    if (!label) return;
    const info = node._configPresetId ? node._configPresetInfo : null;
    const text = !info ? "" : info.missing ? "Preset does not exist"
        : info.group === NONE_PRESET_GROUP ? info.name : `${info.group} · ${info.name}`;
    label.textContent = text;
    label.title = info?.missing ? MISSING_PRESET_TITLE : text;
    label.classList.toggle("is-missing", Boolean(info?.missing));
}

export async function savePresetForNode(node, { identity = null } = {}) {
    // identity: { id, group, name } for a save over an existing preset (silent) or a
    // dialog result for a new one. Null => prompt for group + name (a brand-new preset).
    let resolved = identity;
    try {
        if (!resolved) {
            const data = await requestConfigSwitcherJson("/presets");
            const presets = Array.isArray(data?.presets) ? data.presets : [];
            // Save over the currently-loaded preset silently (keeps its id/group/name);
            // only a brand-new preset (nothing loaded) prompts for group + name. The
            // node-level Save button reaches savePresetForNode directly (saveCurrentPreset
            // lives in the IO modal and is out of scope here), so without this it always
            // prompted even with a preset loaded.
            const loaded = node._configPresetId
                ? presets.find((preset) => preset.id === node._configPresetId)
                : null;
            if (loaded) {
                resolved = { id: loaded.id, group: canonicalGroup(loaded.group), name: loaded.name || "" };
            } else {
                const result = await openPresetNameDialog({
                    node,
                    title: "Save preset",
                    presets,
                    group: normalizePresetPrefixFilter(presets, node._configPresetPrefixFilter),
                    confirmTitle: "Save preset",
                });
                if (!result) return null;
                resolved = { id: "", group: result.group, name: result.name };
            }
        }
        if (!resolved.name) return null;
        const preset = await requestConfigSwitcherJson("/presets", jsonBodyInit("POST", currentPresetPayload(node, resolved)));
        setLoadedPresetSnapshot(node, preset);
        updatePresetModifiedSlot(node);
        broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.CONTENT);
        return preset;
    } catch (e) {
        krcAlert(`Config Switcher: ${e.message || "could not save preset."}`, node);
        return null;
    }
}

export async function revertLoadedPreset(node) {
    const id = node._configPresetId;
    if (!id) return;
    try {
        const data = await requestConfigSwitcherJson("/presets");
        const preset = (Array.isArray(data?.presets) ? data.presets : []).find((item) => item.id === id);
        if (!preset) {
            setLoadedPresetSnapshot(node, null);
            updatePresetModifiedSlot(node);
            return;
        }
        if (!applyPreset(node, preset, { keepActive: true })) return;
        setLoadedPresetSnapshot(node, preset);
        updatePresetModifiedSlot(node);
    } catch (e) {
        krcAlert(`Config Switcher: ${e.message || "could not reload preset."}`, node);
    }
}
