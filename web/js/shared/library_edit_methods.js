/*
 * Record edits shared by LoRA Loadout and Model Library: thumbnails, save, stale-metadata
 * clean-up and stabilize. One copy, so a LoRA edits the same way in both nodes.
 * Each node passes its own record routes (its ./api.js); Model Library also opts into
 * queuing a background stabilize after a saved edit. Generic-model branches key off
 * isGenericModel, which only Model Library defines.
 */
import { clipboardImageFile, isVideoFile, pickThumbnailFile } from "./files.js";
import { applyStabilizeGlow } from "./stabilize_glow.js";
import { el } from "./dom.js";
import { openKrcModal, krcAlert } from "./modal.js";
import { showToast } from "./toast.js";
import { armConfirmButton } from "./confirm_action.js";
import { NO_VIDEO_MESSAGE } from "./video_status.js";

export function makeLibraryEditMethods({ fetchLora, postLoraForm, postLoraJson, deleteLoraJson }, { autoStabilizeOnPersist = false } = {}) {
  return {
  // An upload, save or stabilize finishes after its own await, by which time the user may
  // have moved on: it updates its own record (card, stacks), never the selection, and
  // rebuilds the info panel only when that record is still the one shown.
  refreshInfoIfSelected(sha256) {
    if (sha256 && this.selectedSha === sha256) this.refreshInfo();
  },

  selectThumbnailFile(selected) {
    if (!selected?.sha256) {
      return;
    }

    pickThumbnailFile().then((file) => {
      if (!file) {
        return;
      }
      // One picker, two paths: an mp4/webm goes through the transcode route, a
      // still image through the image route.
      if (isVideoFile(file)) {
        this.uploadThumbnailVideo(selected, file);
      } else {
        this.uploadThumbnail(selected, file);
      }
    });
  },

  async pasteThumbnail(selected) {
    if (!selected?.sha256) {
      return;
    }
    try {
      const file = await clipboardImageFile("pasted-thumbnail");
      if (file) {
        await this.uploadThumbnail(selected, file);
        return;
      }
    } catch (error) {
      if (error?.message === "clipboard-read-unavailable") {
        krcAlert("Clipboard image paste is not available in this browser.", this.node);
        return;
      }
      krcAlert("Could not read the clipboard. Grant clipboard permission, then copy an image and try again.", this.node);
      return;
    }
    krcAlert("No image found on the clipboard.", this.node);
  },

  async uploadThumbnail(selected, file) {
    if (!selected?.sha256 || !file) {
      return;
    }

    const form = new FormData();
    form.append("image", file);
    let response;
    try {
      response = this.isGenericModel?.(selected)
        ? await fetchLora(`/thumbnail/${selected.sha256}`, { method: "POST", body: file })
        : await postLoraForm(`/thumbnail/${selected.sha256}`, form);
    } catch {
      krcAlert("Thumbnail upload failed. Check the ComfyUI server log.", this.node);
      return;
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.json())?.error || "";
      } catch {
        detail = "";
      }
      krcAlert(`Could not save thumbnail${detail ? `: ${detail}` : ` (HTTP ${response.status}).`}`, this.node);
      return;
    }
    // The server's new thumbnail version for this item: its image URL's ?v=.
    const version = Number((await response.json().catch(() => ({})))?.thumbnailVersion) || Date.now();
    this.updateLibraryLora(selected.sha256, {
      thumbnail: true,
      thumbnailRemoved: false,
      thumbnailVersion: version,
      thumbnailSha: this.thumbnailSourceSha(selected),
      thumbnailType: "image",
      thumbnailHasPoster: true,
      thumbnailHasAnimation: false,
    });
    this.refreshLoraCard(selected.sha256);
    this.announceThumbnailChange(selected.sha256);
    this.refreshStacks();
    this.refreshInfoIfSelected(selected.sha256);
    // Uploading a thumbnail is a deliberate investment in this record — promote a
    // path-derived id to a stable SHA256 id (where the node opts in; no-op once stable).
    this.autoStabilizeAfterPersist(selected.sha256);
  },

  async uploadThumbnailVideo(selected, file) {
    if (!selected?.sha256 || !file) {
      return;
    }

    const form = new FormData();
    form.append("video", file);
    let response;
    try {
      response = await postLoraForm(`/thumbnail/${selected.sha256}/upload-video`, form);
    } catch {
      krcAlert("Video thumbnail upload failed. Check the ComfyUI server log.", this.node);
      return;
    }
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || !body.ok) {
      const detail = body?.error || `HTTP ${response.status}`;
      krcAlert(`Could not save video thumbnail: ${detail}`, this.node);
      return;
    }
    if (!body.hasAnimation) {
      // Poster written but no loop — server has no VP9 encoder. Tell the user why
      // their video became a still instead of silently degrading.
      showToast("Saved a static poster: this ComfyUI's PyAV has no VP9 (libvpx-vp9) encoder, so no animated WebM was generated.", { duration: 6000 });
    }
    const version = Number(body.thumbnailVersion) || Date.now();
    this.updateLibraryLora(selected.sha256, {
      thumbnail: true,
      thumbnailRemoved: false,
      thumbnailVersion: version,
      thumbnailSha: this.thumbnailSourceSha(selected),
      thumbnailType: "video",
      thumbnailHasPoster: !!body.hasPoster,
      thumbnailHasAnimation: !!body.hasAnimation,
    });
    this.refreshLoraCard(selected.sha256);
    this.announceThumbnailChange(selected.sha256);
    this.refreshStacks();
    this.refreshInfoIfSelected(selected.sha256);
    // Same investment as an image upload: promote a path-derived model to a stable
    // SHA256 id so its thumbnail isn't orphaned by a later stabilize (no-op for
    // already-stable ids).
    this.autoStabilizeAfterPersist(selected.sha256);
  },

  async deleteThumbnail(selected) {
    if (!selected?.sha256) {
      return;
    }

    let response;
    try {
      response = await fetchLora(`/thumbnail/${selected.sha256}`, { method: "DELETE" });
    } catch {
      krcAlert("Thumbnail removal failed. Check the ComfyUI server log.", this.node);
      return;
    }
    if (!response.ok) {
      krcAlert(`Could not remove thumbnail (HTTP ${response.status}).`, this.node);
      return;
    }
    const payload = await response.json();
    const deleted = this.isGenericModel?.(selected) ? payload?.deleted : payload?.ok;
    if (!deleted) {
      krcAlert("No saved thumbnail was found to remove.", this.node);
      return;
    }
    this.updateLibraryLora(selected.sha256, {
      thumbnail: "",
      thumbnailRemoved: true,
      thumbnailVersion: 0,
      thumbnailSha: this.thumbnailSourceSha(selected),
      thumbnailType: "image",
      thumbnailHasPoster: false,
      thumbnailHasAnimation: false,
    });
    this.refreshLoraCard(selected.sha256);
    this.announceThumbnailChange(selected.sha256);
    this.refreshStacks();
    this.refreshInfoIfSelected(selected.sha256);
  },

  async refreshThumbnailFromSource(selected) {
    if (!selected?.sha256) {
      return null;
    }

    let response;
    try {
      response = await fetchLora(`/thumbnail/${selected.sha256}/refresh-source`, { method: "POST" });
    } catch {
      krcAlert("Thumbnail refresh failed. Check the ComfyUI server log.", this.node);
      return null;
    }
    let body = {};
    try {
      body = await response.json();
    } catch {
      body = {};
    }
    if (!response.ok || !body.ok) {
      const reason = body?.reason || body?.error || `HTTP ${response.status}`;
      const messages = {
        no_source: "No local thumbnail source was recorded for this LoRA.",
        unsupported_source: "This thumbnail source type is not supported yet.",
        pillow_unavailable: "Pillow is not available, so still-image thumbnail refresh cannot run.",
        no_pyav: NO_VIDEO_MESSAGE,
        no_pillow: "Pillow is not available, so posters can't be written on this system.",
        webm_unavailable: "This ComfyUI's PyAV can't write animated WebM thumbnails (no VP9 encoder).",
        convert_failed: "The thumbnail source could not be converted.",
      };
      krcAlert(messages[reason] || `Could not refresh thumbnail: ${reason}`, this.node);
      return null;
    }
    const current = await this.refreshLibraryRecord(selected.sha256);
    if (current) this.announceThumbnailChange(current.sha256);
    return current;
  },

  // Tell every other copy (and Config Switcher cards) about this record's new thumbnail.
  announceThumbnailChange(sha256) {
    const record = this.loras.find((lora) => lora.sha256 === sha256);
    if (!record) return;
    this.broadcastThumbnailChanged?.([sha256], record);
  },

  thumbnailSourceSha(selected) {
    if (this.isGenericModel?.(selected)) {
      return selected?.sha256 || "";
    }
    return selected?.thumbnailSha || selected?.sha256 || "";
  },


  async reviewStaleMetadata() {
    let response;
    try {
      response = await fetchLora("/missing");
    } catch {
      krcAlert("Could not check stale metadata (network error).", this.node);
      return;
    }
    if (!response.ok) {
      krcAlert(`Could not check stale metadata (HTTP ${response.status}).`, this.node);
      return;
    }

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    this.openCleanMetadataModal(Array.isArray(payload.items) ? payload.items : []);
  },

  openCleanMetadataModal(items) {
    const body = [];
    const count = items.length;
    const summary = el("div", "krc-modal-option");
    summary.append(
      el("div", "krc-modal-option-label", { textContent: count ? `${count} stale metadata record${count === 1 ? "" : "s"} found` : "No stale metadata found" }),
      el("div", "krc-modal-option-desc", {
        textContent: count
          ? "These saved metadata, thumbnail, and identity records no longer match a file in the current library scan. Presets are not edited."
          : "All saved metadata currently maps to files in the library.",
      }),
    );
    body.push(summary);

    if (count) {
      const list = el("div", "krc-modal-list krc-clean-metadata-list");
      items.forEach((item) => {
        const row = el("div", "krc-modal-row krc-clean-metadata-row");
        const name = el("span", "krc-clean-metadata-name", { textContent: item.name || "(unknown file)" });
        const path = el("span", "krc-clean-metadata-path", { textContent: item.path || item.file || item.id || "" });
        path.title = path.textContent;
        row.append(name, path);
        list.append(row);
      });
      body.push(list);
    }

    const cancel = el("button", "krc-modal-btn", { type: "button", textContent: "Cancel" });
    const proceed = el("button", "krc-modal-btn krc-modal-btn-danger", {
      type: "button",
      textContent: "Proceed",
      title: "Delete these stale metadata, thumbnail, and identity records",
    });
    proceed.disabled = !count;
    const footer = el("div", "krc-modal-foot");
    footer.append(cancel, proceed);

    const modal = openKrcModal({
      node: this.node,
      title: "Clean stale records",
      body,
      footer,
      width: 640,
    });
    cancel.addEventListener("click", () => modal.close());
    armConfirmButton(proceed, {
      armedText: "Confirm clean",
      armedTitle: "Click again to permanently remove these stale records",
      restoreText: "Proceed",
      restoreTitle: proceed.title,
      onConfirm: async () => {
        proceed.disabled = true;
        const cleaned = await this.cleanStaleMetadata(items.map((item) => item.id).filter(Boolean), modal.close);
        if (!cleaned) {
          proceed.disabled = false;
        }
      },
    });
  },

  async cleanStaleMetadata(ids, close) {
    if (!ids.length) {
      return false;
    }
    let response;
    try {
      response = await deleteLoraJson("/missing", { ids });
    } catch {
      krcAlert("Could not clean stale metadata (network error).", this.node);
      return false;
    }
    if (!response.ok) {
      krcAlert(`Could not clean stale metadata (HTTP ${response.status}).`, this.node);
      return false;
    }
    close?.();
    this.missingSelection = "";
    this.missingInfo = null;
    await this.loadLibrary({ focusSelection: true });
    this.refreshStacks();
    this.refreshInfo();
    return true;
  },

  async saveSelected(selected) {
    this._browserSelectionUI?.endForEdit();
    if (!selected?.sha256) {
      return;
    }

    this.flushMetadataDraftCapture?.();
    if (this.isGenericModel?.(selected)) {
      try {
        await this.writeModelMetadata(selected);
      } catch (err) {
        krcAlert(`Could not save metadata (${err?.message || "network error"}).`, this.node);
        return;
      }
      const affected = this.commitSavedMetadata(selected);
      affected.forEach((sha256) => this.refreshLoraCard(sha256));
      this.updateModifiedIndicators();
      return;
    }
    await this.ensureLoraDetail?.(selected);
    const response = await postLoraJson("/metadata", {
      sha256: selected.sha256,
      stabilizeIdentity: true,
      name: selected.display_name || "",
      baseModel: selected.baseModel || "",
      category: selected.category || "",
      cardColor: selected.cardColor || "",
      favorite: Boolean(selected.favorite),
      description: selected.description || "",
      version: selected.version || "",
      creator: { username: selected.creator?.username || "" },
      usage: { license: selected.usage?.license || "" },
      nsfwLevel: Number(selected.nsfwLevel) || 0,
      trainedWords: (selected.trainedWords || []).map((word) => ({ word })),
      examplePrompts: (selected.examplePrompts || []).map((text) => ({ text, source: "user" })),
      tags: selected.tags || [],
      notes: selected.notes || "",
    });
    if (!response.ok) {
      krcAlert(`Could not save metadata (HTTP ${response.status}).`, this.node);
      return;
    }
    // The save persists name = display_name, so the server now reports
    // hasName = bool(name). hasName is otherwise only set from a library fetch,
    // so mirror it here or the browser card (title mode) keeps showing the
    // filename until the next refresh.
    selected.hasName = !!selected.display_name;
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (payload?.identity?.oldId && payload?.identity?.newId) {
      this.applyIdentityChange(payload.identity);
      this.broadcastIdentityChanged?.(payload.identity);
      const promoted = this.loras.find((lora) => lora.sha256 === payload.identity.newId);
      this.commitSavedMetadata(promoted || selected);
      // Targeted completion: applyIdentityChange already patched this.loras and busted
      // the card cache, so re-window the list in place (new id, scroll preserved) rather
      // than rebuilding the whole browser chrome. Stack chips + info inputs rebind below.
      this.refreshBrowserResults();
      this.refreshStacks();
      this.refreshInfo();
      return;
    }
    const affected = this.commitSavedMetadata(selected);
    affected.forEach((sha256) => this.refreshLoraCard(sha256));
    // Only rebuild the stacks if an edited LoRA is actually in one (its name/
    // favorite/color show in the slots); most library edits aren't stacked.
    const affectsStack = affected.some((sha256) => (
      ["A", "B"].some((stackId) => this.stacks?.[stackId]?.some((entry) => entry.sha256 === sha256))
    ));
    if (affectsStack) {
      this.refreshStacks();
    }
    // The edited values are already live in `selected`, so the only thing the
    // save changes in the info panel is the modified badge. Update that in
    // place instead of rebuilding the whole panel (thumbnail, fields, chips),
    // which made every save feel sluggish.
    this.updateModifiedIndicators();
  },

  // Auto-stabilize on selection dwell: promote a path-derived (local-...) id to a
  // content SHA256. A LoRA always auto-stabilizes on dwell, in either node. Generic
  // models stay behind the global auto-stabilize setting (full model files can be very
  // large). Triggered on dwell, not raw select, so cycling doesn't hash every file.
  scheduleStabilize(sha256) {
    clearTimeout(this._stabilizeTimer);
    if (!sha256 || !String(sha256).startsWith("local-")) {
      return;   // already content-addressed → nothing to do
    }
    const item = this.loras.find((model) => model.sha256 === sha256);
    if (!item) {
      return;
    }
    if (this.isGenericModel?.(item) && !this.globalAutoStabilizeModels?.()) {
      return;   // big generic models are gated by the global setting; LoRAs are never gated
    }
    this._stabilizeTimer = setTimeout(() => this.stabilizeSelected(sha256), 650);
  },

  // Saved edits always earn a durable ID, independent of selection/dwell settings.
  // The server owns accepted work, so closing this panel cannot drop queued IDs.
  // Keep modal edits on their live record until close, then submit every saved ID.
  autoStabilizeAfterPersist(sha256) {
    if (!autoStabilizeOnPersist || !sha256 || !String(sha256).startsWith("local-")) return;
    if (this._moreInfoModalOpen) {
      (this._pendingAutoStabilizeIds ||= new Set()).add(sha256);
      return;
    }
    void this.stabilizeSelected(sha256, { auto: true });
  },

  flushPendingAutoStabilize() {
    const ids = [...(this._pendingAutoStabilizeIds || [])];
    this._pendingAutoStabilizeIds?.clear();
    for (const id of ids) this.autoStabilizeAfterPersist(id);
  },

  async stabilizeSelected(sha256, { manual = false, auto = false } = {}) {
    if (auto) {
      if (!sha256 || !String(sha256).startsWith("local-")) return;
      try {
        const response = await fetchLora(`/stabilize/${encodeURIComponent(sha256)}?background=1`, { method: "POST" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
      } catch (error) {
        console.warn(`[KRC Stabilize] Could not queue ${sha256}: ${error?.message || "network error"}`);
      }
      return;
    }
    const lora = this.loras.find((item) => item.sha256 === sha256);
    // Skip if the selection moved on, it's no longer local, an edit is in
    // progress, or the More Info modal is open (stabilizing would rebuild the
    // panel / orphan the modal's selection). LoRAs are eligible here too — the
    // backend route delegates a LoRA id's hash to LoRA Loadout.
    if (this.selectedSha !== sha256 || this.draggedSha || !lora || !String(lora.sha256).startsWith("local-")) {
      return;
    }
    if (!manual && !auto && (this._moreInfoModalOpen || this.isMetadataModified(lora))) {
      return;
    }
    if (this._stabilizing) {
      if (!manual) {
        this.scheduleStabilize(sha256);   // another stabilize is running; retry after a dwell
      }
      return;
    }
    this._stabilizing = sha256;
    applyStabilizeGlow(this.root?.querySelector(".krc-sha"), true);
    this.refreshLoraCard(sha256);   // repaint the one card so its ambient stabilizing dot shows
    try {
      const response = await fetchLora(`/stabilize/${encodeURIComponent(sha256)}`, { method: "POST" });
      if (!response.ok) {
        if (manual) {
          krcAlert(`Could not stabilize model ID (HTTP ${response.status}).`, this.node);
        }
        return;
      }
      const payload = await response.json();
      if (payload?.identity?.oldId && payload?.identity?.newId) {
        this.applyIdentityChange(payload.identity);
        this.broadcastIdentityChanged?.(payload.identity);
        // Cards captured the old id in their handlers; applyIdentityChange patched
        // this.loras and busted the card cache, so re-window the list in place (new id,
        // scroll preserved — no chrome rebuild, no jump) and rebind the panel inputs.
        this.refreshBrowserResults();
        this.refreshStacks();
        this.refreshInfoIfSelected(payload.identity.newId);
      }
    } catch (err) {
      // Best-effort background upgrade — ignore transient failures.
      if (manual) {
        krcAlert(`Could not stabilize model ID (${err?.message || "network error"}).`, this.node);
      }
    } finally {
      this._stabilizing = null;
      applyStabilizeGlow(this.root?.querySelector(".krc-sha"), false);
      // Clear the ambient dot. On success the promoted card already re-rendered under
      // its new id (this old-id lookup no-ops); on failure this repaints it dot-free.
      this.refreshLoraCard(sha256);
    }
  }
  };
}
