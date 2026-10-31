// Preset group/label helpers, shared so every preset consumer (LoRA Loadout, Word
// Bank, Config Switcher, Prompt Vault) groups, orders, and labels presets identically.
// Groups are now a STORED field on the record (`.group`), not a prefix parsed out of the
// name — records carry a label-only `.name` plus a `.group`. Mirrors utils/preset_naming.py.

export const NONE_PRESET_GROUP = "none";
export const NONE_PRESET_GROUP_LABEL = "--none--";

// Filter sentinels that are never real group names (picker "All" / legacy default).
const RESERVED_GROUP_TOKENS = new Set(["__all__", "__default__"]);

// Normalize a stored group string: empty / --none-- / a filter sentinel collapse to the
// reserved `none` token, and a group never contains ':' (it separates group and label).
export function canonicalGroup(value) {
  const raw = String(value || "").trim();
  if (!raw || RESERVED_GROUP_TOKENS.has(raw) || raw === NONE_PRESET_GROUP_LABEL) {
    return NONE_PRESET_GROUP;
  }
  // '@' can't start a group either (kept from the old combined preset string).
  const cleaned = raw.replace(/:/g, "").trim().replace(/^@+/, "").trim();
  return cleaned || NONE_PRESET_GROUP;
}

// Normalize a preset label: strip only. Labels are free-form and MAY contain ':' — the
// trigger is composed and never re-split.
export function canonicalLabel(value) {
  return String(value || "").trim();
}

// A preset's "group:label" (group defaults none), for display. Nothing matches presets by
// it: loadouts follow preset ids (PRESET_LINK_GAMEPLAN.md).
export function composeTrigger(group, label) {
  const lbl = canonicalLabel(label);
  return lbl ? `${canonicalGroup(group)}:${lbl}` : "";
}

// --- stored-field readers (take a preset RECORD, read `.group` / label `.name`) ------

export function presetGroup(preset) {
  return canonicalGroup(preset?.group);
}

export function presetGroupLabel(preset) {
  const group = presetGroup(preset);
  return group === NONE_PRESET_GROUP ? NONE_PRESET_GROUP_LABEL : group;
}

export function presetDisplayName(preset) {
  return canonicalLabel(preset?.name);
}

// [[value, label], ...] for the group filter: All, --none--, then each distinct stored
// group sorted case-insensitively.
export function presetPrefixOptions(presets) {
  const groups = new Map();
  for (const preset of presets || []) {
    const group = presetGroup(preset);
    if (group !== NONE_PRESET_GROUP && !groups.has(group.toLowerCase())) {
      groups.set(group.toLowerCase(), group);
    }
  }
  const sorted = Array.from(groups.values())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return [
    ["__all__", "All"],
    [NONE_PRESET_GROUP, NONE_PRESET_GROUP_LABEL],
    ...sorted.map((group) => [group, group]),
  ];
}

// Presets under a group filter. "__all__" returns everything, --none-- first then grouped;
// a specific group returns just its members.
export function presetsForPrefix(presets, prefix = "__all__") {
  const filter = prefix || "__all__";
  const list = presets || [];
  if (filter === "__all__") {
    return list.slice().sort((a, b) => {
      const groupA = presetGroupLabel(a);
      const groupB = presetGroupLabel(b);
      if (groupA !== groupB) {
        if (groupA === NONE_PRESET_GROUP_LABEL) return -1;
        if (groupB === NONE_PRESET_GROUP_LABEL) return 1;
        return groupA.localeCompare(groupB, undefined, { sensitivity: "base" });
      }
      return presetDisplayName(a)
        .localeCompare(presetDisplayName(b), undefined, { sensitivity: "base" });
    });
  }
  return list.filter((preset) => presetGroup(preset) === filter);
}

// Normalize a stored group-filter value to a valid option, falling back to "__all__"
// when the stored group no longer exists among the presets.
export function normalizePresetPrefixFilter(presets, value) {
  const filter = value || "__all__";
  if (filter === "__all__") return filter;
  if (filter === "__default__" || filter === NONE_PRESET_GROUP_LABEL) return NONE_PRESET_GROUP;
  if (filter === NONE_PRESET_GROUP) return filter;
  return presetPrefixOptions(presets).some(([group]) => group === filter) ? filter : "__all__";
}

// [{name, value, group}] options for a preset <select>, filtered by group. Leads with a
// "-- none --" (clear) entry; the option value is the preset id (all stores are id-primary).
export function presetOptionsForPrefix(presets, prefix = "__all__") {
  const allPrefixes = (prefix || "__all__") === "__all__";
  return [
    { name: "-- none --", value: "" },
    ...presetsForPrefix(presets, prefix).map((preset) => ({
      name: presetDisplayName(preset),
      value: preset.id,
      group: allPrefixes ? presetGroupLabel(preset) : "",
    })),
  ];
}
