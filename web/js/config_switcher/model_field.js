import { thumbnailBox } from "../shared/browser_cards.js";
// Config Switcher Model field: remembered model options, the option menu, the card (and
// dragging it out), the drop control, and the floating card-menu helpers the Prompt field
// shares.
//
// The Config Switcher modules import each other (config.js is the hub); the cycles are
// safe because no module reads another's binding at load, only inside calls.
import { h } from "./helpers.js";
import { localImageUrl } from "../shared/dom.js";
import { openLibraryModal } from "../shared/library_modal.js";
import {
    clearKrcDragPayload,
    getKrcDragPayload,
    setKrcDragPayload,
} from "../shared/drag_payload.js";
import { renderModelCard } from "../shared/model_card.js";
import { libraryThumbnailUrl } from "../model_library/api.js";
import {
    activeConfigValues,
    applyFloatingMenuPalette,
    isEditMode,
    looksAutoNamed,
    MODEL_CARD_W,
    MODEL_MENU_PAD_X,
    sortedModelOptions,
    uniqueFieldName,
    writeData,
} from "./config.js";
import { isModelOptionMissing } from "./card_sync.js";
import { renderFields } from "./field_rows.js";

export function hasLibraryModelFields(node) {
    return (node._fields || []).some((field) =>
        field.type === "model"
        && ((Array.isArray(field.modelOptions) && field.modelOptions.length)
            || String(activeConfigValues(node, false)?.[field.id] || "").trim())
    );
}

function modelTypeLabel(modelType) {
    // Raw folder-name type is the label (the folder tree is the source of truth); the
    // generic "Model" fallback covers an untyped field before any model is dropped.
    return String(modelType || "").trim() || "Model";
}

function modelValueFromPayload(payload = {}) {
    return String(payload.value || payload.relativePath || payload.relative_path || payload.file || payload.filename || payload.path || payload.id || "");
}

function modelTitleFromPayload(payload = {}) {
    return String(payload.title || payload.display_name || payload.name || payload.filename || payload.relativePath || payload.relative_path || payload.path || payload.id || "");
}

function modelThumbnailFromPayload(payload = {}) {
    return String(payload.thumbnailUrl || payload.thumbnail || "");
}

export function normalizeModelOption(option = {}) {
    const value = modelValueFromPayload(option);
    if (!value) return null;
    return {
        value,
        id: String(option.id || ""),
        libraryId: String(option.libraryId || option.sha256 || ""),
        sha256: String(option.sha256 || option.libraryId || ""),
        title: modelTitleFromPayload(option) || value,
        modelType: String(option.modelType || option.type || ""),
        relativePath: String(option.relativePath || option.relative_path || ""),
        path: String(option.path || option.file || ""),
        thumbnail: modelThumbnailFromPayload(option),
        previewVideoUrl: String(option.previewVideoUrl || ""),
        cardColor: String(option.cardColor || ""),
        customBadge: String(option.customBadge || ""),
        favorite: Boolean(option.favorite),
        nsfw: Boolean(option.nsfw),
    };
}

export function modelOptionMatchKeys(option = {}) {
    return new Set([
        option.value,
        option.id,
        option.libraryId,
        option.sha256,
        option.path,
        option.relativePath,
        option.relative_path,
        option.file,
        option.filename,
    ].map((value) => String(value || "").trim()).filter(Boolean));
}

function libraryThumbnailFromItem(item = {}) {
    if (item.thumbnailUrl) return String(item.thumbnailUrl);
    const id = String(item.libraryId || item.sha256 || item.id || "").trim();
    // Versioned by the item's own thumbnail (stable while the image is unchanged).
    if (item.thumbnail && id) {
        if (item.thumbnailType === "video" && !item.thumbnailHasPoster) return "";
        return libraryThumbnailUrl(id, { version: item.thumbnailVersion, kind: item.thumbnailType === "video" ? "poster" : "" });
    }
    return "";
}

export function libraryItemToModelOption(item = {}) {
    return normalizeModelOption({
        ...item,
        id: item.libraryId || item.sha256 || item.id,
        value: item.relativePath || item.relative_path || item.file || item.path || item.libraryId || item.sha256 || item.id,
        title: item.display_name || item.name || item.title,
        thumbnail: libraryThumbnailFromItem(item),
        previewVideoUrl: item.previewVideoUrl || (item.thumbnail && item.thumbnailType === "video"
            ? libraryThumbnailUrl(item.thumbnailSha || item.libraryId || item.sha256 || item.id, { version: item.thumbnailVersion, kind: "animated" }) : ""),
        cardColor: item.cardColor || "",
        customBadge: item.customBadge || "",
        favorite: item.favorite,
        nsfw: item.nsfw,
    });
}

function rememberModelOption(field, payload) {
    const option = normalizeModelOption(payload);
    if (!option) return null;
    field.modelOptions = Array.isArray(field.modelOptions) ? field.modelOptions.filter(Boolean) : [];
    field.modelOptions = [option, ...field.modelOptions.filter((item) => item.value !== option.value)].slice(0, 24);
    return option;
}

function selectedModelOption(field, value) {
    const text = String(value || "");
    if (!text) return null;
    return (field.modelOptions || []).find((option) => option.value === text) || {
        value: text,
        title: text,
        modelType: field.modelType || "",
        thumbnail: "",
        cardColor: "",
        favorite: false,
    };
}

function parseModelDrag(event) {
    const transfer = event?.dataTransfer;
    if (transfer) {
        const raw = transfer.getData("application/x-krc-model");
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === "object") {
                    return { ...parsed, kind: parsed.kind || (parsed.modelType === "lora" ? "lora" : "model") };
                }
            } catch (e) {
                return null;
            }
        }
        const loraId = transfer.getData("application/x-krc-lora");
        const globalPayload = getKrcDragPayload?.();
        if (loraId && globalPayload?.id === loraId && globalPayload.kind === "lora") return globalPayload;
        if (loraId) return { kind: "lora", id: loraId, modelType: "lora" };
    }
    const globalPayload = getKrcDragPayload?.();
    if (globalPayload?.id && ["model", "lora"].includes(globalPayload.kind)) {
        return globalPayload;
    }
    return null;
}

function acceptsModelPayload(field, payload) {
    const incomingType = String(payload?.modelType || "").trim();
    if (!incomingType) return false;
    return !field.modelType || field.modelType === incomingType;
}

function applyModelDrop(node, field, payload, display) {
    const modelType = String(payload?.modelType || "").trim();
    const value = modelValueFromPayload(payload);
    if (!modelType || !value) return;
    // Relabel the field after the model's type on drop — "diffusion", then "diffusion_2"
    // for a second diffusion field — but only while the name is still auto-generated, so
    // a user's custom name is never clobbered. Capture the prior modelType's label first
    // so a field already auto-named for a different type still counts as auto.
    const priorLabel = modelTypeLabel(field.modelType || "").toLowerCase();
    if (!field.modelType) field.modelType = modelType;
    const label = modelTypeLabel(modelType).toLowerCase();
    if (looksAutoNamed(field.name, ["model", priorLabel, label])) {
        field.name = uniqueFieldName(node, label, field.id);
    }
    const option = rememberModelOption(field, payload);
    const config = activeConfigValues(node, true);
    if (!config) return;
    config[field.id] = value;
    writeData(node);
    if (display && option) display.textContent = option.title || value;
    renderFields(node);
}

export function closeModelOptionMenu(node) {
    node._ddp?.modelOptionClose?.();
    if (node._ddp) node._ddp.modelOptionClose = null;
    node._ddp?.modelOptionMenu?.remove?.();
    if (node._ddp) node._ddp.modelOptionMenu = null;
}

function selectModelOption(node, field, option) {
    const config = activeConfigValues(node, true);
    if (!config) return;
    config[field.id] = option?.value || "";
    writeData(node);
    closeModelOptionMenu(node);
    renderFields(node);
}

function renderModelOptionMenuContents(node, field, menu) {
    const value = activeConfigValues(node, false)?.[field.id] || "";
    const options = sortedModelOptions(node, (field.modelOptions || []).filter(Boolean));
    const editing = isEditMode(node);
    menu.replaceChildren();
    if (options.length) {
        options.forEach((option) => {
            menu.append(modelOptionRow(option, {
                node,
                selected: option.value === value,
                modelType: field.modelType,
                onClick: () => selectModelOption(node, field, option),
                onRemove: editing ? () => removeModelOption(node, field, option, menu) : null,
            }));
        });
    } else {
        menu.append(h("div", { class: "ddp-model-empty", text: field.modelType ? `Drop ${modelTypeLabel(field.modelType)} models here` : "Drop a model to start this list" }));
    }
    const footer = h("div", { class: "ddp-model-menu-footer" });
    const label = modelTypeLabel(field.modelType);
    footer.append(h("button", {
        class: "ddp-config-menu-item",
        type: "button",
        text: field.modelType ? `Browse ${label}…` : "Browse Models…",
        title: "Open the model library browser",
        onclick: () => {
            closeModelOptionMenu(node);
            openLibraryModal({ provider: "models", scope: field.modelType || "all" });
        },
    }));
    if (editing) {
        footer.append(clearModelOptionRow(() => selectModelOption(node, field, null)));
    }
    menu.append(footer);
}

function removeModelOption(node, field, option, menu = null) {
    if (!option?.value) return;
    field.modelOptions = (field.modelOptions || []).filter((item) => item?.value !== option.value);
    const config = activeConfigValues(node, true);
    if (config && config[field.id] === option.value) config[field.id] = "";
    writeData(node);
    renderFields(node);
    if (menu?.isConnected) renderModelOptionMenuContents(node, field, menu);
}

function modelThumb(option, modelType = "") {
    if (localImageUrl(option?.thumbnail)) {
        return thumbnailBox({ className: "ddp-model-thumb", url: option.thumbnail, previewVideoUrl: option.previewVideoUrl || "" });
    }
    const label = modelTypeLabel(option?.modelType || modelType || "").slice(0, 2).toUpperCase();
    return h("div", { class: "ddp-model-thumb is-empty", text: label || "M" });
}

export function fillExternalCardBadges(row, option) {
    let count = 0;
    if (option?.favorite) {
        row.append(h("span", { class: "krc-badge-star", text: "★", title: "Favorite" }));
        count++;
    }
    if (option?.nsfw) {
        row.append(h("span", { class: "krc-card-badge krc-nsfw-badge", text: "NSFW" }));
        count++;
    }
    if (option?.customBadge) {
        row.append(h("span", { class: "krc-card-badge is-json", text: option.customBadge, title: "Custom badge" }));
        count++;
    }
    return count;
}

// Config Switcher keeps its own fallback thumbnail and picker interactions, but
// uses the shared Layer-1 body primitive so embedded cards align with browser cards.
const modelCardSource = {
    keyOf: (option) => option?.value || "",
    cardColor: (option) => option?.cardColor || "",
    hasNotch: (option, key, opts) => Boolean(option?.value || key) && !opts.empty && !opts.onRemove && !opts.missing,
    cardClass: (option, opts) => `krc-lora-card ${opts.className || "ddp-model-card"}${opts.empty ? " is-empty" : ""}`,
    decorateCard: (card, option, opts) => {
        card.setAttribute("role", "button");
        card.setAttribute("tabindex", "0");
        card.setAttribute("title", option?.value || "");
        if (opts.onClick) card.addEventListener("click", opts.onClick);
        card.addEventListener("keydown", (event) => {
            if (event.target !== card) return;
            if (!opts.onClick || (event.key !== "Enter" && event.key !== " ")) return;
            event.preventDefault();
            opts.onClick(event);
        });
    },
    renderThumb: (option, opts) => modelThumb(option, opts.modelType || ""),
    nameText: (option) => option?.__ddpTitle || option?.title || option?.value || "Model",
    subtitleText: (option) => option?.__ddpSubtitle || modelTypeLabel(option?.modelType || option?.__ddpModelType || "") || "",
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
        kind: "model",
        id: key,
        title: option?.title || option?.value || "Model",
        actions: [
            {
                id: "info",
                icon: "i",
                label: "Info",
                title: "Open in Model Library",
                onClick: () => {
                    closeModelOptionMenu(context.opts.node);
                    openLibraryModal({
                        provider: "models",
                        scope: option?.modelType || context.opts.modelType || "all",
                        select: option,
                        infoOpen: true,
                    });
                },
            },
        ],
    }),
};

function modelCard(option, opts = {}) {
    return renderModelCard({
        ...option,
        __ddpTitle: opts.title || "",
        __ddpSubtitle: opts.subtitle || "",
        __ddpModelType: opts.modelType || "",
    }, modelCardSource, opts);
}

function modelOptionRow(option, { node, selected = false, modelType = "", onClick, onRemove } = {}) {
    const row = modelCard(option, {
        className: "ddp-model-option",
        node,
        modelType,
        selected,
        missing: isModelOptionMissing(node, option),
        onClick,
        onRemove,
        subtitle: modelTypeLabel(option?.modelType || modelType || ""),
    });
    return row;
}

// Clearing the selection is destructive, so the footer button arms on the first click
// ("Clear?") and only clears on a confirming second click; it disarms itself after a
// few seconds. Shared by the model and prompt card menus.
export function clearModelOptionRow(onClick) {
    let armed = false;
    let timer = null;
    const disarm = () => {
        armed = false;
        clearTimeout(timer);
        btn.textContent = "Clear";
        btn.classList.remove("is-confirming");
    };
    const btn = h("button", {
        class: "ddp-model-clear",
        type: "button",
        text: "Clear",
        onclick: () => {
            if (armed) {
                disarm();
                onClick();
                return;
            }
            armed = true;
            btn.textContent = "Clear?";
            btn.classList.add("is-confirming");
            clearTimeout(timer);
            timer = setTimeout(disarm, 3000);
        },
    });
    return btn;
}

function buildModelPickerCard(node, field, value, disabled) {
    const selected = selectedModelOption(field, value);
    const title = selected?.title || (field.modelType ? `Drop ${modelTypeLabel(field.modelType)}` : "Drop model");
    const subtitle = selected ? modelTypeLabel(selected.modelType || field.modelType) : (field.modelType ? `${modelTypeLabel(field.modelType)} only` : "Any model");
    const option = selected || { modelType: field.modelType, cardColor: "", favorite: false };
    const card = modelCard(option, {
        empty: !selected,
        missing: Boolean(selected) && isModelOptionMissing(node, selected),
        modelType: field.modelType,
        title,
        subtitle,
        node,
        notchDisabled: disabled,
        onClick: () => {
            if (disabled) return;
            // Toggle: clicking the card while its own menu is open closes it.
            if (node._ddp?.modelOptionMenu) {
                closeModelOptionMenu(node);
                return;
            }
            openModelOptionMenu(node, field, card, String(value || ""));
        },
    });
    if (disabled) card.classList.add("is-disabled");
    else if (selected) installModelCardDrag(card, field, selected);
    return card;
}

function openModelOptionMenu(node, field, anchor, value) {
    closeModelOptionMenu(node);
    const menu = h("div", { class: "krc-node ddp-model-menu" });
    applyFloatingMenuPalette(node, menu);
    renderModelOptionMenuContents(node, field, menu);
    document.body.appendChild(menu);
    node._ddp.modelOptionMenu = menu;
    placeFloatingCardMenu(anchor, menu, MODEL_CARD_W + MODEL_MENU_PAD_X);
    wireCardMenuOutsideClose(node, menu, anchor, closeModelOptionMenu, "modelOptionClose");
}

// Shared geometry for the model/prompt option popovers: pin to the anchor, prefer
// opening below, flip above when the (height-capped) menu won't fit, and always keep
// it fully inside the viewport so the last rows aren't pushed off the bottom edge.
export function placeFloatingCardMenu(anchor, menu, width) {
    const rect = anchor.getBoundingClientRect();
    const margin = 8;
    menu.style.width = `${width}px`;
    menu.style.left = `${Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin))}px`;
    const menuH = Math.min(menu.scrollHeight, menu.offsetHeight || 280);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const top = (spaceBelow >= menuH || spaceBelow >= spaceAbove)
        ? Math.min(rect.bottom + 4, window.innerHeight - menuH - margin)
        : Math.max(margin, rect.top - 4 - menuH);
    menu.style.top = `${Math.max(margin, top)}px`;
}

// Close a floating card menu on the next outside pointerdown; store the unbinder in
// node._ddp[closeSlot] so the menu's own close path can detach the listener.
export function wireCardMenuOutsideClose(node, menu, anchor, closeFn, closeSlot) {
    const closeOnOutside = (event) => {
        if (menu.contains(event.target) || anchor.contains(event.target)) return;
        // A card in this dropdown can open a body-portaled context popover (the notch
        // menu / its color/badge/rename rows). It carries the shared .krc-floating-menu
        // marker; treat clicks inside it as "inside", so editing there doesn't dismiss
        // the dropdown out from under it.
        if (event.target.closest?.(".krc-floating-menu")) return;
        closeFn(node);
    };
    node._ddp[closeSlot] = () => {
        document.removeEventListener("pointerdown", closeOnOutside, true);
    };
    setTimeout(() => document.addEventListener("pointerdown", closeOnOutside, true), 0);
}

// Make a Config Switcher field card a drag SOURCE so a remembered card can be
// dragged to another node (another CS field's drop zone, a raw STRING prompt field,
// etc.). Mirrors the browser card drag pattern: the full payload travels on the
// typed dataTransfer slot (read losslessly on drop), and setKrcDragPayload seeds the
// process-global that drop targets consult during dragover (when the browser withholds
// dataTransfer contents). Only wired on a populated, enabled card.
function installModelCardDrag(card, field, option) {
    card.draggable = true;
    card.addEventListener("dragstart", (event) => {
        const payload = {
            kind: "model",
            id: option.id || option.sha256 || option.libraryId || "",
            libraryId: option.libraryId || "",
            sha256: option.sha256 || "",
            modelType: option.modelType || field.modelType || "",
            value: option.value || "",
            relativePath: option.relativePath || "",
            path: option.path || "",
            title: option.title || "",
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
        event.dataTransfer.setData("application/x-krc-model", JSON.stringify(payload));
        event.dataTransfer.setData("text/plain", payload.title || payload.value);
    });
    card.addEventListener("dragend", () => {
        card.classList.remove("is-dragging");
        clearKrcDragPayload();
    });
}

export function buildModelDropControl(node, field, value, disabled) {
    const button = buildModelPickerCard(node, field, value, disabled);
    const wrap = h("div", {
        class: "ddp-model-drop" + (field.modelType ? " is-typed" : " is-untyped") + (disabled ? " is-disabled" : ""),
    }, [button]);
    const setDragClass = (payload) => {
        const ok = !disabled && payload && acceptsModelPayload(field, payload);
        wrap.classList.toggle("is-drop-ok", Boolean(ok));
        wrap.classList.toggle("is-drop-bad", Boolean(payload && !ok));
        return ok;
    };
    wrap.addEventListener("dragenter", (event) => {
        const payload = parseModelDrag(event);
        if (setDragClass(payload)) event.preventDefault();
    });
    wrap.addEventListener("dragover", (event) => {
        const payload = parseModelDrag(event);
        if (setDragClass(payload)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "copy";
        }
    });
    wrap.addEventListener("dragleave", () => {
        wrap.classList.remove("is-drop-ok", "is-drop-bad");
    });
    wrap.addEventListener("drop", (event) => {
        const payload = parseModelDrag(event);
        wrap.classList.remove("is-drop-ok", "is-drop-bad");
        if (disabled || !payload || !acceptsModelPayload(field, payload)) return;
        event.preventDefault();
        applyModelDrop(node, field, payload, button);
    });
    return wrap;
}
