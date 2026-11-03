/*
 * KRC Prompt Vault — thumbnails.
 * Thumbnail URL + upload/paste/remove/state, over the shared
 * /krc/prompt-vault thumbnail routes. Mixed onto
 * the Prompt Vault controller prototype via Object.assign.
 */
import { blobToDataURL, clipboardImageBlob, isVideoFile, pickThumbnailFile } from "../shared/files.js";
import { apiSucceeded, toastApiError } from "../shared/api.js";
import { KRC_SYNC_LANES } from "../shared/sync_bus.js";
import { apiFetch, apiPost, promptThumbnailUrl } from "./api.js";

export const thumbnailMethods = {
  disarmThumbRemove() { this._thumbRemoveConfirm?.reset(); },

  // Versioned by the record's server-issued token (see promptThumbnailUrl), so only a
  // re-uploaded image busts its cache. null when the record has no thumbnail.
  thumbUrl(item, kind = "") {
    return promptThumbnailUrl(item, kind) || null;
  },

  // `target` is the prompt the upload started on ({ category, name }). The user may have
  // moved on while it ran, so only that prompt's record changes; the open draft only
  // when it is still the same prompt.
  _setThumbState(has, id, thumbType = "image", saved = {}, target = this.orig) {
    const current = !!target && this.orig?.category === target.category && this.orig?.name === target.name;
    if (current && !has) this.disarmThumbRemove();
    const now = saved.dateModified || new Date().toISOString();
    const thumbnailVersion = saved.thumbnailVersion || now;
    if (current && this.draft) {
      this.draft.hasThumb = has;
      this.draft.thumbType = has ? thumbType : "";
      this.draft.thumbHasPoster = !!has;
      if (id) this.draft.id = id;
      this.draft.dateAdded = this.draft.dateAdded || now;
      this.draft.dateModified = now;
      this.draft.thumbnailVersion = thumbnailVersion;
    }
    const rec = target && this.data[target.category]?.[target.name];
    if (rec) {
      if (has) { rec.hasThumb = true; rec.thumbType = thumbType; rec.thumbHasPoster = true; if (id) rec.id = id; } else { delete rec.hasThumb; delete rec.thumbType; delete rec.thumbHasPoster; }
      rec.dateAdded = rec.dateAdded || now;
      rec.dateModified = now;
      rec.thumbnailVersion = thumbnailVersion;
    }
    this.flatten();
    this.publishPromptLibrary?.(this.data, {
      lane: KRC_SYNC_LANES.METADATA,
      // Metadata lane: receivers keep their own prompt text, so another prompt needs none.
      detail: target && this.detailFromPromptLibrary?.(this.data, target.category, target.name, current ? this.draft : {}),
    });
    this.preserveSelectedPromptText?.();
    this.refreshPromptMutation({
      list: true,
      replaceCard: false,
    });
  },

  async uploadThumb() {
    if (!this.orig) { this.toast("Save the prompt first"); return; }
    if (this.pasteThumbMode) return this.pasteThumb();
    const file = await pickThumbnailFile();
    if (!file) return;
    return this.uploadThumbFile(file);
  },

  // A picked file, or a Media card dropped on the thumbnail (shared/media_thumbnail_drop.js).
  async uploadThumbFile(file) {
    if (!this.orig) { this.toast("Save the prompt first"); return; }
    // Two paths: an mp4/webm is transcoded server-side, a still image goes through the
    // existing data-URL upload.
    if (isVideoFile(file)) return this._uploadVideoThumb(file);
    const target = { category: this.orig.category, name: this.orig.name };
    try {
      const dataUrl = await blobToDataURL(file);
      const resp = await apiPost.call(this, "/upload-thumbnail", { ...target, thumbnail: dataUrl });
      if (apiSucceeded(resp)) this._setThumbState(true, resp.id, "image", resp, target);
      else toastApiError((msg) => this.toast(msg), resp, "Upload failed (restart ComfyUI for the new routes?)");
    } catch {
      this.toast("Upload failed");
    }
  },

  async _uploadVideoThumb(file) {
    if (!this.orig || !file) return;
    const target = { category: this.orig.category, name: this.orig.name };
    try {
      const form = new FormData();
      form.append("category", target.category);
      form.append("name", target.name);
      form.append("video", file);
      const response = await apiFetch.call(this, "/upload-video-thumbnail", { method: "POST", body: form });
      let resp = { success: false };
      try { resp = await response.json(); } catch { resp = { success: false }; }
      if (response.ok && apiSucceeded(resp)) {
        this._setThumbState(true, resp.id, resp.hasAnimation ? "video" : "image", resp, target);
        if (!resp.hasAnimation) {
          this.toast("Saved a static poster (this ComfyUI's PyAV has no VP9 encoder)");
        }
      } else {
        toastApiError((msg) => this.toast(msg), resp, "Video upload failed (restart ComfyUI for the new routes?)");
      }
    } catch {
      this.toast("Video upload failed");
    }
  },

  async pasteThumb() {
    if (!this.orig) { this.toast("Save the prompt first"); return; }
    const target = { category: this.orig.category, name: this.orig.name };
    try {
      const image = await clipboardImageBlob();
      if (!image) { this.toast("Clipboard has no image"); return; }
      const dataUrl = await blobToDataURL(image.blob);
      const resp = await apiPost.call(this, "/upload-thumbnail", { ...target, thumbnail: dataUrl });
      if (apiSucceeded(resp)) this._setThumbState(true, resp.id, "image", resp, target);
      else toastApiError((msg) => this.toast(msg), resp, "Paste failed");
    } catch {
      this.toast("Clipboard paste unavailable");
    }
  },

  async removeThumb() {
    if (!this.orig) return;
    const target = { category: this.orig.category, name: this.orig.name };
    const resp = await apiPost.call(this, "/remove-thumbnail", target);
    if (apiSucceeded(resp)) this._setThumbState(false, resp.id, "image", resp, target);
    else toastApiError((msg) => this.toast(msg), resp, "Remove failed");
  }
};
