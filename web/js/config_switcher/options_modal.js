// Config Switcher Options modal: server-backed presets (new, duplicate, rename, delete,
// save), per-node display options, the node palette, and the note that import / export
// lives in the KRC Portal.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { h } from "./helpers.js";
import { krcAlert, openKrcModal } from "../shared/modal.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { buildNodePaletteField } from "../shared/node_palette.js";
import { createSearchableSelect } from "../shared/searchable_select.js";
import { localStatusBadge } from "../shared/badges.js";
import { LOCAL_STATUS, statusOverwrites, localStatusCopy } from "../shared/local_status.js";
import { isOwnSyncEvent, KRC_SYNC_LANES, subscribeKrcSync } from "../shared/sync_bus.js";
import { nodeTransferRow } from "../shared/transfer/node_transfer_row.js";
import { jsonBodyInit } from "../shared/api.js";
import { openPresetNameDialog } from "../shared/preset_name_dialog.js";
import {
    canonicalGroup,
    normalizePresetPrefixFilter,
    presetGroup,
    presetOptionsForPrefix,
    presetPrefixOptions,
    presetsForPrefix,
} from "../shared/preset_naming.js";
import {
    CARD_VIEW_CARD,
    CARD_VIEW_LIST,
    CARD_VIEW_LIST_TEXT,
    CARD_VIEW_VALUES,
    cardViewMode,
    CONFIG_PRESETS_CHANGED_EVENT,
    CS_SCHEMA_VERSION,
    DROPDOWN_SORT_AZ,
    DROPDOWN_SORT_EXISTING,
    DROPDOWN_SORT_VALUES,
    dropdownSortMode,
    PRESET_CYCLE_SESSION_MS,
} from "./config.js";
import { closePromptOptionMenu } from "./prompt_field.js";
import {
    activeConfigPresetBaseline,
    applyPreset,
    broadcastConfigPresetsChanged,
    classifyConfigPreset,
    configSyncSource,
    persistedConfigPresetId,
    presetIsNewer,
    requestConfigSwitcherJson,
    revertLoadedPreset,
    savePresetForNode,
    setConfigPresetId,
    markConfigPresetMissing,
    setCurrentConfigPresetGlobal,
    setLoadedPresetSnapshot,
} from "./presets.js";
import { closeStringOptionMenu } from "./value_controls.js";
import { followGroupChange, groupChangeDetail, presetGroupMenu } from "../shared/preset_group_actions.js";
import { closeModelOptionMenu } from "./model_field.js";
import { renderFields } from "./field_rows.js";
import { resetToBlankSlate, uniqueCopyName } from "./config_ops.js";

// Options dialog: server-backed presets plus archive import/export.
export function openIOModal(node) {
    let presets = [];
    // Restore the persisted preset selection (the hidden widget / node.properties) when
    // the runtime field was cleared by a fresh page load.
    setConfigPresetId(node, node._configPresetId || persistedConfigPresetId(node));
    let selectedId = node._configPresetId || "";
    node._configPresetPrefixFilter = node._configPresetPrefixFilter || node.properties?.configPresetPrefixFilter || "__all__";

    const prefixWrap = h("div", { class: "ddp-preset-prefix-wrap" });
    const presetWrap = h("div", { class: "ddp-preset-select-wrap" });
    const modSlot = h("div", { class: "ddp-preset-mod-slot" });
    const prefixSel = createSearchableSelect({
        options: groupOptions(),
        value: node._configPresetPrefixFilter,
        placeholder: "All",
        searchPlaceholder: "Search groups...",
        emptyText: "No groups found.",
        buttonTitle: "Preset group",
        ariaLabel: "Preset group",
        fixedMenu: true,
        menuWidth: 160,
        // "⋯" per group: Rename / Ungroup / Delete group.
        optionMenu: presetGroupMenu({
            node,
            presets: () => presets,
            base: "/krc/config-switcher/presets",
            onDone: applyGroupChange,
        }),
        optionMenuTitle: "Group actions",
        onSelect: (value) => {
            resetCycleSession();
            setPresetPrefixFilter(value || "__all__");
            // The previously selected preset belongs to a different prefix, so it
            // no longer exists in this scope — revert the picker to "-- none --".
            selectedId = "";
            presetSel.value = "";
            setLoadedPresetSnapshot(node, null);
            presetSel.setOptions(presetOptionsForPrefix(presets, node._configPresetPrefixFilter), "");
            refreshControls();
        },
    });
    const presetSel = createSearchableSelect({
        options: presetOptionsForPrefix(presets, node._configPresetPrefixFilter),
        value: selectedId,
        placeholder: "-- none --",
        searchPlaceholder: "Search presets...",
        emptyText: "No presets found.",
        buttonTitle: "Choose a Config Switcher preset",
        ariaLabel: "Config Switcher preset",
        fixedMenu: true,
        menuWidth: 300,
        onSelect: (value) => {
            resetCycleSession();
            if (value) loadPreset(value);
            else {
                selectedId = "";
                resetToBlankSlate(node);
                refreshControls();
            }
        },
    });
    prefixWrap.append(prefixSel.el);
    presetWrap.append(presetSel.el, modSlot);

    const prevBtn = h("button", {
        class: "krc-icon-button ddp-preset-cycle",
        text: "▲",
        title: "Previous preset",
        onclick: () => cyclePreset(-1),
    });
    const nextBtn = h("button", {
        class: "krc-icon-button ddp-preset-cycle",
        text: "▼",
        title: "Next preset",
        onclick: () => cyclePreset(1),
    });

    const newBtn = h("button", {
        class: "krc-action-button ddp-preset-btn",
        text: "New",
        title: "Clear the node for a new preset",
        onclick: () => {
            selectedId = "";
            presetSel.value = "";
            resetToBlankSlate(node);
            refreshControls();
        },
    });
    const saveBtn = h("button", {
        class: "krc-action-button ddp-preset-btn is-save",
        text: "Save",
        title: "Save current parameters and configs as a preset",
        onclick: () => saveCurrentPreset(),
    });
    const renameBtn = h("button", {
        class: "krc-action-button ddp-preset-btn",
        text: "Rename",
        title: "Rename selected preset",
        onclick: () => renameCurrentPreset(),
    });
    const dupBtn = h("button", {
        class: "krc-action-button ddp-preset-btn",
        text: "Duplicate",
        title: "Duplicate selected preset",
        onclick: () => duplicateCurrentPreset(),
    });
    const removeBtn = h("button", {
        class: "krc-action-button ddp-preset-btn is-delete",
        text: "Delete",
        title: "Delete selected preset",
    });
    const removeConfirm = armConfirmButton(removeBtn, {
        restoreText: "Delete",
        shouldArm: () => Boolean(selectedId),
        onConfirm: () => removeCurrentPreset(),
    });

    // This node's presets as a KRC bundle section (everything else: Portal ▸ Import and Export).
    const archiveRow = nodeTransferRow({ node, sections: ["config_switcher_presets"], label: "Config Switcher presets" });
    const sortSel = createSearchableSelect({
        options: [
            { value: DROPDOWN_SORT_AZ, name: "A-Z" },
            { value: DROPDOWN_SORT_EXISTING, name: "Date Added" },
        ],
        value: dropdownSortMode(node),
        placeholder: "A-Z",
        searchPlaceholder: "Search sort modes...",
        emptyText: "No sort modes found.",
        buttonTitle: "Drop Down Sort by",
        ariaLabel: "Drop Down Sort by",
        fixedMenu: true,
        menuWidth: 200,
        onSelect: (value) => setDropdownSortMode(value),
    });
    const sortWrap = h("div", { class: "ddp-preset-prefix-wrap ddp-dropdown-sort-wrap" }, [sortSel.el]);

    // Model/prompt card view. "List-view card mode" is the master toggle: off = the
    // default tall card, on = the compact list row (tiny thumbnail by default).
    // "Text-only" is a sub-option of list view that drops the thumbnail; it's disabled
    // (and dimmed) while list mode is off. The active mode is the single source of
    // truth — both toggles derive their state from it.
    const makeViewSwitch = (title, onClick) => h("button", {
        class: "ddp-bool-toggle",
        type: "button",
        title,
        onclick: onClick,
    }, [h("span", { class: "ddp-bool-track" }, [h("span", { class: "ddp-bool-knob" })])]);
    const listModeToggle = makeViewSwitch("Show model & prompt cards as compact list rows", () => {
        const listOn = cardViewMode(node) !== CARD_VIEW_CARD;
        setConfigCardView(listOn ? CARD_VIEW_CARD : CARD_VIEW_LIST);
        syncCardViewToggles();
    });
    const textOnlyToggle = makeViewSwitch("List rows without the thumbnail (text only)", () => {
        if (cardViewMode(node) === CARD_VIEW_CARD) return; // sub-option; inert while card view
        setConfigCardView(cardViewMode(node) === CARD_VIEW_LIST_TEXT ? CARD_VIEW_LIST : CARD_VIEW_LIST_TEXT);
        syncCardViewToggles();
    });
    const textOnlyRow = h("div", { class: "ddp-card-view-row" }, [
        h("span", { class: "ddp-card-view-label", text: "Text-only" }),
        textOnlyToggle,
    ]);
    const syncCardViewToggles = () => {
        const mode = cardViewMode(node);
        const listOn = mode !== CARD_VIEW_CARD;
        listModeToggle.classList.toggle("is-on", listOn);
        listModeToggle.setAttribute("aria-pressed", listOn ? "true" : "false");
        const textOn = mode === CARD_VIEW_LIST_TEXT;
        textOnlyToggle.classList.toggle("is-on", textOn);
        textOnlyToggle.setAttribute("aria-pressed", textOn ? "true" : "false");
        textOnlyToggle.disabled = !listOn;
        textOnlyRow.classList.toggle("is-disabled", !listOn);
    };
    syncCardViewToggles();
    const cardViewRows = h("div", { class: "ddp-card-view-rows" }, [
        h("div", { class: "ddp-card-view-row" }, [
            h("span", { class: "ddp-card-view-label", text: "List-view card mode" }),
            listModeToggle,
        ]),
        textOnlyRow,
    ]);

    const body = h("div", { class: "ddp-options-panel" }, [
        h("div", { class: "ddp-options-section ddp-preset-section" }, [
            h("div", { class: "ddp-options-title", text: "Presets" }),
            h("div", { class: "ddp-preset-row" }, [prefixWrap, presetWrap, prevBtn, nextBtn]),
            h("div", { class: "ddp-preset-actions" }, [newBtn, dupBtn, removeBtn, renameBtn, saveBtn]),
        ]),
        h("div", { class: "ddp-options-section" }, [
            archiveRow,
        ]),
        h("div", { class: "ddp-options-section" }, [
            h("div", { class: "ddp-options-title", text: "Drop Down Sort by:" }),
            sortWrap,
        ]),
        h("div", { class: "ddp-options-section" }, [
            h("div", { class: "ddp-options-title", text: "Appearance" }),
            buildNodePaletteField({ node, root: node._ddp.wrap }),
            h("div", { class: "ddp-card-view-subtitle", text: "Model & prompt card view" }),
            cardViewRows,
        ]),
    ]);

    let unsubscribeModalPresetChanges = null;
    openKrcModal({
        node,
        title: "Config Switcher options",
        body,
        draggable: true,
        dimBackdrop: false,
        onClose: () => {
            resetCycleSession();
            unsubscribeModalPresetChanges?.();
            unsubscribeModalPresetChanges = null;
            node._configOptionsModalOpen = false;
        },
    });

    // While this modal is open it owns the sibling-change refresh (its reloadPresets
    // rebuilds the dropdown and updates the snapshot); the node-level subscriber
    // stands down so a single sibling event doesn't fire two /presets fetches.
    node._configOptionsModalOpen = true;
    unsubscribeModalPresetChanges = subscribeKrcSync(CONFIG_PRESETS_CHANGED_EVENT, (event) => {
        if (isOwnSyncEvent(event, configSyncSource(node))) return;
        // A group renamed / ungrouped / deleted elsewhere: a filter on it follows.
        const followed = followGroupChange(node._configPresetPrefixFilter, event);
        if (followed !== node._configPresetPrefixFilter) setPresetPrefixFilter(followed);
        reloadPresets(selectedId);
    });
    reloadPresets(selectedId);

    function groupOptions() {
        return presetPrefixOptions(presets).map(([value, name]) => ({ value, name }));
    }

    // After a group action: a filter on that group follows it (new name, --none--, or All),
    // and the event's groupChange moves other Config Switchers' filters too.
    async function applyGroupChange(change) {
        if (node._configPresetPrefixFilter === change.from) setPresetPrefixFilter(change.to);
        broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.STRUCTURE, groupChangeDetail(change));
        await reloadPresets(selectedId);
    }

    function setPresetPrefixFilter(value) {
        node._configPresetPrefixFilter = value || "__all__";
        node.properties ||= {};
        node.properties.configPresetPrefixFilter = node._configPresetPrefixFilter;
        node.setDirtyCanvas(true, true);
    }

    function setDropdownSortMode(value) {
        const next = DROPDOWN_SORT_VALUES.has(value) ? value : DROPDOWN_SORT_AZ;
        node.properties ||= {};
        node.properties.configDropdownSort = next;
        closeStringOptionMenu(node);
        closeModelOptionMenu(node);
        closePromptOptionMenu(node);
        renderFields(node);
        node.setDirtyCanvas(true, true);
    }

    function setConfigCardView(value) {
        const next = CARD_VIEW_VALUES.has(value) ? value : CARD_VIEW_CARD;
        node.properties ||= {};
        node.properties.configCardView = next;
        closeModelOptionMenu(node);
        closePromptOptionMenu(node);
        renderFields(node); // ends in resizeConfigNode — the row height changes with the view
        node.setDirtyCanvas(true, true);
    }

    async function reloadPresets(selectId = "", { rebaseline = false } = {}) {
        try {
            const data = await requestConfigSwitcherJson("/presets");
            presets = Array.isArray(data?.presets) ? data.presets : [];
            const selectedPreset = presets.find((preset) => preset.id === selectId);
            selectedId = selectedPreset ? selectId : "";
            setPresetPrefixFilter(normalizePresetPrefixFilter(presets, node._configPresetPrefixFilter));
            if (selectedPreset) {
                if (rebaseline || !activeConfigPresetBaseline(node) || node._configPresetId !== selectedId) {
                    setLoadedPresetSnapshot(node, selectedPreset);
                } else {
                    setCurrentConfigPresetGlobal(node, selectedPreset);
                }
            } else if (selectId && node._configPresetId === selectId) {
                markConfigPresetMissing(node);
            } else {
                setLoadedPresetSnapshot(node, null);
            }
            prefixSel.setOptions(groupOptions(), node._configPresetPrefixFilter);
            presetSel.setOptions(presetOptionsForPrefix(presets, node._configPresetPrefixFilter), selectedId);
            refreshControls();
        } catch (e) {
            krcAlert(`Config Switcher: ${e.message || "could not load presets."}`, node);
        }
    }

    function refreshControls() {
        removeConfirm.reset();
        const hasSelection = Boolean(selectedId);
        renameBtn.disabled = !hasSelection;
        dupBtn.disabled = !hasSelection;
        removeBtn.disabled = !hasSelection;
        prevBtn.disabled = nextBtn.disabled = presetsForPrefix(presets, node._configPresetPrefixFilter).length === 0;
        modSlot.replaceChildren();
        const status = classifyConfigPreset(node);
        if (status !== LOCAL_STATUS.CLEAN) {
            modSlot.appendChild(localStatusBadge({
                copy: localStatusCopy(status, "preset"),
                className: "krc-preset-modified-badge",
                onDiscard: async () => {
                    if (status === LOCAL_STATUS.MISSING) {
                        await revertLoadedPreset(node);
                        refreshControls();
                        return;
                    }
                    loadPreset(selectedId || node._configPresetId, { keepActive: true });
                },
                // Conflict: Keep my changes = this modal's Save (over the selected preset).
                onKeep: () => saveCurrentPreset(),
            }));
        }
        const copy = localStatusCopy(status, "preset");
        saveBtn.textContent = copy.action.label.charAt(0) + copy.action.label.slice(1).toLowerCase();
        saveBtn.title = copy.action.title || "Save current parameters and configs as a preset";
        saveBtn.classList.toggle("is-sync", statusOverwrites(status));
        saveBtn.classList.toggle("is-save", !statusOverwrites(status));
    }

    function findPreset(id) {
        return presets.find((preset) => preset.id === id);
    }

    // `keepActive`: Discard stays on the current config (applyPreset); picking a preset is a
    // fresh load and opens on its default config.
    function loadPreset(id, { keepActive = false } = {}) {
        const preset = findPreset(id);
        if (!preset) return;
        selectedId = id;
        presetSel.value = id;
        setPresetPrefixFilter(presetGroup(preset));
        prefixSel.setValue(node._configPresetPrefixFilter);
        presetSel.setOptions(presetOptionsForPrefix(presets, node._configPresetPrefixFilter), selectedId);
        if (!applyPreset(node, preset, { keepActive })) return;
        setLoadedPresetSnapshot(node, preset);
        refreshControls();
    }

    function cyclePreset(delta) {
        const scopedPresets = cycleSessionPresets();
        if (!scopedPresets.length) return;
        const index = scopedPresets.findIndex((preset) => preset.id === selectedId);
        const next = index < 0
            ? (delta > 0 ? 0 : scopedPresets.length - 1)
            : (index + delta + scopedPresets.length) % scopedPresets.length;
        loadPreset(scopedPresets[next].id);
    }

    let cycleSession = null;

    function resetCycleSession() {
        if (cycleSession?.timer) clearTimeout(cycleSession.timer);
        cycleSession = null;
    }

    function cycleSessionPresets() {
        const now = Date.now();
        if (!cycleSession || now - cycleSession.lastAt > PRESET_CYCLE_SESSION_MS) {
            cycleSession = { presets: presetsForPrefix(presets, node._configPresetPrefixFilter), lastAt: now, timer: null };
        }
        cycleSession.lastAt = now;
        if (cycleSession.timer) clearTimeout(cycleSession.timer);
        cycleSession.timer = setTimeout(() => { cycleSession = null; }, PRESET_CYCLE_SESSION_MS);
        return cycleSession.presets;
    }

    async function saveCurrentPreset() {
        // Saving over the selected preset is silent (keeps its id/group/name); a
        // brand-new preset prompts for group + name.
        let identity;
        if (selectedId) {
            const current = findPreset(selectedId);
            identity = { id: selectedId, group: presetGroup(current), name: current?.name || "" };
        } else {
            const result = await openPresetNameDialog({
                node,
                title: "Save preset",
                presets,
                group: normalizePresetPrefixFilter(presets, node._configPresetPrefixFilter),
                confirmTitle: "Save preset",
            });
            if (!result) return;
            identity = { id: "", group: result.group, name: result.name };
        }
        const preset = await savePresetForNode(node, { identity });
        if (!preset) return;
        setPresetPrefixFilter(presetGroup(preset));
        await reloadPresets(preset.id);
    }

    async function renameCurrentPreset() {
        if (!selectedId) return;
        const current = findPreset(selectedId);
        if (!current) return;
        const currentGroup = presetGroup(current);
        const result = await openPresetNameDialog({
            node,
            title: "Rename preset",
            presets,
            group: currentGroup,
            name: current.name,
            confirmTitle: "Rename preset",
            validateName: ({ group, name }) => (
                presets.some((preset) => preset.id !== selectedId && presetGroup(preset) === group && preset.name === name)
                    ? "A preset with that group + name already exists." : ""
            ),
        });
        if (!result) return;
        const { group, name } = result;
        if (canonicalGroup(group) === currentGroup && name === current.name) return;
        try {
            const res = await requestConfigSwitcherJson("/presets/rename", jsonBodyInit("POST", { id: selectedId, group, new: name }));
            if (!res?.ok) throw new Error("could not rename preset (the group + name may be taken).");
            setPresetPrefixFilter(canonicalGroup(group));
            broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.STRUCTURE);
            // The id is unchanged across a rename, so keep the selection.
            await reloadPresets(selectedId, { rebaseline: true });
        } catch (e) {
            krcAlert(`Config Switcher: ${e.message || "could not rename preset."}`, node);
        }
    }

    async function duplicateCurrentPreset() {
        const source = findPreset(selectedId);
        if (!source) return;
        // A copy would be cleaned down to what this page knows.
        if (presetIsNewer(source)) {
            krcAlert(`Config Switcher: "${source.name}" was saved by a newer KRC NodePack. Update KRC NodePack to copy it.`, node);
            return;
        }
        const sourceGroup = presetGroup(source);
        const takenInGroup = new Set(presets.filter((preset) => presetGroup(preset) === sourceGroup).map((preset) => preset.name));
        const result = await openPresetNameDialog({
            node,
            title: "Duplicate preset",
            presets,
            group: sourceGroup,
            name: uniqueCopyName(source.name, takenInGroup),
            confirmTitle: "Duplicate preset",
            validateName: ({ group, name }) => (
                presets.some((preset) => presetGroup(preset) === group && preset.name === name)
                    ? "A preset with that group + name already exists." : ""
            ),
        });
        if (!result) return;
        const { group, name } = result;
        try {
            // id "" mints a distinct identity; the source's fields/configs are copied.
            const saved = await requestConfigSwitcherJson("/presets", jsonBodyInit("POST", { ...source, id: "", group, name, schema: CS_SCHEMA_VERSION }));
            setPresetPrefixFilter(canonicalGroup(group));
            broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.STRUCTURE);
            await reloadPresets(saved?.id || "", { rebaseline: true });
        } catch (e) {
            krcAlert(`Config Switcher: ${e.message || "could not duplicate preset."}`, node);
        }
    }

    async function removeCurrentPreset() {
        if (!selectedId) return;
        try {
            await requestConfigSwitcherJson("/presets", jsonBodyInit("DELETE", { id: selectedId }));
            selectedId = "";
            resetToBlankSlate(node);
            broadcastConfigPresetsChanged(node, KRC_SYNC_LANES.STRUCTURE);
            await reloadPresets("");
        } catch (e) {
            krcAlert(`Config Switcher: ${e.message || "could not remove preset."}`, node);
        }
    }
}
