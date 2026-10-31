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

  _setThumbState(has, id, thumbType = "image", saved = {}) {
    if (!has) this.disarmThumbRemove();
    const now = saved.dateModified || new Date().toISOString();
    const thumbnailVersion = saved.thumbnailVersion || now;
    if (this.draft) {
      this.draft.hasThumb = has;
      this.draft.thumbType = has ? thumbType : "";
      this.draft.thumbHasPoster = !!has;
      if (id) this.draft.id = id;
      this.draft.dateAdded = this.draft.dateAdded || now;
      this.draft.dateModified = now;
      this.draft.thumbnailVersion = thumbnailVersion;
    }
    const rec = this.data[this.orig.category]?.[this.orig.name];
    if (rec) {
      if (has) { rec.hasThumb = true; rec.thumbType = thumbType; rec.thumbHasPoster = true; if (id) rec.id = id; } else { delete rec.hasThumb; delete rec.thumbType; delete rec.thumbHasPoster; }
      rec.dateAdded = rec.dateAdded || now;
      rec.dateModified = now;
      rec.thumbnailVersion = thumbnailVersion;
    }
    this.flatten();
    this.publishPromptLibrary?.(this.data, {
      lane: KRC_SYNC_LANES.METADATA,
      detail: this.detailFromPromptLibrary?.(this.data, this.orig.category, this.orig.name, this.draft),
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
    // One picker, two paths: an mp4/webm is transcoded server-side, a still image
    // goes through the existing data-URL upload.
    if (isVideoFile(file)) return this._uploadVideoThumb(file);
    try {
      const dataUrl = await blobToDataURL(file);
      const resp = await apiPost.call(this, "/upload-thumbnail", { category: this.orig.category, name: this.orig.name, thumbnail: dataUrl });
      if (apiSucceeded(resp)) this._setThumbState(true, resp.id, "image", resp);
      else toastApiError((msg) => this.toast(msg), resp, "Upload failed (restart ComfyUI for the new routes?)");
    } catch {
      this.toast("Upload failed");
    }
  },

  async _uploadVideoThumb(file) {
    if (!this.orig || !file) return;
    try {
      const form = new FormData();
      form.append("category", this.orig.category);
      form.append("name", this.orig.name);
      form.append("video", file);
      const response = await apiFetch.call(this, "/upload-video-thumbnail", { method: "POST", body: form });
      let resp = { success: false };
      try { resp = await response.json(); } catch { resp = { success: false }; }
      if (response.ok && apiSucceeded(resp)) {
        this._setThumbState(true, resp.id, resp.hasAnimation ? "video" : "image", resp);
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
    try {
      const image = await clipboardImageBlob();
      if (!image) { this.toast("Clipboard has no image"); return; }
      const dataUrl = await blobToDataURL(image.blob);
      const resp = await apiPost.call(this, "/upload-thumbnail", { category: this.orig.category, name: this.orig.name, thumbnail: dataUrl });
      if (apiSucceeded(resp)) this._setThumbState(true, resp.id, "image", resp);
      else toastApiError((msg) => this.toast(msg), resp, "Paste failed");
    } catch {
      this.toast("Clipboard paste unavailable");
    }
  },

  async removeThumb() {
    if (!this.orig) return;
    const resp = await apiPost.call(this, "/remove-thumbnail", { category: this.orig.category, name: this.orig.name });
    if (apiSucceeded(resp)) this._setThumbState(false, resp.id, "image", resp);
    else toastApiError((msg) => this.toast(msg), resp, "Remove failed");
  }
};
