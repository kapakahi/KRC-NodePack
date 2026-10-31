import { thumbnailBox } from "../shared/browser_cards.js";
// Config Switcher Prompt field — a dedicated PROMPT type that behaves like MODEL: a visible
// card, a dropdown of remembered Prompt Vault cards (drop several, switch between them),
// and a snapshot value. Unlike MODEL (value = a path/identity), a prompt option's
// `value` IS the snapshotted prompt text — the emitted output — so the backend stays
// a plain str(value). CS Link keeps graph sockets wildcard for rebuild stability.
// The card is display metadata matched to the active value; the record id (else
// category + name) lets the text follow the prompt's saved edits (followPromptEdits).
// Also here: reading prompt-card drags, snapshotting a dropped record's text, prompt drops
// onto raw STRING inputs, and dragging a prompt card out.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { api } from "../../../scripts/api.js";
import { h } from "./helpers.js";
import { localImageUrl } from "../shared/dom.js";
import { openLibraryModal } from "../shared/library_modal.js";
import {
    clearKrcDragPayload,
    getKrcDragPayload,
    setKrcDragPayload,
} from "../shared/drag_payload.js";
import { renderModelCard } from "../shared/model_card.js";
import { promptCardThumbnailUrl, promptThumbnailUrl } from "../prompt_vault/api.js";
import {
    activeConfigValues,
    applyFloatingMenuPalette,
    compareDropdownText,
    DROPDOWN_SORT_AZ,
    dropdownSortMode,
    isEditMode,
    MODEL_CARD_W,
    MODEL_MENU_PAD_X,
    PROMPT_VAULT_API_PREFIX,
    writeData,
} from "./config.js";
import {
    clearModelOptionRow,
    fillExternalCardBadges,
    placeFloatingCardMenu,
    wireCardMenuOutsideClose,
} from "./model_field.js";
import { renderFields } from "./field_rows.js";

function promptPreview(text) {
    const flat = String(text || "").replace(/\s+/g, " ").trim();
    return flat.length > 48 ? `${flat.slice(0, 47)}…` : (flat || "Prompt");
}

export function normalizePromptOption(option = {}) {
    const value = String(option.value ?? option.text ?? "");
    // A blank option is kept only while it's linked (its Prompt Vault prompt was emptied):
    // it follows the prompt's next text. A blank hand-made one is nothing.
    if (!value && !(option.id || (option.category && option.name))) return null;
    return {
        value,
        // The Prompt Vault record id: stable across renames and category moves, so live
        // updates find the card after either (applyPromptLibraryToOptions).
        id: String(option.id || ""),
        profileId: String(option.profileId || "default"),
        // The record's dateModified when this text was taken: a newer one means the
        // prompt was edited and saved since (followPromptEdits). Not in the signature.
        dateModified: String(option.dateModified || ""),
        title: String(option.title || option.name || promptPreview(value)),
        category: String(option.category || ""),
        name: String(option.name || option.title || ""),
        thumbnail: String(option.thumbnail || option.thumbnailUrl || ""),
        previewVideoUrl: String(option.previewVideoUrl || ""),
        cardColor: String(option.cardColor || ""),
        customBadge: String(option.customBadge || ""),
        favorite: Boolean(option.favorite),
        nsfw: Boolean(option.nsfw),
    };
}

// Live prompt cards (CS_LIVE_CARDS_GAMEPLAN.md step 3): Prompt Vault announces its whole
// library on every save and load; point each prompt option at its record — by record id
// (survives renames and category moves), else by category + name — and copy the card's
// display data. The text is followed separately (followPromptEdits), since the library
// announce carries no prompt text. Returns whether anything changed.
export function applyPromptLibraryToOptions(node, prompts) {
    if (!prompts || typeof prompts !== "object") return false;
    const byId = new Map();
    for (const [category, bucket] of Object.entries(prompts)) {
        if (!bucket || typeof bucket !== "object") continue;
        for (const [name, record] of Object.entries(bucket)) {
            if (name === "__meta__" || !record || typeof record !== "object") continue;
            if (record.id) byId.set(String(record.id), { category: record.category || category, name: record.name || name, record });
        }
    }
    let changed = false;
    for (const field of node._fields || []) {
        if (field?.type !== "prompt" || !Array.isArray(field.promptOptions)) continue;
        for (const option of field.promptOptions) {
            if (!option) continue;
            let hit = option.id ? byId.get(String(option.id)) : null;
            if (!hit && !option.id && option.category && option.name) {
                const record = prompts[option.category]?.[option.name];
                if (record && typeof record === "object") hit = { category: option.category, name: option.name, record };
            }
            if (!hit) continue;
            const { category, name, record } = hit;
            const next = {
                id: String(record.id || option.id || ""),
                profileId: String(record.profileId || option.profileId || "default"),
                title: name,
                name,
                category,
                thumbnail: promptCardThumbnailUrl(record),
                previewVideoUrl: record.thumbType === "video" ? promptThumbnailUrl(record, "animated") : "",
                cardColor: String(record.cardColor || ""),
                customBadge: String(record.customBadge || ""),
                favorite: Boolean(record.favorite),
                nsfw: Boolean(record.nsfw),
            };
            for (const [key, value] of Object.entries(next)) {
                if (option[key] !== value) { option[key] = value; changed = true; }
            }
        }
    }
    return changed;
}

function rememberPromptOption(field, option) {
    const normalized = normalizePromptOption(option);
    if (!normalized) return null;
    field.promptOptions = Array.isArray(field.promptOptions) ? field.promptOptions.filter(Boolean) : [];
    field.promptOptions = [normalized, ...field.promptOptions.filter((item) => item.value !== normalized.value)].slice(0, 24);
    return normalized;
}

function selectedPromptOption(field, value) {
    const text = String(value || "");
    if (!text) return null;
    return (field.promptOptions || []).find((option) => option.value === text) || {
        value: text,
        title: promptPreview(text),
        category: "",
        thumbnail: "",
        cardColor: "",
        customBadge: "",
        favorite: false,
        nsfw: false,
    };
}

function promptOptionSortText(option) {
    return String(option?.title || option?.value || "");
}

function sortedPromptOptions(node, options) {
    if (dropdownSortMode(node) !== DROPDOWN_SORT_AZ) return options;
    return [...options].sort((a, b) => compareDropdownText(promptOptionSortText(a), promptOptionSortText(b)));
}

function selectPromptOption(node, field, option) {
    const config = activeConfigValues(node, true);
    if (!config) return;
    config[field.id] = option?.value || "";
    writeData(node);
    closePromptOptionMenu(node);
    renderFields(node);
}

function removePromptOption(node, field, option, menu = null) {
    if (!option) return;
    // By the option itself (a blank linked one has no text to match), else by its text.
    field.promptOptions = (field.promptOptions || []).filter((item) => item !== option && !(option.value && item?.value === option.value));
    const config = activeConfigValues(node, true);
    if (config && option.value && config[field.id] === option.value) config[field.id] = "";
    writeData(node);
    renderFields(node);
    if (menu?.isConnected) renderPromptOptionMenuContents(node, field, menu);
}

function promptThumb(option) {
    if (localImageUrl(option?.thumbnail)) {
        return thumbnailBox({ className: "ddp-model-thumb", url: option.thumbnail, previewVideoUrl: option.previewVideoUrl || "" });
    }
    return h("div", { class: "ddp-model-thumb is-empty", text: "✎" });
}

// Reuses the shared Layer-1 card primitive and the ddp-model-* option-card chrome
// (visually identical to model cards, per the request) with prompt-specific content.
const promptCardSource = {
    keyOf: (option) => option?.value || "",
    cardColor: (option) => option?.cardColor || "",
    hasNotch: (option, key, opts) => Boolean(option?.value || key) && !opts.empty && !opts.onRemove && Boolean(option?.category && option?.name),
    cardClass: (option, opts) => `krc-lora-card ${opts.className || "ddp-model-card"}${opts.empty ? " is-empty" : ""}`,
    decorateCard: (card, option, opts) => {
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("title", option?.name || option?.title || "");
        if (opts.onClick) card.addEventListener("click", opts.onClick);
        card.addEventListener("keydown", (event) => {
            if (event.target !== card) return;
            if (!opts.onClick || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            opts.onClick(event);
        });
    },
    renderThumb: (option) => promptThumb(option),
    nameText: (option) => option?.__ddpTitle || option?.title || option?.name || "Prompt",
    subtitleText: (option) => option?.__ddpSubtitle || option?.category || "",
    fillBadgeRow: (row, option) => fillExternalCardBadges(row, option),
    renderTrailing: (option, opts) => (
        opts.onRemove
            ? h("button", {
                class: "ddp-model-option-remove",
                title: "Remove from this dropdown",
                text: "×",
                onclick: (event) => {
                    event.stopPropagation();
                    opts.onRemove(event);
                },
            })
            : null
    ),
    notchMenu: (option, key, context) => ({
        context: "embedded",
        kind: "prompt",
        id: key,
        title: option?.title || option?.name || "Prompt",
        actions: [
            {
                id: "info",
                icon: "i",
                label: "Info",
                title: "Open in Prompt Vault",
                disabled: !(option?.category && option?.name),
                onClick: () => {
                    closePromptOptionMenu(context.opts.node);
                    openLibraryModal({
                        provider: "prompts",
                        select: { id: option?.id || "", category: option?.category || "", name: option?.name || option?.title || "" },
                        infoOpen: true,
                    });
                },
            },
        ],
    }),
};

function promptCard(option, opts = {}) {
    return renderModelCard({
        ...option,
        __ddpTitle: opts.title || "",
        __ddpSubtitle: opts.subtitle || "",
    }, promptCardSource, opts);
}

function promptOptionRow(option, { node, selected = false, onClick, onRemove } = {}) {
    return promptCard(option, {
        className: "ddp-model-option",
        node,
        selected,
        onClick,
        onRemove,
        // A linked prompt that was emptied emits nothing until it gets text again.
        subtitle: option?.value ? (option?.category || "") : [option?.category, "empty"].filter(Boolean).join(" · "),
    });
}

function renderPromptOptionMenuContents(node, field, menu) {
    const value = activeConfigValues(node, false)?.[field.id] || "";
    const options = sortedPromptOptions(node, (field.promptOptions || []).filter(Boolean));
    const editing = isEditMode(node);
    menu.replaceChildren();
    if (options.length) {
        options.forEach((option) => {
            menu.append(promptOptionRow(option, {
                node,
                selected: Boolean(option.value) && option.value === value,
                onClick: () => selectPromptOption(node, field, option),
                onRemove: editing ? () => removePromptOption(node, field, option, menu) : null,
            }));
        });
    } else {
        menu.append(h("div", { class: "ddp-model-empty", text: "Drop Prompt Vault cards here" }));
    }
    const footer = h("div", { class: "ddp-model-menu-footer" });
    footer.append(h("button", {
        class: "ddp-config-menu-item",
        type: "button",
        text: "Browse Prompt Vault…",
        title: "Open the prompt library browser",
        onclick: () => {
            closePromptOptionMenu(node);
            openLibraryModal({ provider: "prompts" });
        },
    }));
    if (editing) {
        footer.append(clearModelOptionRow(() => selectPromptOption(node, field, null)));
    }
    menu.append(footer);
}

function buildPromptPickerCard(node, field, value, disabled) {
    const selected = selectedPromptOption(field, value);
    const title = selected?.title || "Drop prompt";
    const subtitle = selected ? (selected.category || "Prompt") : "Prompt Vault card";
    const option = selected || { cardColor: "", favorite: false };
    const card = promptCard(option, {
        empty: !selected,
        title,
        subtitle,
        node,
        notchDisabled: disabled,
        onClick: () => {
            if (disabled) return;
            // Toggle: clicking the card while its own menu is open closes it.
            if (node._ddp?.promptOptionMenu) {
                closePromptOptionMenu(node);
                return;
            }
            openPromptOptionMenu(node, field, card, String(value || ""));
        },
    });
    if (disabled) card.classList.add("is-disabled");
    else if (selected) installPromptCardDrag(card, selected);
    return card;
}

export function closePromptOptionMenu(node) {
    node._ddp?.promptOptionClose?.();
    if (node._ddp) node._ddp.promptOptionClose = null;
    node._ddp?.promptOptionMenu?.remove?.();
    if (node._ddp) node._ddp.promptOptionMenu = null;
}

function openPromptOptionMenu(node, field, anchor, value) {
    closePromptOptionMenu(node);
    const menu = h("div", { class: "krc-node ddp-model-menu" });
    applyFloatingMenuPalette(node, menu);
    renderPromptOptionMenuContents(node, field, menu);
    document.body.appendChild(menu);
    node._ddp.promptOptionMenu = menu;
    placeFloatingCardMenu(anchor, menu, MODEL_CARD_W + MODEL_MENU_PAD_X);
    wireCardMenuOutsideClose(node, menu, anchor, closePromptOptionMenu, "promptOptionClose");
}

export function buildPromptDropControl(node, field, value, disabled) {
    const button = buildPromptPickerCard(node, field, value, disabled);
    const wrap = h("div", {
        class: "ddp-model-drop ddp-prompt-drop is-typed" + (disabled ? " is-disabled" : ""),
    }, [button]);
    const setDragClass = (payload) => {
        const ok = !disabled && Boolean(payload);
        wrap.classList.toggle("is-drop-ok", ok);
        return ok;
    };
    wrap.addEventListener("dragenter", (event) => {
        if (setDragClass(parsePromptDrag(event))) event.preventDefault();
    });
    wrap.addEventListener("dragover", (event) => {
        if (setDragClass(parsePromptDrag(event))) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    wrap.addEventListener("dragleave", () => {
        wrap.classList.remove("is-drop-ok");
    });
    wrap.addEventListener("drop", (event) => {
        const payload = parsePromptDrag(event);
        wrap.classList.remove("is-drop-ok");
        if (disabled || !payload) return;
        event.preventDefault();
        applyPromptFieldDrop(node, field, payload);
    });
    return wrap;
}

async function applyPromptFieldDrop(node, field, payload) {
    const snapshot = await resolvePromptSnapshot(payload);
    const text = snapshot?.text || "";
    if (!text) return;
    const option = rememberPromptOption(field, {
        ...snapshot,
        value: text,
    });
    if (!option) return;
    const config = activeConfigValues(node, true);
    if (!config) return;
    config[field.id] = option.value;
    writeData(node);
    renderFields(node);
}

export function hasLibraryPromptFields(node) {
    return (node._fields || []).some((field) =>
        field.type === "prompt" && Array.isArray(field.promptOptions)
        && field.promptOptions.some((option) => option?.category && option?.name));
}

function promptSnapshotFromDetail(detail, payload = {}) {
    const category = String(detail?.category || payload?.category || "").trim();
    const name = String(detail?.name || payload?.name || payload?.title || "").trim();
    const thumbUrl = String(payload?.thumbnailUrl || payload?.thumbnail || "");
    return {
        text: promptEmittedText(detail),
        id: String(detail?.id || payload?.id || ""),
        dateModified: String(detail?.dateModified || ""),
        title: name || String(payload?.title || ""),
        name,
        category,
        thumbnail: thumbUrl,
        previewVideoUrl: detail?.thumbType === "video" ? promptThumbnailUrl(detail, "animated") : String(payload?.previewVideoUrl || ""),
        cardColor: String(detail?.cardColor || payload?.cardColor || ""),
        customBadge: String(detail?.customBadge || payload?.customBadge || ""),
        favorite: Boolean(detail?.favorite ?? payload?.favorite),
        nsfw: Boolean(detail?.nsfw ?? payload?.nsfw),
    };
}

// Fallback snapshot built straight from the drag payload's carried text — used when the
// source Prompt Vault record can't be re-fetched (e.g. a CS→CS drag of a card whose PV
// record was since deleted). CS prompt drags carry payload.text for exactly this.
function promptSnapshotFromPayload(payload = {}) {
    const text = String(payload?.text || "");
    if (!text) return null;
    const name = String(payload?.name || payload?.title || "");
    return {
        text,
        id: String(payload?.id || ""),
        dateModified: String(payload?.dateModified || ""),
        title: name || String(payload?.title || ""),
        name,
        category: String(payload?.category || ""),
        thumbnail: String(payload?.thumbnailUrl || payload?.thumbnail || ""),
        previewVideoUrl: String(payload?.previewVideoUrl || ""),
        cardColor: String(payload?.cardColor || ""),
        customBadge: String(payload?.customBadge || ""),
        favorite: Boolean(payload?.favorite),
        nsfw: Boolean(payload?.nsfw),
    };
}

// Prefer a fresh re-snapshot from the live PV record (picks up edits); fall back to the
// text carried on the drag payload when the record is gone or unfetchable.
async function resolvePromptSnapshot(payload) {
    return (await fetchPromptSnapshot(payload)) || promptSnapshotFromPayload(payload);
}

// Resolve a dropped prompt card's deferred data. Config Switcher is a different node
// than Prompt Vault, so the drag payload holds only category + name (name travels in
// `title`). We fetch the full record and snapshot its emitted prompt text plus the
// chrome metadata that external prompt cards render.
async function fetchPromptSnapshot(payload) {
    const category = String(payload?.category || "").trim();
    const name = String(payload?.title || payload?.name || "").trim();
    if (!category || !name) return null;
    const qs = new URLSearchParams({ category, name });
    try {
        const response = await api.fetchApi(`${PROMPT_VAULT_API_PREFIX}/prompt-detail?${qs.toString()}`);
        if (!response.ok) return null;
        const detail = await response.json();
        return promptSnapshotFromDetail(detail, payload);
    } catch (e) {
        return null;
    }
}

// Mirror the Prompt Vault node's own emission: Prompt A, plus Prompt B appended when
// the record has APPEND enabled (appendPromptB) and a non-empty Prompt B, separated by
// a blank line (matches krc_prompt_vault.get_prompt). Snapshots therefore match what
// the live PV node would output for that record.
export function promptEmittedText(detail) {
    const a = String(detail?.prompt || "");
    if (detail?.appendPromptB) {
        const b = String(detail?.promptB || "");
        if (b) return [a, b].filter(Boolean).join("\n\n");
    }
    return a;
}

// Read a prompt-card drag. During dragover browsers withhold dataTransfer contents,
// so we fall back to the process-global payload (set on dragstart) — the same trick
// parseModelDrag uses. On drop the typed data is readable, so we prefer it.
function parsePromptDrag(event) {
    const transfer = event?.dataTransfer;
    if (transfer) {
        const raw = transfer.getData("application/x-krc-prompt");
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object" && parsed.kind === "prompt") return parsed;
            } catch (e) {
                // fall through to the global payload
            }
        }
    }
    const globalPayload = getKrcDragPayload?.();
    return globalPayload?.kind === "prompt" ? globalPayload : null;
}

// Make a raw STRING input accept dropped Prompt Vault cards. Only prompt payloads are
// accepted (model cards leave the browser default, i.e. no drop); on a valid drop the
// deferred prompt text is hydrated and written as the field value (snapshot mode).
export function installPromptDrop(node, field, input, set) {
    const showOk = (payload) => {
        const ok = Boolean(payload);
        input.classList.toggle("is-drop-ok", ok);
        return ok;
    };
    input.addEventListener("dragenter", (event) => {
        if (showOk(parsePromptDrag(event))) event.preventDefault();
    });
    input.addEventListener("dragover", (event) => {
        if (showOk(parsePromptDrag(event))) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    input.addEventListener("dragleave", () => {
        input.classList.remove("is-drop-ok");
    });
    input.addEventListener("drop", (event) => {
        const payload = parsePromptDrag(event);
        input.classList.remove("is-drop-ok");
        if (!payload) return;
        event.preventDefault();
        applyPromptDrop(node, field, payload, input, set);
    });
}

async function applyPromptDrop(node, field, payload, input, set) {
    const raw = (await resolvePromptSnapshot(payload))?.text || "";
    if (!raw) return;
    // Respect the field's mode. A single-line <input> silently strips newlines, so an
    // APPEND'd A/B snapshot ("Fruit\n\nBasket") would collapse to "FruitBasket" — collapse
    // its newlines to single spaces there instead ("Fruit Basket"). Multi-line fields keep
    // the text verbatim (blank line between A and B). Toggle the field to multi-line to
    // preserve the exact line breaks.
    const text = field?.stringMultiline ? raw : raw.replace(/\s*\n\s*/g, " ").trim();
    set(text);
    input.value = text;
}

// Prompt cards carry their snapshot text inline (payload.text) so a CS→CS drag works
// even if the source Prompt Vault record was deleted — the drop prefers a fresh
// re-snapshot by category+name when the record still exists, else this carried text.
function installPromptCardDrag(card, option) {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
        const name = option.name || option.title || "";
        const payload = {
            kind: "prompt",
            id: option.id || "",
            category: option.category || "",
            title: name,
            name,
            text: option.value || "",
            dateModified: option.dateModified || "",
            thumbnailUrl: option.thumbnail || "",
            previewVideoUrl: option.previewVideoUrl || "",
            cardColor: option.cardColor || "",
            customBadge: option.customBadge || "",
            favorite: Boolean(option.favorite),
            nsfw: Boolean(option.nsfw),
        };
        card.classList.add("is-dragging");
        setKrcDragPayload(payload);
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("application/x-krc-prompt", JSON.stringify(payload));
        event.dataTransfer.setData("text/plain", payload.text || name);
    });
    card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
        clearKrcDragPayload();
    });
}
