// KRC Card API (public, via krc_public_api.js): lets any node use KRC's model and prompt
// cards without knowing the Model Library / Prompt Vault internals. See
// KRC_CARD_API_GAMEPLAN.md and KRC_PUBLIC_API.md ("Card API") in the dev repo.
//
// A card SOURCE says what a node draws from:
//   { kind: "model", folder: "refmods" }  any Model Library folder by raw name ("lora" for
//                                         LoRAs; "" or "all" = every folder)
//   { kind: "prompt", category: "" }      Prompt Vault cards ("" = every category)
//
// A card REF is the plain, stable shape every function here takes and returns:
//   { kind: "model", id, title, folder, subtitle, thumbnailUrl, cardColor, favorite, nsfw, customBadge }
//   { kind: "prompt", id, title, category, subtitle, thumbnailUrl, cardColor, favorite, nsfw, customBadge }
// Store only `kind` + `id` in a node; everything else is display data that
// subscribeCards / fetchCards keep current. The backend turns an id into the real thing
// (Python resolve_models / resolve_prompts, JS resolveCards). Model cards are read-only;
// prompt cards can be written with savePrompt (1.3).
import { openLibraryModal } from "./library_modal.js";
import { renderModelCard } from "./model_card.js";
import { clearKrcDragPayload, getKrcDragPayload, setKrcDragPayload } from "./drag_payload.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, publishKrcSync, subscribeKrcSync } from "./sync_bus.js";
import { SHARED_STYLE_VERSION, ensureStylesheet } from "./stylesheets.js";
import { readGlobalSetting } from "./global_settings.js";
import { SHOW_NSFW_DEFAULT, SHOW_NSFW_SETTING_ID } from "./settings.js";
import { showToast } from "./toast.js";
import { makeNodeApi } from "./api.js";
import { el } from "./dom.js";
import { browserListClass } from "./browser_views.js";
import { modelCardStatus, promptCardStatus } from "./card_status.js";
import { getSharedJson as getLibraryJson, libraryListPath, libraryThumbnailUrl } from "../model_library/api.js";
import { apiPost as postPromptVault, fetchPromptLibraryJson, withPromptReferences, promptThumbnailUrl, promptCardThumbnailUrl } from "../prompt_vault/api.js";

const cardsApi = makeNodeApi("/krc/cards");

// ---- Sources and refs -------------------------------------------------------------

function normalizeFolder(folder) {
  const value = String(folder || "").trim();
  if (!value || value === "all") return "";
  return value === "loras" ? "lora" : value; // LoRAs are typed "lora" in the library
}

export function normalizeCardSource(source = {}) {
  if (source?.kind === "prompt") {
    return { kind: "prompt", category: String(source.category || "").trim() };
  }
  return { kind: "model", folder: normalizeFolder(source?.folder) };
}

// A prompt card's still: a video thumbnail's poster, never the video itself (an <img>
// can't show a .webm); a video with no poster has no still.
function promptStill(raw) {
  if (raw.thumbType === "video" && !raw.thumbHasPoster) return "";
  return promptCardThumbnailUrl(raw) || "";
}

function modelThumbnail(raw) {
  if (raw.thumbnailUrl) return String(raw.thumbnailUrl);
  if (!raw.thumbnail) return "";
  const kind = raw.thumbnailType === "video" && raw.thumbnailHasPoster ? "poster" : "";
  // A video thumbnail with no poster has no still to show.
  if (raw.thumbnailType === "video" && !kind) return "";
  return libraryThumbnailUrl(raw.thumbnailSha || raw.sha256 || raw.id || "", { version: raw.thumbnailVersion, kind });
}

// Any card-shaped object -> a card ref, or null. Accepts a KRC drag payload, a Model
// Library item, a Prompt Vault item, or a ref. `kind` ("model" | "prompt") is a hint for
// objects that don't say what they are.
export function cardRef(raw, kind = "") {
  if (!raw || typeof raw !== "object") return null;
  const rawKind = String(raw.kind || kind || "");
  const isPrompt = rawKind === "prompt" || (!rawKind && raw.category !== undefined && raw.name !== undefined && !raw.sha256);
  const common = {
    cardColor: String(raw.cardColor || ""),
    favorite: Boolean(raw.favorite),
    nsfw: Boolean(raw.nsfw),
    customBadge: String(raw.customBadge || ""),
  };
  if (isPrompt) {
    const id = String(raw.id || "");
    if (!id) return null;
    const category = String(raw.category || "");
    return {
      kind: "prompt",
      id,
      profileId: String(raw.profileId || "default"),
      title: String(raw.title || raw.name || ""),
      category,
      subtitle: String(raw.subtitle || category),
      thumbnailUrl: String(raw.thumbnailUrl || promptStill(raw)),
      previewVideoUrl: String(raw.previewVideoUrl || (raw.thumbType === "video" ? promptThumbnailUrl(raw, "animated") : "")),
      ...common,
    };
  }
  const id = String(raw.sha256 || raw.libraryId || raw.id || "");
  if (!id) return null;
  // A ref carries `folder`; a drag payload or library item carries `modelType` (a library
  // item's own `folder` is its subfolder on disk, not its type).
  const isRef = rawKind === "model" && raw.modelType === undefined;
  const folder = normalizeFolder(isRef ? raw.folder : (raw.modelType || (rawKind === "lora" ? "lora" : "")));
  return {
    kind: "model",
    id,
    title: String(raw.title || raw.display_name || raw.filename || raw.file || id),
    folder,
    subtitle: String(raw.subtitle || raw.baseModel || folder || ""),
    thumbnailUrl: modelThumbnail(raw),
    previewVideoUrl: String(raw.previewVideoUrl || (raw.thumbnail && raw.thumbnailType === "video"
      ? libraryThumbnailUrl(raw.thumbnailSha || raw.sha256 || raw.id || "", { version: raw.thumbnailVersion, kind: "animated" }) : "")),
    ...common,
  };
}

// Whether a ref belongs to a source (right kind, and folder / category when set).
export function cardMatchesSource(ref, source) {
  if (!ref) return false;
  const want = normalizeCardSource(source);
  if (ref.kind !== want.kind) return false;
  if (want.kind === "model") return !want.folder || normalizeFolder(ref.folder) === want.folder;
  return !want.category || ref.category === want.category;
}

// ---- Listing and resolving ---------------------------------------------------------

// Every card in a source, as refs. `force` rescans the model folders first.
export async function fetchCards(source, { force = false, profileId = "default" } = {}) {
  const want = normalizeCardSource(source);
  if (want.kind === "model") {
    const { ok, data } = await getLibraryJson(libraryListPath(force));
    const items = ok && Array.isArray(data?.items) ? data.items : [];
    return items.map((item) => cardRef(item, "model")).filter((ref) => cardMatchesSource(ref, want));
  }
  return promptCardsFrom((await fetchPromptLibraryJson(profileId)) || {}, want).map(ref => ({ ...ref, profileId }));
}

// The prompt cards of a source from a library already in hand (Prompt Vault's
// PROMPT_LIBRARY_UPDATED carries the whole library). Internal: not on the public API.
export function promptCardsFrom(library, source) {
  const want = normalizeCardSource(source);
  const refs = [];
  for (const [category, bucket] of Object.entries(library || {})) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const [name, record] of Object.entries(bucket)) {
      if (name === "__meta__" || !record || typeof record !== "object") continue;
      const ref = cardRef({ ...record, category, name }, "prompt");
      if (cardMatchesSource(ref, want)) refs.push(ref);
    }
  }
  return refs.sort((a, b) => a.title.localeCompare(b.title));
}

// kind + ids -> { id: data | { error } }, the same shapes as Python resolve_models /
// resolve_prompts (models: { path, modelType }; prompts: { name, category, text, ... }).
export async function resolveCards(kind, ids) {
  const clean = [...new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean))];
  if (!clean.length) return {};
  try {
    const cards = new Map();
    // The transport caps batches at 500; the public helper resolves the whole set.
    for (let offset = 0; offset < clean.length; offset += 500) {
      const response = await cardsApi.postLoraJson("/resolve", {
        kind: kind === "prompt" ? "prompt" : "model", ids: clean.slice(offset, offset + 500),
      });
      const payload = await response.json();
      if (!response.ok || !payload?.cards || typeof payload.cards !== "object" || Array.isArray(payload.cards)) return {};
      for (const [id, card] of Object.entries(payload.cards)) cards.set(id, card);
    }
    return Object.fromEntries(cards);
  } catch {
    return {};
  }
}

// ---- Missing cards (1.6) -----------------------------------------------------------

// kind + entries -> { id: "ok" | "by-path" | "missing" }: will a run find each card on
// this machine (shared/card_status.js has the rule)? Entries are ids, or { id, path,
// folder } for a model node whose run falls back to a stored relative path (pass a path
// only if your run really uses it), or { id, category, name } for prompts. Reads the
// library lists pages already share; call it again from a subscribeCards callback to stay
// live. A library that can't be read gives "ok" (unknown is not missing).
export async function cardStatus(kind, entries) {
  if (kind === "prompt") {
    let prompts = await fetchPromptLibraryJson().catch(() => null);
    if (!prompts) return promptCardStatus(entries, null);
    const ids = (entries || []).map(entry => typeof entry === "string" ? entry : entry?.id);
    prompts = await withPromptReferences(prompts, ids);
    return promptCardStatus(entries, prompts);
  }
  const { ok, data } = await getLibraryJson(libraryListPath()).catch(() => ({ ok: false, data: null }));
  return modelCardStatus(entries, ok ? data : null);
}

// ---- Writing prompt cards (1.3) ----------------------------------------------------

const CARD_API_SYNC_SOURCE = "krc-card-api";

// savePrompt field -> Prompt Vault's save-route field.
const PROMPT_WRITE_FIELDS = {
  text: "text",
  promptB: "promptB",
  appendPromptB: "appendPromptB",
  notes: "notes",
  nsfw: "nsfw",
  favorite: "favorite",
  cardColor: "cardColor",
  customBadge: "customBadge",
  llPreset: "ll_preset",
};

// Saves a Prompt Vault card through Prompt Vault's own save route, then tells every open
// Prompt Vault, Config Switcher and Portal so they update at once (an unsaved edit of the
// same prompt in a Prompt Vault node is kept and shows as Stale).
//   With `id`: updates that card wherever it lives. A new `category` / `name` renames or
//   moves it (refused if another prompt has that name there); fields left out keep their
//   stored values.
//   Without `id`: creates a card (`category` + `name` required; refused if the name is
//   taken). A category that doesn't exist yet is created.
// Fields: category, name, text, promptB, appendPromptB, notes, nsfw, favorite, cardColor,
// customBadge, llPreset (a LoRA Loadout preset id). `source` tags the sync events so the
// caller can skip its own echo (isOwnSyncEvent).
// -> { ok: true, ref } | { ok: false, error }
export async function savePrompt(fields = {}, { source = CARD_API_SYNC_SOURCE, profileId = fields.profileId || "default" } = {}) {
  const id = String(fields.id || "").trim();
  const body = { mode: id ? "update" : "create" };
  if (id) body.id = id;
  if (fields.category !== undefined) body.category = String(fields.category);
  if (fields.name !== undefined) body.name = String(fields.name);
  for (const [key, wire] of Object.entries(PROMPT_WRITE_FIELDS)) {
    if (fields[key] !== undefined) body[wire] = fields[key];
  }
  const res = await postPromptVault.call({ effectiveProfileId: () => profileId }, "/save-prompt", body);
  if (!res?.success) return { ok: false, error: res?.error || "Save failed" };
  // Prompt Vault nodes refetch on PROMPTS_CHANGED; Config Switcher reads the library
  // from PROMPT_LIBRARY_UPDATED (works with no Prompt Vault node open).
  publishKrcSync(KRC_SYNC_EVENTS.PROMPTS_CHANGED, { source, lane: KRC_SYNC_LANES.STRUCTURE });
  if (res.prompts && profileId === "default") {
    publishKrcSync(KRC_SYNC_EVENTS.PROMPT_LIBRARY_UPDATED, { source, lane: KRC_SYNC_LANES.CONTENT, prompts: res.prompts });
  }
  const record = res.prompts?.[res.category]?.[res.name] || { id: res.id };
  return { ok: true, ref: cardRef({ ...record, id: res.id, category: res.category, name: res.name, profileId }, "prompt") };
}

// ---- Live updates ------------------------------------------------------------------

const SOURCE_EVENTS = {
  model: [
    KRC_SYNC_EVENTS.LIBRARY_CHANGED,
    KRC_SYNC_EVENTS.LIBRARY_HEALED,
    KRC_SYNC_EVENTS.IDENTITY_CHANGED,
    KRC_SYNC_EVENTS.LORA_METADATA_CHANGED,
  ],
  prompt: [KRC_SYNC_EVENTS.PROMPTS_CHANGED, KRC_SYNC_EVENTS.PROMPT_LIBRARY_UPDATED],
};

// Calls `onChange({ type, identity? })` (coalesced, ~150 ms) whenever cards in the
// source may have changed: a rename, colour, thumbnail, heal, rescan or prompt save.
// Typical handler: fetchCards(source) again and re-render. An `identity` change
// ({ oldId, newId }) means a stored model id was replaced; swap it in place.
// Returns an unsubscribe function.
export function subscribeCards(source, onChange) {
  if (typeof onChange !== "function") return () => {};
  const want = normalizeCardSource(source);
  let timer = 0;
  let pending = null;
  const flush = () => {
    timer = 0;
    const detail = pending;
    pending = null;
    try {
      onChange(detail);
    } catch (error) {
      console.warn("[KRC Card API] subscriber failed", error);
    }
  };
  const unsubs = SOURCE_EVENTS[want.kind].map((name) => subscribeKrcSync(name, (event) => {
    if (name === KRC_SYNC_EVENTS.IDENTITY_CHANGED && event?.detail?.identity) {
      // Identity swaps are delivered at once (and never coalesced away).
      try {
        onChange({ type: "identity", identity: { ...event.detail.identity } });
      } catch (error) {
        console.warn("[KRC Card API] subscriber failed", error);
      }
      return;
    }
    pending = { type: "changed" };
    if (!timer) timer = setTimeout(flush, 150);
  }));
  return () => {
    unsubs.forEach((off) => off());
    if (timer) clearTimeout(timer);
    timer = 0;
  };
}

// ---- Picking from the Portal -------------------------------------------------------

// Opens the KRC Portal on the source; resolves to the chosen card ref, or null when the
// Portal is closed without one. The user selects a card and presses the gold button
// (or double-clicks a card). A card from outside the source is refused with a toast.
export function pickCard(source, { label = "Use", title = "" } = {}) {
  const want = normalizeCardSource(source);
  return new Promise((resolve) => {
    openLibraryModal({
      provider: want.kind === "model" ? "models" : "prompts",
      scope: want.kind === "model" ? (want.folder || "all") : undefined,
      pick: {
        label,
        title: title || "Use the selected card",
        onPick: (item) => {
          const ref = cardRef(item, want.kind);
          if (!cardMatchesSource(ref, want)) {
            const where = want.kind === "model" ? `the ${want.folder} folder` : `the ${want.category} category`;
            showToast(`Pick a card from ${where}`);
            return false;
          }
          resolve(ref);
          return true;
        },
        onCancel: () => resolve(null),
      },
    });
  });
}

// Opens the Portal on the card with its info panel (the Info action on a card's menu).
export function openCardInfo(ref) {
  if (!ref) return;
  if (ref.kind === "prompt") {
    openLibraryModal({ provider: "prompts", select: { id: ref.id, category: ref.category, name: ref.title }, infoOpen: true });
  } else {
    openLibraryModal({ provider: "models", scope: ref.folder || "all", select: { sha256: ref.id }, infoOpen: true });
  }
}

// ---- Drag and drop -----------------------------------------------------------------

// The card being dragged right now (from the Portal, any KRC node, or a makeCardDraggable
// element) as a ref when it belongs to the source, else null. Call it in dragover (to
// accept and highlight) and in drop.
export function readCardDrag(source) {
  const payload = getKrcDragPayload();
  const ref = payload ? cardRef(payload) : null;
  return cardMatchesSource(ref, source) ? ref : null;
}

// Makes an element drag a card ref into the Portal-aware drop targets (LoRA Loadout,
// Config Switcher, RefMod Loadout and any readCardDrag node). Returns a cleanup function.
export function makeCardDraggable(element, ref) {
  if (!element || !ref) return () => {};
  const onStart = (event) => {
    const isLora = ref.kind === "model" && ref.folder === "lora";
    const payload = ref.kind === "prompt"
      ? { kind: "prompt", id: ref.id, category: ref.category, title: ref.title }
      : { kind: isLora ? "lora" : "model", id: ref.id, modelType: ref.folder, title: ref.title };
    setKrcDragPayload({
      ...payload,
      thumbnailUrl: ref.thumbnailUrl,
      cardColor: ref.cardColor,
      favorite: ref.favorite,
    });
    element.classList.add("is-dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "copy";
      const full = { ...payload, thumbnailUrl: ref.thumbnailUrl, cardColor: ref.cardColor, customBadge: ref.customBadge, favorite: ref.favorite, nsfw: ref.nsfw };
      event.dataTransfer.setData(ref.kind === "prompt" ? "application/x-krc-prompt" : "application/x-krc-model", JSON.stringify(full));
      if (isLora) event.dataTransfer.setData("application/x-krc-lora", ref.id);
      event.dataTransfer.setData("text/plain", ref.title || ref.id);
    }
  };
  const onEnd = () => {
    element.classList.remove("is-dragging");
    clearKrcDragPayload();
  };
  element.draggable = true;
  element.addEventListener("dragstart", onStart);
  element.addEventListener("dragend", onEnd);
  return () => {
    element.removeEventListener("dragstart", onStart);
    element.removeEventListener("dragend", onEnd);
  };
}

// ---- Rendering ---------------------------------------------------------------------

// Loads the shared KRC sheets (tokens, palettes, components) the cards are styled by.
// A node that renders cards calls it once and puts them inside an element with the
// `krc-node` class (applyNodePalette on that element picks the palette).
export function ensureCardStyles() {
  for (const name of ["design_tokens", "themes", "components"]) {
    ensureStylesheet(`krc-shared-${name}-css`, `./${name}.css`, import.meta.url, { version: SHARED_STYLE_VERSION });
  }
}

const refCardSource = {
  keyOf: (ref) => `${ref.kind}:${ref.id}`,
  setCardKey: (card, ref) => {
    card.dataset.krcCardKind = ref.kind;
    card.dataset.krcCardId = ref.id;
  },
  cardColor: (ref) => ref.cardColor || "",
  resolveThumbnail: (ref) => ({
    url: ref.thumbnailUrl || "",
    previewVideoUrl: ref.previewVideoUrl || "",
    placeholderKind: "image",
    blurred: ref.nsfw && !readGlobalSetting(SHOW_NSFW_SETTING_ID, SHOW_NSFW_DEFAULT),
  }),
  nameText: (ref) => ref.title || (ref.kind === "prompt" ? "Prompt" : "Model"),
  subtitleText: (ref) => ref.subtitle || "",
  fillBadgeRow: (row, ref) => {
    let count = 0;
    if (ref.favorite) {
      row.append(el("span", "krc-badge-star", { textContent: "★", title: "Favorite" }));
      count++;
    }
    if (ref.nsfw) {
      row.append(el("span", "krc-card-badge krc-nsfw-badge", { textContent: "NSFW" }));
      count++;
    }
    if (ref.customBadge) {
      row.append(el("span", "krc-card-badge is-json", { textContent: ref.customBadge, title: "Custom badge" }));
      count++;
    }
    return count;
  },
  hasNotch: (ref, key, opts) => opts.menu !== false && !opts.missing, // Info needs a real card
  notchMenu: (ref) => ({
    context: "embedded",
    kind: ref.kind,
    id: ref.id,
    title: ref.title,
    actions: [{
      id: "info",
      icon: "i",
      label: "Info",
      title: ref.kind === "prompt" ? "Open in Prompt Vault" : "Open in Model Library",
      onClick: () => openCardInfo(ref),
    }],
  }),
  installInteractions: (card, ref, key, opts) => {
    if (opts.onClick) {
      card.setAttribute("role", "button");
      card.setAttribute("tabindex", "0");
      card.addEventListener("click", (event) => opts.onClick(ref, event));
      card.addEventListener("keydown", (event) => {
        if (event.target !== card || (event.key !== "Enter" && event.key !== " ")) return;
        event.preventDefault();
        opts.onClick(ref, event);
      });
    }
    if (opts.draggable !== false) makeCardDraggable(card, ref);
  },
};

// One KRC card for a ref. opts: { selected, onClick(ref, event), draggable (default
// true), menu (default true: the notch menu with Info), missing (1.6: the shared MISSING
// look, from cardStatus) }.
export function renderCard(ref, opts = {}) {
  return renderModelCard(ref, refCardSource, opts);
}

// The browser's three card views, by their canonical names (shared/browser_views.js):
// "thumb-list" (thumbnail + two text rows, the default), "list" (text rows; listThumbs
// adds the tiny portrait thumbnail) and "grid" (two columns of tall cards).
const LIST_VIEWS = new Set(["thumb-list", "list", "grid"]);

// An empty card list styled exactly like that browser view; append renderCard()s to it.
// Its height is the caller's (it scrolls when given one).
export function createCardList({ view = "thumb-list", listThumbs = false } = {}) {
  const resolved = LIST_VIEWS.has(view) ? view : "thumb-list";
  const list = el("div", browserListClass(resolved, { listThumbs: resolved === "list" && listThumbs }));
  // The browser widens its lists by a scrollbar lane its virtualizer subtracts again; a
  // plain list keeps its container's width so the cards line up with it.
  list.style.width = "100%";
  return list;
}

// A list of cards in one of the browser views (see createCardList). Same opts as
// renderCard, plus isSelected(ref).
export function renderCardList(refs, { view = "thumb-list", listThumbs = false, isSelected, ...opts } = {}) {
  const list = createCardList({ view, listThumbs });
  for (const ref of refs || []) {
    list.append(renderCard(ref, { ...opts, selected: isSelected ? Boolean(isSelected(ref)) : false }));
  }
  return list;
}
