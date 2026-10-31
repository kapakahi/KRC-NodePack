// Config Switcher combo Capture (CS_COMBO_CAPTURE_GAMEPLAN.md, stage 1): find the node
// inputs a CS parameter feeds through its CS Links, read each one's options, and plan the
// saved list a capture would write. No `app` import: callers pass the root graph and the
// Link -> Config Switcher resolver, so this runs in tests.
import { downstreamInputs, nodeClassName, workflowNodes } from "../shared/graph_walk.js";
import { cleanDynamicSchema, DYNAMIC_COMBO_TYPE as DYNAMIC_FIELD_TYPE, SETTING_TYPES, sameDynamicSchema, supportedOptions } from "./dynamic_combo.js";

export const LINK_NODE_NAME = "KRC Config Switcher Link";
export const DYNAMIC_COMBO_TYPE = "COMFY_DYNAMICCOMBO_V3";
const LINK_DATA_WIDGET = "link_data";

function linkFieldIds(linkNode) {
    const raw = (linkNode?.widgets || []).find((widget) => widget?.name === LINK_DATA_WIDGET)?.value;
    try {
        const fields = Array.isArray(raw) ? raw : JSON.parse(raw || "[]");
        return Array.isArray(fields) ? fields.map((field) => field?.id) : [];
    } catch {
        return [];
    }
}

// Every input the parameter `fieldId` of `switcherNode` feeds: [{node, slot, graph}], from
// each CS Link in the workflow (subgraphs included) whose upstream switcher is this one.
// `switcherOf(linkNode)` resolves a Link's Config Switcher (link.js connectedSwitcherNode).
export function captureTargets(switcherNode, fieldId, { root, switcherOf }) {
    const links = workflowNodes((node) => nodeClassName(node) === LINK_NODE_NAME, root)
        .filter((link) => switcherOf(link) === switcherNode);
    return links.flatMap((link) => {
        const index = linkFieldIds(link).indexOf(fieldId);
        return index < 0 ? [] : downstreamInputs(link, index, { root });
    });
}

function inputSpec(node, name) {
    const input = node?.constructor?.nodeData?.input || {};
    return input.required?.[name] || input.optional?.[name] || null;
}

function cleanValues(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => (value && typeof value === "object" ? value.value ?? value.name ?? "" : value))
        .map((value) => String(value ?? "").trim())
        .filter(Boolean))];
}

// "<Node title> › <input>" for messages.
export function targetLabel({ node, slot }) {
    const input = node?.inputs?.[slot];
    const name = input?.label || input?.localized_name || input?.name || `input ${slot}`;
    return `${node?.title || nodeClassName(node) || "Node"} › ${name}`;
}

// One DynamicCombo option's settings, from the node def's `inputs` (create_input_dict_v1:
// `required` / `optional` maps of [type, spec]). An input CS can't put in a dict (a socket,
// another dynamic type, a nested DynamicCombo) makes the option unsupported (D11 / D12).
function readDynamicOption(option) {
    const inputs = option?.inputs && typeof option.inputs === "object" ? option.inputs : {};
    const settings = [];
    for (const [name, entry] of Object.entries({ ...(inputs.required || {}), ...(inputs.optional || {}) })) {
        const [type, spec = {}] = Array.isArray(entry) ? entry : [];
        if (Array.isArray(type)) {
            settings.push({ name, type: "COMBO", options: type, default: spec.default });
        } else if (type === DYNAMIC_COMBO_TYPE) {
            return { key: option?.key, unsupported: `${name} is a nested DynamicCombo`, settings: [] };
        } else if (SETTING_TYPES.includes(String(type))) {
            settings.push({ ...spec, name, type });
        } else {
            return { key: option?.key, unsupported: `${name} needs a link (${type || "unknown type"})`, settings: [] };
        }
    }
    return { key: option?.key, unsupported: "", settings };
}

// A DynamicCombo input's schema as the field stores it (dynamic_combo.js), or null.
export function readDynamicSchema(inputId, spec) {
    const options = Array.isArray(spec?.[1]?.options) ? spec[1].options : [];
    return cleanDynamicSchema({ inputId, options: options.map(readDynamicOption) });
}

// What one target input offers: {kind: "combo", values} | {kind: "dynamic-combo", keys,
// schema} | {kind: "unreadable"}. Reads the input's combo widget first (hidden, not removed, while
// linked; its values may be a function), then the node definition (legacy
// [[...values], {...}], V3 ["COMBO", {options}], or a DynamicCombo's option keys).
export function targetInputOptions({ node, slot }) {
    const input = node?.inputs?.[slot];
    if (!input) return { kind: "unreadable" };
    const name = input.widget?.name || input.name;
    const spec = inputSpec(node, name);
    if (input.type === DYNAMIC_COMBO_TYPE || spec?.[0] === DYNAMIC_COMBO_TYPE) {
        const options = spec?.[1]?.options;
        return {
            kind: "dynamic-combo",
            keys: cleanValues((Array.isArray(options) ? options : []).map((option) => option?.key)),
            schema: readDynamicSchema(name, spec),
        };
    }
    const widget = (node.widgets || []).find((item) => item?.name === name);
    let values = widget?.options?.values;
    if (typeof values === "function") {
        try {
            values = values(widget, node);
        } catch {
            values = null;
        }
    }
    if (Array.isArray(values)) return { kind: "combo", values: cleanValues(values) };
    if (Array.isArray(spec?.[0])) return { kind: "combo", values: cleanValues(spec[0]) };
    if (spec?.[0] === "COMBO" && Array.isArray(spec?.[1]?.options)) return { kind: "combo", values: cleanValues(spec[1].options) };
    return { kind: "unreadable" };
}

const key = (value) => String(value ?? "").trim().toLowerCase();

// The list a capture would save (gameplan D1, D3, D5, D9, D10), from the current saved
// options and [{label, kind, values | keys}] per target. Pure.
//   -> {options, added, removed, truncated, skipped, differs, unreadable, changed, refused}
// refused = null, or {reason, labels}: "no-targets", "dynamic-combo", "unreadable",
// "empty" (one list, nothing in it) or "disjoint" (several lists, nothing in common).
// The list is never written on a refusal; configs are never touched either way.
export function planComboCapture(currentOptions, results, { cap = 48 } = {}) {
    const current = cleanValues(currentOptions);
    const plan = { options: current, added: [], removed: [], truncated: [], skipped: [], differs: false, unreadable: [], changed: false, refused: null };
    const refuse = (reason, labels = []) => ({ ...plan, refused: { reason, labels } });
    if (!results.length) return refuse("no-targets");
    const dynamic = results.filter((result) => result.kind === "dynamic-combo");
    if (dynamic.length) return refuse("dynamic-combo", dynamic.map((result) => result.label));
    const combos = results.filter((result) => result.kind === "combo");
    plan.unreadable = results.filter((result) => result.kind !== "combo").map((result) => result.label);
    if (!combos.length) return refuse("unreadable", plan.unreadable);

    const lists = combos.map((result) => cleanValues(result.values));
    const signature = (list) => [...new Set(list.map(key))].sort().join("\n");
    plan.differs = lists.some((list) => signature(list) !== signature(lists[0]));
    const union = cleanValues(lists.flat());
    const shared = lists[0].filter((value) => lists.every((list) => list.some((item) => key(item) === key(value))));
    if (!shared.length) {
        return refuse(lists.length > 1 && plan.differs ? "disjoint" : "empty", combos.map((result) => result.label));
    }
    plan.skipped = union.filter((value) => !shared.some((item) => key(item) === key(value)));
    plan.options = shared.slice(0, cap);
    plan.truncated = shared.slice(cap);
    plan.added = plan.options.filter((value) => !current.some((item) => key(item) === key(value)));
    plan.removed = current.filter((value) => !plan.options.some((item) => key(item) === key(value)));
    plan.changed = plan.options.length !== current.length || plan.options.some((value, i) => value !== current[i]);
    return plan;
}

// What a capture would do to `field` (CS_DYNAMIC_COMBO_GAMEPLAN.md D2 / D3 / D10 / D11), from
// [{label, kind, ...}] per target. Pure. -> one of
//   {conversion: "dynamic", schema, unsupported: [{key, reason}], changed, refused: null}
//     DynamicCombo targets: the field becomes / stays a DYNAMIC COMBO with this schema.
//   {conversion: "combo", ...planComboCapture's plan}
//     ordinary combo targets: a list capture; a DYNAMIC COMBO field turns back into a COMBO
//     (its option keys being the list it had).
// or a refusal {conversion: null, refused: {reason, labels}}: planComboCapture's reasons, or
// "mixed" (a DynamicCombo beside an ordinary combo), "schema-differs" (DynamicCombos that
// differ), "unsupported" (no option CS can drive).
export function planCapture(field, results, { cap = 48 } = {}) {
    const refuse = (reason, labels = []) => ({ conversion: null, refused: { reason, labels } });
    if (!results.length) return refuse("no-targets");
    const dynamic = results.filter((result) => result.kind === "dynamic-combo");
    const isDynamic = field?.type === DYNAMIC_FIELD_TYPE;
    if (!dynamic.length) {
        const current = isDynamic ? (field.dynamicCombo?.options || []).map((option) => option.key) : field?.options || [];
        const plan = planComboCapture(current, results, { cap });
        if (plan.refused) return { conversion: null, ...plan };
        return { conversion: "combo", ...plan, changed: plan.changed || isDynamic };
    }
    if (dynamic.length !== results.length) return refuse("mixed", results.map((result) => result.label));
    const schemas = dynamic.map((result) => result.schema);
    if (schemas.some((schema) => !schema)) return refuse("unreadable", dynamic.filter((result) => !result.schema).map((result) => result.label));
    if (schemas.some((schema) => !sameDynamicSchema(schema, schemas[0]))) return refuse("schema-differs", dynamic.map((result) => result.label));
    const schema = schemas[0];
    if (!supportedOptions(schema).length) return refuse("unsupported", dynamic.map((result) => result.label));
    return {
        conversion: "dynamic",
        schema,
        unsupported: schema.options.filter((option) => option.unsupported).map((option) => ({ key: option.key, reason: option.unsupported })),
        changed: !isDynamic || !sameDynamicSchema(field.dynamicCombo, schema),
        refused: null,
    };
}

// Labels of the DynamicCombo inputs a CS Link output feeds (gameplan D10), through
// Reroutes and subgraphs: a linked string can't drive them (ComfyUI expands a DynamicCombo
// from its literal value before the run), so the link warns.
export function dynamicComboTargets(linkNode, outputIndex, { root } = {}) {
    return downstreamInputs(linkNode, outputIndex, { root })
        .filter((target) => targetInputOptions(target).kind === "dynamic-combo")
        .map(targetLabel);
}
