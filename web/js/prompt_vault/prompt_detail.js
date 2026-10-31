/*
 * KRC Prompt Vault — prompt detail.
 * The saved record behind the draft, deferred prompt text (fetched on
 * demand into a small per-node cache), card-colour state, and drafts built from records.
 * Mixed onto the Prompt Vault controller prototype via Object.assign.
 */
import { UNASSIGNED_CATEGORY } from "./constants.js";
import { apiGet } from "./api.js";
import { normalizeKitPresets } from "./kit_presets.js";

const HEAVY_PROMPT_TEXT_KEYS = ["prompt", "promptB", "notes"];
const PROMPT_DETAIL_CACHE_LIMIT = 4;

export function promptSummaryItem(category, name, record = {}) {
  const out = { category, name, ...record };
  const existingTextLength = Number(out.textLength) || 0;
  let heavyTextLength = 0;
  let textDeferred = !!out.textDeferred;
  for (const key of HEAVY_PROMPT_TEXT_KEYS) {
    const value = out[key];
    if (value) {
      heavyTextLength += String(value).length;
      textDeferred = true;
    }
    out[key] = "";
  }
  out.textDeferred = textDeferred;
  out.textLength = Math.max(existingTextLength, heavyTextLength);
  return out;
}

function rememberPromptDetail(cache, key, detail) {
  if (!cache || !key || !detail) return;
  cache.delete(key);
  cache.set(key, { ...detail, textDeferred: false });
  while (cache.size > PROMPT_DETAIL_CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

export const detailMethods = {
  savedForDraft() {
    if (this.profileMismatch?.()) return this._savedPromptDetail;
    const saved = this.orig ? this.findByKey(this.keyOf(this.orig.category, this.orig.name)) : null;
    return saved && (!this.draft?.id || saved.id === this.draft.id) ? saved : null;
  },
  savedDetailForDraft() {
    if (!this.orig || !this._savedPromptDetail) return null;
    return this.keyOf(this.orig.category, this.orig.name) === this.keyOf(this._savedPromptDetail.category, this._savedPromptDetail.name)
      ? this._savedPromptDetail
      : null;
  },
  dataRecordForDraft() {
    return this.orig && !this.profileMismatch?.() ? this.data?.[this.orig.category]?.[this.orig.name] : null;
  },
  hasDeferredPromptText(record) {
    return !!record?.textDeferred;
  },
  mergePromptSummary(target, detail) {
    if (!target || !detail) return target;
    Object.assign(target, promptSummaryItem(detail.category || target.category, detail.name || target.name, detail));
    return target;
  },
  applyPromptDetailToStores(detail) {
    if (!detail?.category || !detail?.name) return null;
    if (detail.profileId && this.effectiveProfileId && detail.profileId !== this.effectiveProfileId()) return detail;
    const key = this.keyOf(detail.category, detail.name);
    const current = this.findByKey(key);
    if (current?.id && detail.id && current.id !== detail.id) return detail;
    rememberPromptDetail(this._promptDetailCache, key, detail);
    const item = this.findByKey(key);
    if (item && item.id === detail.id) this.mergePromptSummary(item, detail);
    return this._promptDetailCache?.get(key) || item || null;
  },
  async ensurePromptDetail(record, { refresh = false } = {}) {
    if (!record?.category || !record?.name || (!refresh && !this.hasDeferredPromptText(record))) {
      return record;
    }
    const cacheKey = this.keyOf(record.category, record.name);
    const promiseKey = `${cacheKey}:${record.id || ""}`;
    this._promptDetailPromises ||= new Map();
    if (!refresh && this._promptDetailCache?.has(cacheKey) && (!record.id || this._promptDetailCache.get(cacheKey).id === record.id)) {
      return this._promptDetailCache.get(cacheKey);
    }
    if (!refresh && this._promptDetailPromises.has(promiseKey)) {
      return this._promptDetailPromises.get(promiseKey);
    }
    const promise = (async () => {
      const qs = new URLSearchParams(record.id ? { id: record.id } : { category: record.category, name: record.name });
      const detail = await apiGet.call(this, `/prompt-detail?${qs.toString()}`);
      if (!detail || detail.category !== record.category || detail.name !== record.name) {
        return record;
      }
      return this.applyPromptDetailToStores(detail) || record;
    })().finally(() => {
      this._promptDetailPromises?.delete(promiseKey);
    });
    this._promptDetailPromises.set(promiseKey, promise);
    return promise;
  },
  preservePromptText(target, source) {
    if (!target || !source) return target;
    return this.mergePromptSummary(target, this.draftFromSummaryAndText(target, source));
  },
  setSavedPromptDetail(summary, textSource = summary) {
    if (!summary) return null;
    const detail = this.draftFromSummaryAndText(summary, textSource);
    this._savedPromptDetail = detail;
    if (detail.category && detail.name) {
      rememberPromptDetail(this._promptDetailCache, this.keyOf(detail.category, detail.name), detail);
    }
    return detail;
  },
  preserveSelectedPromptText() {
    if (!this.selKey || !this.draft) return null;
    const current = this.findByKey(this.selKey);
    return current ? this.preservePromptText(current, this.draft) : null;
  },
  applyPromptCardColorState(cardColor) {
    const saved = this.savedForDraft();
    const dataRecord = this.dataRecordForDraft();
    const snapshot = {
      draft: this.draft?.cardColor || "",
      saved: saved?.cardColor || "",
      data: dataRecord?.cardColor || "",
    };
    if (this.draft) this.draft.cardColor = cardColor;
    if (saved) saved.cardColor = cardColor;
    if (dataRecord) dataRecord.cardColor = cardColor;
    return snapshot;
  },
  restorePromptCardColorState(snapshot = {}) {
    const saved = this.savedForDraft();
    const dataRecord = this.dataRecordForDraft();
    if (this.draft) this.draft.cardColor = snapshot.draft || "";
    if (saved) saved.cardColor = snapshot.saved || "";
    if (dataRecord) dataRecord.cardColor = snapshot.data || "";
  },

  draftFromSummaryAndText(summary, textSource = {}) {
    return {
      ...summary,
      prompt: textSource.prompt || "",
      promptB: textSource.promptB || "",
      notes: textSource.notes || "",
      textDeferred: false,
    };
  },
  detailFromPromptLibrary(data, category, name, textSource = {}) {
    const summary = data?.[category]?.[name];
    if (!summary || typeof summary !== "object") return { ...textSource, category, name };
    return this.draftFromSummaryAndText({ category, name, ...summary }, textSource);
  },

  draftFromSerialized(saved, serialized = {}) {
    const value = (name, fallback = "") => serialized?.[name] ?? fallback;
    const boolValue = (name, fallback = false) => {
      const raw = value(name, fallback);
      if (typeof raw === "string") return raw === "true" || raw === "1";
      return !!raw;
    };
    return {
      ...saved,
      id: value("id", saved.id || ""),
      profileId: value("profileId", saved.profileId || "default"),
      category: value("category", saved.category || UNASSIGNED_CATEGORY) || UNASSIGNED_CATEGORY,
      name: value("name", saved.name || ""),
      prompt: value("prompt", saved.prompt || ""),
      llPreset: value("llPreset", saved.llPreset || ""),
      kitPresets: normalizeKitPresets(value("kitPresets", saved.kitPresets)),
      promptB: value("promptB", saved.promptB || ""),
      model: value("model", saved.model || ""),
      notes: value("notes", saved.notes || ""),
      replaceFind: value("replaceFind", saved.replaceFind || ""),
      replaceWith: value("replaceWith", saved.replaceWith || ""),
      customBadge: value("customBadge", saved.customBadge || ""),
      rating: Number(saved.rating) || 0,
      appendPromptB: boolValue("appendPromptB", !!saved.appendPromptB),
    };
  },
};
