/*
 * KRC Prompt Vault — API client.
 * Thin fetch wrappers over the shared /krc/prompt-vault routes.
 */
import { forgetInFlight, isWriteRequest, postJson, sharedGetJson } from "../shared/api.js";
import { withSyncOrigin } from "../shared/sync_origin.js";
import { API } from "./constants.js";

const libraryProfiles = new WeakMap();
export const libraryProfileId = data => data && typeof data === "object" ? libraryProfiles.get(data) : null;
function remember(data, profile) {
  const library = data?.prompts || data;
  if (library && typeof library === "object") libraryProfiles.set(library, profile);
  return data;
}
export function apiUrl(path, profile = "default") {
  const suffix = profile === "default" ? "" : `${path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(profile)}`;
  return API + path + suffix;
}

// A prompt record's thumbnail URL, or "" when it has none. Versioned by the record's own
// thumbnailVersion so an unchanged thumbnail keeps a stable, browser-cacheable URL,
// while a replacement busts just that image. Old records fall back to dateModified.
// kind: "" | "poster" |
// "animated". Shared by Prompt Vault and Config Switcher prompt cards.
export function promptThumbnailUrl(record, kind = "") {
  if (!record || !record.id || !record.hasThumb) return "";
  const v = encodeURIComponent(record.thumbnailVersion || record.dateModified || record.id);
  const kindParam = kind ? `&kind=${encodeURIComponent(kind)}` : "";
  return apiUrl(`/thumbnail?id=${encodeURIComponent(record.id)}&v=${v}${kindParam}`);
}

// The still a prompt card shows: a video thumbnail's poster, else the thumbnail itself.
export function promptCardThumbnailUrl(record) {
  return record?.thumbType === "video" && record?.thumbHasPoster
    ? promptThumbnailUrl(record, "poster")
    : promptThumbnailUrl(record);
}

// A write can succeed after the user changes profiles. Keep the caller from
// adopting its old-profile response, while accurately reporting the committed write.
function previousProfileResult(result, profile) {
  const completed = result?.success === true;
  return { ...result, success: false, profileChanged: true, completedInPreviousProfile: completed, profileId: profile,
    error: completed ? "The change was saved in the previous profile. Your current editor was kept. You don't need to save it again."
      : result?.error || "The change could not be saved in the previous profile." };
}

export function apiFetch(path, options, profile = this?.effectiveProfileId?.() || "default") {
  if (isWriteRequest(options) && (this?.profileMissing?.() || this?.profileMismatch?.())) {
    return Promise.resolve(new Response(JSON.stringify({ success: false, error: "Choose the prompt's profile before editing its thumbnail." }), { status: 409 }));
  }
  const request = fetch(apiUrl(path, profile), withSyncOrigin(options)).then(async response => {
    if (isWriteRequest(options) && this?.effectiveProfileId && profile !== this.effectiveProfileId()) {
      const payload = await response.clone().json().catch(() => null);
      const result = payload && typeof payload === "object" ? payload : { success: false };
      if (!response.ok) result.success = false;
      return new Response(JSON.stringify(previousProfileResult(result, profile)), {
        status: 409, headers: { "Content-Type": "application/json" },
      });
    }
    return response;
  });
  return isWriteRequest(options) ? request.finally(() => forgetInFlight()) : request;
}

/** GET a JSON endpoint; returns parsed JSON, or null on non-OK/error. */
export async function apiGet(path) {
  const profile = this?.effectiveProfileId?.() || "default";
  const { ok, data } = await sharedGetJson(apiUrl(path, profile), () => apiFetch.call(this, path, undefined, profile)).catch(() => ({ ok: false }));
  return ok ? data : null;
}

/** The whole prompt library, shared with any other surface requesting it at the same
 * time (Prompt Vault nodes, Config Switcher's card catch-up). Null on failure. */
export function fetchPromptLibraryJson(profile = "default") {
  return sharedGetJson(apiUrl("/get-prompts", profile), () => fetch(apiUrl("/get-prompts", profile)))
    .then(({ ok, data }) => (ok ? remember(data, profile) : null), () => null);
}

// Read-only reference catch-up, shared across external cards. Synthetic buckets keep
// same-name records from different profiles distinct; each detail carries its real name.
export async function fetchPromptDetails(ids) {
  const unique = [...new Set(ids)].sort();
  const details = [];
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const { ok, data } = await sharedGetJson(`${apiUrl("/prompt-details")}:${JSON.stringify(chunk)}`, () => fetch(apiUrl("/prompt-details"), {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: chunk }),
    })).catch(() => ({ ok: false }));
    if (!ok || !Array.isArray(data?.details)) return null;
    details.push(...data.details);
  }
  return details;
}

export async function withPromptReferences(library, ids) {
  if (!library) return null;
  const held = new Set(Object.values(library).flatMap(bucket => Object.values(bucket || {}).map(record => record?.id)));
  const missing = ids.filter(id => id && !held.has(id));
  if (!missing.length) return library;
  const details = await fetchPromptDetails(missing);
  if (!details) return null;
  return { ...library, ...Object.fromEntries(details.map(record => [`__ref_${record.id}`, { [record.name]: record }])) };
}

/** POST JSON to an endpoint; returns parsed JSON, or {success:false} on error. */
export async function apiPost(path, body) {
  try {
    if (this?.profileMissing?.()) return { success: false, error: "Missing profile. Choose a profile before saving." };
    // A foreign editor may only create a fresh copy, never mutate by legacy name.
    if (path !== "/copy-to-profile" && this?.profileMismatch?.() && ((body?.id && body.id === this.draft?.id)
        || (!body?.id && body?.category === this.orig?.category && body?.name === this.orig?.name))) {
      return { success: false, error: "This prompt belongs to another profile. Switch back to edit it." };
    }
    const profile = this?.effectiveProfileId?.() || "default";
    const result = remember(await postJson(apiUrl(path, profile), body, {
      fallback: { success: false }, fetcher: (url, options) => fetch(url, withSyncOrigin(options)),
    }), profile);
    if (this?.effectiveProfileId && profile !== this.effectiveProfileId()) {
      return previousProfileResult(result, profile);
    }
    return result;
  } finally {
    forgetInFlight();   // a later library read must not join one from before this write
  }
}
