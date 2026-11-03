import { canonicalModelId } from "./model_identity.js";
/*
 * KRC shared InfoPanel metadata-state engine (Layer 3 / L3-2). The dirty-state
 * machinery behind the LoRA Loadout + Model Library info panels — unsaved-edit
 * draft capture/debounce, baseline snapshots, modified detection + badge — was
 * byte-identical across both nodes. These methods use only shared imports + `this`,
 * so they mix in unchanged via Object.assign(proto, metadataStateMethods, ...):
 * hasDeferredLoraDetail, resetMetadataEditState, toggleFavorite, toggleNsfw, togglePin,
 * persistSharedMetadataFlag (MAX_PINNED and markDirty are shared re-exports). The
 * schema/kind-specific methods (normalizedMetadata, commitSavedMetadata,
 * writeMetadataFlag, applySharedFlag, discardMetadataDraft, refreshMetadataSurfaces)
 * stay per-node as the seams these call through `this`; the route/widget-dependent
 * shared methods (fetchLora / postLoraJson / setWidgetValue / widgetValue consumers)
 * are handled separately (L3-2b).
 */
import { modifiedBadge } from "./badges.js";
import { localStatusCopy, LOCAL_STATUS } from "./local_status.js";
import { normalizeCardColorId } from "./card_colors.js";
import { debounce, queryDataAttrAny } from "./dom.js";
import { showToast } from "./toast.js";
import { civitaiFetchMessage } from "./civitai_fetch_message.js";
import { optimisticBooleanFlag } from "./flags.js";
import { markDirty } from "./widgets.js";
import { MAX_PINNED } from "./pinning.js";
import { notifyNetworkDisabled } from "./network_consent.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES, isOwnSyncEvent, publishKrcSync, subscribeKrcSync } from "./sync_bus.js";
import { loadCollections } from "./collections_client.js";
import { installLibraryHealBridge } from "./library_heal_client.js";
import { METADATA_INSTANT_FIELDS, isInstantOnlyFields, hasDeferredDetail, clearedDeferredDetailFlags } from "./metadata_fields.js";
import { krcAlert } from "./modal.js";

const METADATA_QUICK_FIELDS = new Set(["cardColor", "customBadge", "favorite", "pinned", "nsfw", "display_name", "hasName"]);

// Both model browsers retain the same editor/draft identity through a promotion.
export function remapMetadataIdentity(panel, oldId, newId) {
  for (const key of ["metadataSnapshots", "metadataBaselines"]) {
    const map = panel[key];
    if (map?.has(oldId)) {
      if (!map.has(newId)) map.set(newId, map.get(oldId));
      map.delete(oldId);
    }
  }
  const draft = panel.readMetadataDraft?.();
  if (draft && oldId in draft) {
    draft[newId] = draft[oldId];
    delete draft[oldId];
    panel.writeMetadataDraft?.(draft, { dirty: false });
  }
  panel.loras = panel.loras.map(record => {
    // Modal input handlers retain these objects, including unrelated cards.
    if (record?.sha256 === oldId) {
      record.sha256 = newId;
      record.actualSha256 = newId;
      if (!record.thumbnailSha || record.thumbnailSha === oldId) record.thumbnailSha = newId;
    }
    return record;
  });
}

function cloneMetadataValue(value) {
  if (Array.isArray(value)) return [...value];
  if (value && typeof value === "object") return { ...value };
  return value;
}

// Merge saved fields independently of a local editor draft. Record refetches and
// direct patches use the same conflict rule; thumbnails/instant flags stay live.
function mergeSavedMetadata(panel, target, metadata, { complete = false } = {}) {
  const modified = panel.isMetadataModified(target);
  const draft = panel.readMetadataDraft()[target.sha256];
  const dirty = modified || !!draft;
  const baseline = dirty && panel.metadataBaselines?.get(target.sha256);
  if (dirty && !baseline && !complete) return false;
  const local = dirty ? panel.normalizedMetadata(modified ? target : draft) : {};
  const edited = new Set(Object.keys(local).filter(key => !baseline || JSON.stringify(local[key]) !== JSON.stringify(baseline[key])));
  if (edited.has("display_name")) edited.add("hasName");
  if (draft && !modified) Object.assign(target, local);
  for (const [key, value] of Object.entries(metadata)) {
    if (!edited.has(key)) target[key] = cloneMetadataValue(value);
  }
  if (dirty) {
    const saved = panel.normalizedMetadata({ ...baseline, ...metadata });
    panel.metadataSnapshots.set(target.sha256, panel.metadataSnapshotValue(saved));
    (panel.metadataBaselines ||= new Map()).set(target.sha256, saved);
    panel.captureMetadataDraft(target.sha256, { dirty: false });
  } else {
    panel.metadataSnapshots.set(target.sha256, panel.metadataSnapshotValue(target));
    panel.metadataBaselines?.delete(target.sha256);
  }
  return true;
}

// The record fields that describe its thumbnail (what LoRA Loadout / Model Library set
// after an upload or removal), normalized for a thumbnail broadcast.
export function thumbnailState(record = {}) {
  return {
    thumbnail: record?.thumbnail || "",
    thumbnailRemoved: !!record?.thumbnailRemoved,
    thumbnailSha: String(record?.thumbnailSha || ""),
    thumbnailType: String(record?.thumbnailType || "image"),
    thumbnailHasPoster: !!record?.thumbnailHasPoster,
    thumbnailHasAnimation: !!record?.thumbnailHasAnimation,
    thumbnailVersion: Number(record?.thumbnailVersion) || 0,
  };
}

// A LIBRARY_CHANGED with `lineages` concerns only the surfaces that show one of them; an
// untagged one (an older or outside publisher) still reaches every surface.
export function libraryChangeConcerns(event, shown = []) {
  const lineages = event?.detail?.lineages;
  if (!Array.isArray(lineages) || !lineages.length) return true;
  return lineages.some((lineage) => shown.includes(lineage));
}

export const metadataStateMethods = {
  readMetadataDraft() {
    const raw = this.node?.properties?.loraMetadataDraft;
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  },

  captureMetadataDraft(sha256 = this.selectedSha, { dirty = true } = {}) {
    const lora = this.loras.find((item) => item.sha256 === sha256);
    if (!lora?.sha256) return;
    const draft = this.readMetadataDraft();
    if (this.isMetadataModified(lora)) {
      // Never persist a draft while the LoRA's detail is still deferred: the heavy
      // fields (description/examplePrompts) aren't loaded, so a capture here records
      // them as empty and manufactures a phantom "modified" that outlives the
      // session — the draft re-applies on every load and blocks every re-baseline
      // path. A real edit only happens with detail loaded, so nothing legitimate is
      // lost. (Drops below still run so a settled edit can always be cleared.)
      if (this.hasDeferredLoraDetail(lora)) {
        return;
      }
      draft[lora.sha256] = this.normalizedMetadata(lora);
    } else if (lora.sha256 in draft) {
      delete draft[lora.sha256];
    } else {
      return;
    }
    this.writeMetadataDraft(draft, { dirty });
  },

  scheduleMetadataDraftCapture(sha256 = this.selectedSha) {
    this.metadataDraftCaptureDebounce()(sha256);
  },

  flushMetadataDraftCapture() {
    this._metadataDraftCaptureDebounce?.flush?.();
  },

  cancelMetadataDraftCapture() {
    this._metadataDraftCaptureDebounce?.cancel?.();
  },

  // Re-apply persisted unsaved edits onto the freshly loaded library. MUST run
  // after captureMetadataSnapshots so the snapshot baseline stays the server's
  // saved values and the re-applied edits register as "Modified" again.

  applyMetadataDraft() {
    const draft = this.readMetadataDraft();
    const shas = Object.keys(draft);
    if (!shas.length) return false;
    let changed = false;
    for (const sha of shas) {
      const lora = this.loras.find((item) => item.sha256 === sha);
      if (!lora) continue;
      this.metadataBaselines ||= new Map();
      if (!this.metadataBaselines.has(sha)) {
        this.metadataBaselines.set(sha, this.normalizedMetadata(lora));
      }
      Object.assign(lora, this.normalizedMetadata(draft[sha]));
      changed = true;
    }
    return changed;
  },

  metadataSnapshotValue(record = {}) {
    const text = JSON.stringify(this.normalizedMetadata(record));
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return `${text.length}:${(hash >>> 0).toString(36)}`;
  },

  ensureMetadataBaseline(lora) {
    if (!lora?.sha256) {
      return;
    }
    this.metadataBaselines ||= new Map();
    if (this.hasDeferredLoraDetail(lora)) {
      return;   // wait for full detail before trusting any baseline for this LoRA
    }
    // Self-heal a stale dirty snapshot. A LoRA with no persisted draft has no
    // unsaved edits, so if it still reads "modified" the snapshot baseline is stale
    // (captured at the deferred list state, or inherited from the shared cache after
    // detail loaded) — re-baseline it to current so the badge clears instead of
    // sticking with no revert target. Runs on select/load, never mid-keystroke.
    if (this.readMetadataDraft()[lora.sha256] === undefined && this.isMetadataModified(lora)) {
      this.metadataSnapshots.set(lora.sha256, this.metadataSnapshotValue(lora));
      this.updateCachedMetadataSnapshots?.();
    }
    if (!this.metadataBaselines.has(lora.sha256) && !this.isMetadataModified(lora)) {
      this.metadataBaselines.set(lora.sha256, this.normalizedMetadata(lora));
    }
  },

  captureMetadataSnapshots() {
    this.metadataSnapshots = new Map();
    this.loras.forEach((lora) => {
      if (lora?.sha256) {
        this.metadataSnapshots.set(lora.sha256, this.metadataSnapshotValue(lora));
      }
    });
  },

  isMetadataModified(lora) {
    if (!lora?.sha256) {
      return false;
    }
    const saved = this.metadataSnapshots.get(lora.sha256);
    if (!saved) {
      return false;
    }
    return this.metadataSnapshotValue(lora) !== saved;
  },

  metadataSyncSource() {
    this._metadataSyncSource ||= `metadata-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    return String(this.node?.id || this._metadataSyncSource);
  },

  metadataSyncTargets(detail = {}) {
    const affected = Array.isArray(detail.affected) && detail.affected.length ? detail.affected : [detail.sha256];
    const ids = new Set(affected.filter(Boolean).map(id => canonicalModelId(id, this.aliases)));
    return this.loras.filter(item => item?.sha256 && ids.has(canonicalModelId(item.sha256, this.aliases)));
  },

  broadcastMetadataChanged(selected, { affected = null, fields = null } = {}) {
    if (!selected?.sha256) {
      return;
    }
    // normalizedMetadata projects the snapshot (text) fields only; the instant
    // affordance fields live outside it. Include their current values explicitly, or a
    // receiver that does NOT share this node's library objects (LL and Model Library
    // keep separate libraryCache singletons) would repaint its card with a stale value.
    const saved = this.normalizedMetadata(selected);
    saved.hasName = !!selected.hasName;
    for (const key of METADATA_INSTANT_FIELDS) saved[key] = cloneMetadataValue(selected[key]);
    // A quick save must not export unrelated text that is still being edited.
    const metadata = Array.isArray(fields) && fields.length
      ? Object.fromEntries(fields.filter(key => key in saved).map(key => [key, saved[key]]))
      : saved;
    publishKrcSync(KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, {
      source: this.metadataSyncSource(),
      lane: KRC_SYNC_LANES.METADATA,
      sha256: selected.sha256,
      modelType: selected.modelType || "",
      affected: affected || [selected.sha256],
      fields: Array.isArray(fields) ? fields : [],
      metadata,
    });
  },

  // A thumbnail changed on disk (upload, video upload, removal, refresh from source, a
  // Civitai preview): every other LoRA Loadout / Model Library / Portal copy and each
  // Config Switcher card showing these records picks up the new state live
  // (CS_LIVE_CARDS_GAMEPLAN.md step 2). `state` is the record's thumbnail fields.
  broadcastThumbnailChanged(affected, state = {}) {
    const ids = (Array.isArray(affected) ? affected : [affected]).map((id) => String(id || "")).filter(Boolean);
    if (!ids.length) {
      return;
    }
    publishKrcSync(KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, {
      source: this.metadataSyncSource(),
      lane: KRC_SYNC_LANES.METADATA,
      sha256: ids[0],
      affected: ids,
      fields: ["thumbnail"],
      thumbnail: thumbnailState(state),
      version: Number(state?.thumbnailVersion) || Date.now(),
    });
  },

  // One record changed on the server (a thumbnail refresh, a Civitai / HuggingFace merge, a
  // metadata reset). Receivers that hold it refetch just that record from their own route
  // (refreshLibraryRecord), instead of every surface reloading its whole library.
  broadcastRecordChanged(record) {
    if (!record?.sha256) return;
    publishKrcSync(KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, {
      source: this.metadataSyncSource(),
      lane: KRC_SYNC_LANES.METADATA,
      sha256: record.sha256,
      modelType: record.modelType || "",
      affected: [record.sha256],
      fields: ["record"],
      record: true,
    });
  },

  applySyncedRecord(detail = {}) {
    const targets = this.metadataSyncTargets(detail);
    if (!targets.length) return false;
    for (const sha of new Set(targets.map(target => target.sha256))) {
      this.refreshLibraryRecord?.(sha, { broadcast: false });
    }
    return true;
  },

  // Take the server's fresh copy of one record into the list, in the order a full reload
  // would: server values, the saved snapshot from them, then this node's unsaved draft on
  // top. Then repaint just that record.
  adoptLibraryRecord(target, record) {
    const sha = target.sha256;
    mergeSavedMetadata(this, target, { ...record, descriptionLoaded: true, ...clearedDeferredDetailFlags() }, { complete: true });
    this.updateCachedMetadataSnapshots?.();
    this.invalidateVisibleLoras?.();
    this.refreshLoraCard?.(sha);
    this.refreshStacks?.();
    if (sha === this.selectedSha) this.refreshInfo?.();
  },

  // Field-scoped, gate-free sync for the instant affordance fields
  // (METADATA_INSTANT_SYNC_GAMEPLAN.md step 2). Applies to EVERY matching record —
  // Modified or not — with no snapshot/baseline work, because:
  //   1. the instant fields are NOT in the metadata snapshot projection
  //      (LORA_SNAPSHOT_FIELDS), so they cannot affect isMetadataModified either way —
  //      there is no Modified state to preserve; and
  //   2. mounted panels share the same libraryCache.loras objects, so the sender has
  //      already mutated the shared record — the value is usually applied before this
  //      runs. We set it anyway (for any independently-loaded panel) but NEVER gate the
  //      repaint on a value delta, or a shared-object sibling would skip its repaint.
  // So this is purely a repaint fan-out; the whole-record "adopt only if clean" path
  // (applySyncedMetadata) is reserved for text fields, which the snapshot DOES track.
  // Receiver of broadcastThumbnailChanged: adopt the thumbnail fields (thumbnailVersion
  // included, so the new image URL busts the browser's copy) and repaint. Thumbnails
  // aren't part of the metadata snapshot, so no Modified state is involved.
  applySyncedThumbnail(detail = {}) {
    const targets = this.metadataSyncTargets(detail);
    if (!targets.length) {
      return false;
    }
    const state = thumbnailState(detail.thumbnail);
    for (const target of targets) {
      if (target?.sha256) Object.assign(target, state);
    }
    this.invalidateVisibleLoras?.();
    targets.forEach((item) => item?.sha256 && this.refreshLoraCard?.(item.sha256));
    this.refreshStacks?.();
    if (targets.some((item) => item?.sha256 === this.selectedSha)) this.refreshInfo?.();
    return true;
  },

  applySyncedInstantFields(detail = {}) {
    const metadata = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
    const fields = (Array.isArray(detail.fields) ? detail.fields : [])
      .filter((key) => METADATA_INSTANT_FIELDS.has(key));
    if (!fields.length) {
      return false;
    }
    const targets = this.metadataSyncTargets(detail);
    if (!targets.length) {
      return false;
    }
    for (const target of targets) {
      if (!target?.sha256) continue;
      for (const key of fields) {
        if (key in metadata) target[key] = cloneMetadataValue(metadata[key]);
      }
    }
    this.invalidateVisibleLoras?.();
    targets.forEach((item) => item?.sha256 && this.refreshLoraCard?.(item.sha256));
    if (fields.includes("pinned") || (fields.includes("favorite") && this.showFavorites)) {
      this.refreshBrowser({ focusSelection: true });
    } else if (fields.includes("nsfw") && this.shouldHideNsfw?.()) {
      this.refreshBrowser({ focusSelection: true });
    } else if (fields.includes("cardColor") && this.colorFilter) {
      this.refreshBrowser({ focusSelection: true });
    }
    this.refreshStacks?.();
    if (targets.some((item) => item?.sha256 === this.selectedSha)) {
      this.refreshInfoActions?.();
      if (fields.includes("nsfw")) this.refreshInfoThumb?.();
    }
    return true;
  },

  applySyncedMetadata(detail = {}) {
    const metadata = detail.metadata;
    if (!metadata || typeof metadata !== "object") {
      return false;
    }
    const fields = Array.isArray(detail.fields) ? detail.fields : [];
    const targets = this.metadataSyncTargets(detail);
    if (!targets.length) {
      return false;
    }
    let changed = false;
    const touched = [];
    for (const target of targets) {
      if (!target?.sha256) {
        continue;
      }
      if (!mergeSavedMetadata(this, target, metadata)) continue;
      touched.push(target);
      changed = true;
    }
    if (!changed) {
      return false;
    }
    this.updateCachedMetadataSnapshots?.();
    this.invalidateVisibleLoras?.();
    touched.forEach((item) => this.refreshLoraCard?.(item.sha256));
    const selectedTouched = touched.some((item) => item.sha256 === this.selectedSha);
    const quickOnly = fields.length > 0 && fields.every((key) => METADATA_QUICK_FIELDS.has(key));
    if (fields.includes("pinned") || (fields.includes("favorite") && this.showFavorites)) {
      this.refreshBrowser({ focusSelection: true });
    } else if (fields.includes("nsfw") && this.shouldHideNsfw?.()) {
      this.refreshBrowser({ focusSelection: true });
    } else if (fields.includes("cardColor") && this.colorFilter) {
      this.refreshBrowser({ focusSelection: true });
    }
    this.refreshStacks?.();
    if (selectedTouched) {
      if (quickOnly) {
        this.refreshInfoActions?.();
        if (fields.includes("nsfw")) this.refreshInfoThumb?.();
      } else {
        this.refreshInfo?.();
      }
      this.updateModifiedIndicators?.();
    }
    return true;
  },

  // Structural reconverge: announce that this node just re-scanned disk, so sibling
  // library surfaces (the other node type, other instances, an open portal) pick up a
  // newly added/removed item instead of drifting. Only a forced, user-initiated reload
  // broadcasts — a sync-triggered reload passes fromSync to stay silent (no ping-pong).
  // `lineages` names the libraries the reload covered, so a surface that shows none of
  // them stays put (a Model Library checkpoint rescan doesn't reload LoRA Loadout).
  broadcastLibraryChanged() {
    publishKrcSync(KRC_SYNC_EVENTS.LIBRARY_CHANGED, {
      source: this.metadataSyncSource(),
      lane: KRC_SYNC_LANES.STRUCTURE,
      lineages: this.healLineages?.() || [],
    });
  },

  // Announce an id promotion (local- → content sha) so sibling surfaces remap the
  // stale id in place instead of drifting until a rescan/restart. Called only from the
  // node's OWN stabilize sites (never the receiver below), so there is no re-broadcast.
  broadcastIdentityChanged(identity = {}) {
    const oldId = identity?.oldId || "";
    const newId = identity?.newId || "";
    if (!oldId || !newId || oldId === newId) {
      return;
    }
    publishKrcSync(KRC_SYNC_EVENTS.IDENTITY_CHANGED, {
      source: this.metadataSyncSource(),
      lane: KRC_SYNC_LANES.STRUCTURE,
      identity: { oldId, newId },
    });
  },

  // True if this surface references a library id anywhere (selection, pins, the visible
  // library, or either stack) — the gate for adopting a synced identity promotion, so an
  // unrelated node doesn't churn widgets/persist for an id it never held.
  referencesLibraryId(id) {
    if (!id) return false;
    if (this.selectedSha === id) return true;
    if (Array.isArray(this.loras) && this.loras.some((lora) => lora?.sha256 === id)) return true;
    const stacks = this.stacks || {};
    return Object.values(stacks).some(
      (entries) => Array.isArray(entries) && entries.some((entry) => entry?.sha256 === id),
    );
  },

  installMetadataSyncListener() {
    if (!this.unsubscribeLibrarySync) {
      this.unsubscribeLibrarySync = subscribeKrcSync(KRC_SYNC_EVENTS.LIBRARY_CHANGED, (event) => {
        if (isOwnSyncEvent(event, this.metadataSyncSource())) return;
        if (!libraryChangeConcerns(event, this.healLineages?.() || [])) return;
        // A sibling re-scanned disk — reconverge our own list. No force: the sibling's
        // forced request (or the server route that changed the store) already left the
        // server's scan fresh, so another disk walk per node would find nothing new.
        // fromSync:true suppresses the re-broadcast.
        this.loadLibrary?.({ fromSync: true, focusSelection: true, restoreScroll: true });
      });
    }
    if (!this.unsubscribeHealSync) {
      installLibraryHealBridge();
      this.unsubscribeHealSync = subscribeKrcSync(KRC_SYNC_EVENTS.LIBRARY_HEALED, (event) => {
        const heal = event?.detail?.heal || {};
        // The server rescanned after files moved outside KRC. Reload only for a library
        // this surface shows, and not when it already holds that scan (its own request
        // did the rescan). No force: the server's scan is already fresh.
        if (!this.healLineages?.().includes(heal.lineage)) return;
        if (heal.scanId && this.libraryScanIds?.[heal.lineage] === heal.scanId) return;
        this.loadLibrary?.({ fromSync: true, restoreScroll: true });
      });
    }
    if (!this.unsubscribeIdentitySync) {
      this.unsubscribeIdentitySync = subscribeKrcSync(KRC_SYNC_EVENTS.IDENTITY_CHANGED, (event) => {
        if (isOwnSyncEvent(event, this.metadataSyncSource())) return;
        const identity = event?.detail?.identity || {};
        const oldId = identity.oldId || "";
        // Only remap if this surface actually holds the stale id — otherwise skip so we
        // don't persist/churn for an unrelated item. applyIdentityChange does the rest
        // (loras/stacks/pins/snapshots/alias); mirror the local-stabilize refresh below.
        if (!oldId || !this.referencesLibraryId?.(oldId)) {
          return;
        }
        const selectedChanged = this.selectedSha === oldId;
        this.flushMetadataDraftCapture?.();
        if (this.applyIdentityChange?.(identity, { rememberAlias: true })) {
          this.refreshBrowserResults?.();
          this.refreshStacks?.();
          // A queued background model must not rebuild the editor of another card.
          // Modal handlers keep their live record; reconcile its panel on close.
          if (selectedChanged && !this._moreInfoModalOpen) this.refreshInfo?.();
        }
      });
    }
    if (!this.unsubscribeCollectionsSync) {
      this.unsubscribeCollectionsSync = subscribeKrcSync(KRC_SYNC_EVENTS.COLLECTIONS_CHANGED, (event) => {
        if (isOwnSyncEvent(event, this.metadataSyncSource())) return;
        // A sibling changed the shared Collections store — refresh the in-page cache, repaint
        // this panel's + COLLECTION control, and (if the collection viewer is open) rebuild it.
        loadCollections({ force: true }).then(() => {
          this.refreshCollectionControl?.();
          this.refreshCollectionsView?.();
        });
      });
      // Prime the collections cache once so the + COLLECTION button reflects membership on the
      // first InfoPanel paint, not only after the menu is opened.
      loadCollections().then(() => this.refreshCollectionControl?.());
    }
    if (this.unsubscribeMetadataSync) {
      return;
    }
    this.unsubscribeMetadataSync = subscribeKrcSync(KRC_SYNC_EVENTS.LORA_METADATA_CHANGED, (event) => {
      if (isOwnSyncEvent(event, this.metadataSyncSource())) return;
      const detail = event?.detail || {};
      if (detail.record) {
        this.applySyncedRecord(detail);
        return;
      }
      if (detail.thumbnail) {
        this.applySyncedThumbnail(detail);
        return;
      }
      // Instant-only payload (every tagged field is an affordance): field-scoped,
      // gate-free apply to all matching records. Anything with a text field, or an
      // untagged whole-record commit (e.g. a Civitai reload), stays on the gated adopt.
      if (isInstantOnlyFields(detail.fields)) {
        this.applySyncedInstantFields(detail);
        return;
      }
      this.applySyncedMetadata(detail);
    });
  },

  uninstallMetadataSyncListener() {
    this.unsubscribeMetadataSync?.();
    this.unsubscribeMetadataSync = null;
    this.unsubscribeLibrarySync?.();
    this.unsubscribeLibrarySync = null;
    this.unsubscribeHealSync?.();
    this.unsubscribeHealSync = null;
    this.unsubscribeIdentitySync?.();
    this.unsubscribeIdentitySync = null;
    this.unsubscribeCollectionsSync?.();
    this.unsubscribeCollectionsSync = null;
  },

  renderModifiedBadge({ discardable = false, onDiscard = null } = {}) {
    // Metadata-specific copy profile (LOCAL_STATUS_AND_DRAFT_GAMEPLAN.md §7): the
    // discardable info-panel badge names the object and the action in its tooltip.
    // Metadata live-sync now adopts clean sibling panels immediately; panels with
    // local unsaved edits stay Modified instead of being overwritten.
    return modifiedBadge({
      discardable,
      title: discardable ? localStatusCopy(LOCAL_STATUS.MODIFIED, "metadata").badge.title : "",
      onDiscard: onDiscard || (() => this.discardMetadataDraft()),
    });
  },

  updateModifiedIndicators() {
    const selected = this.loras.find((lora) => lora.sha256 === this.selectedSha) || null;
    const modified = this.isMetadataModified(selected);
    const slot = this.querySurface(".krc-info-modified-slot");
    if (slot) {
      slot.innerHTML = "";
      if (modified) {
        slot.append(this.renderModifiedBadge({ discardable: true }));
      }
    }

    const card = queryDataAttrAny([this.pickerPortal, this.root], ".krc-lora-card", "data-lora-sha", selected?.sha256);
    if (!card) {
      return;
    }
    let badges = card.querySelector(".krc-badge-row");
    if (!badges) {
      badges = document.createElement("div");
      badges.className = "krc-badge-row krc-browser-badges";
    }
    badges.querySelector(".krc-modified-badge")?.remove();
    if (modified) {
      badges.append(this.renderModifiedBadge());
    }
    if (badges.childElementCount && !badges.parentElement) {
      card.querySelector(".krc-card-meta")?.prepend(badges);
    } else if (!badges.childElementCount && badges.parentElement) {
      badges.remove();
    }
  },

  effectiveLoraCardColor(lora) {
    return normalizeCardColorId(lora?.cardColor || "");
  },

  hasDeferredLoraDetail(lora) {
    return hasDeferredDetail(lora);
  },

  // Escape hatch (buried in the Options modal): wipe every persisted unsaved edit
  // on this node and rebuild the dirty baselines from the server, clearing any LoRA
  // stuck showing a phantom "modified" badge. Discards genuine unsaved edits too —
  // that's the point of a reset — so it's confirm-guarded at the call site.
  async resetMetadataEditState() {
    this.cancelMetadataDraftCapture?.();
    this.writeMetadataDraft({}, { dirty: true });   // drop all persisted drafts
    this.metadataBaselines?.clear?.();
    // A fresh library load recaptures snapshots from current server values with no
    // drafts to re-apply, so nothing reads as modified. The server data didn't change,
    // so no disk rescan and nothing to announce.
    await this.loadLibrary({ restoreScroll: true, focusSelection: true });
    showToast("Cleared unsaved LoRA edits");
  },

  async toggleFavorite(selected) {
    if (!selected?.sha256) {
      return;
    }
    await this.persistSharedMetadataFlag(selected, "favorite", "Could not save favorite tag. Check the ComfyUI server log.");
  },

  async toggleNsfw(selected) {
    if (!selected?.sha256) {
      return;
    }
    await this.persistSharedMetadataFlag(selected, "nsfw", "Could not save NSFW tag. Check the ComfyUI server log.");
  },

  // Pins are a record field shared by every node (2026-10-29). The server holds the cap
  // over LoRAs and models together; this list only knows its own, so it pre-checks that.
  async togglePin(selected) {
    if (!selected?.sha256) {
      return;
    }
    if (!selected.pinned && this.loras.filter((item) => item.pinned).length >= MAX_PINNED) {
      showToast(`Only ${MAX_PINNED} models and LoRAs can be pinned — unpin one first`);
      return;
    }
    await this.persistSharedMetadataFlag(selected, "pinned", `Could not pin. At most ${MAX_PINNED} models and LoRAs can be pinned; otherwise check the ComfyUI server log.`);
  },

  async persistSharedMetadataFlag(selected, key, errorMessage) {
    this._browserSelectionUI?.endForEdit();
    await optimisticBooleanFlag({
      current: selected?.[key],
      apply: (value) => {
        this.applySharedFlag(selected, key, value);
        this.refreshMetadataSurfaces(key);
      },
      persist: (value) => this.writeMetadataFlag(selected, key, value),
      onPersisted: (response) => {
        const ok = response?.ok;
        if (ok) {
          this.commitSavedMetadata?.(selected, { fields: [key] });
        }
        return ok;
      },
      onError: () => krcAlert(errorMessage, this.node),
    });
  },
};

// L3-2b — the route/widget-dependent twins of the methods above. Byte-identical
// across LoRA Loadout and Model Library, but they reach node-local bindings
// (fetchLora / postLoraJson for the record route, setWidgetValue / widgetValue for
// the node's HIDDEN_WIDGETS-bound accessors). Injected via a factory: each node
// calls makeMetadataApiMethods() with its own imports and spreads the result into
// infoPanelMetadataMethods. Bodies are verbatim — the destructured params read
// exactly like the old module imports.
export function makeMetadataApiMethods({ fetchLora, postLoraJson, getSharedJson, setWidgetValue, widgetValue }) {
  return {

  // After a one-record server change: refetch that record (shared with every other copy
  // of this node type asking at once), adopt it, and tell the other surfaces. A record
  // this list doesn't hold, or a failed read, falls back to the full reload.
  // `broadcast: false` is a receiver's refresh (no re-announce). -> the detailed record.
  async refreshLibraryRecord(sha256, { broadcast = true } = {}) {
    const target = this.loras.find((lora) => lora.sha256 === sha256);
    const { ok, data } = target
      ? await getSharedJson(`/detail/${encodeURIComponent(sha256)}`).catch(() => ({ ok: false, data: null }))
      : { ok: false, data: null };
    if (this._destroyed) return null;
    if (!ok || data?.sha256 !== sha256) {
      await this.loadLibrary({ restoreScroll: true, focusSelection: true, changed: broadcast, fromSync: !broadcast });
      const current = this.loras.find((lora) => lora.sha256 === sha256);
      return current ? this.ensureLoraDetail(current, { refresh: true }) : null;
    }
    // The list may have been replaced while the read was out: adopt into the current copy.
    const current = this.loras.find((lora) => lora.sha256 === sha256) || target;
    this.adoptLibraryRecord(current, data);
    if (broadcast) this.broadcastRecordChanged(current);
    return current;
  },

  // ── Unsaved metadata-edit draft ──────────────────────────────────────────
  // Info-panel edits (name/base model/category/description/trained words/
  // example prompts) mutate only the in-memory library object, so a browser
  // reload — which wipes JS memory and refetches the library — used to drop
  // them along with the "Modified" badge. Persist them into node.properties
  // (a serialized bag that survives reload, like the preset stacks' widgets)
  // keyed by sha256, and re-apply on load so the modified state comes back.
  writeMetadataDraft(draft, { dirty = true } = {}) {
    this.node.properties ||= {};
    this.node.properties.loraMetadataDraft = JSON.stringify(draft || {});
    if (dirty) {
      markDirty(this.node);
    }
  },

  // Store the selected lora's edits while they differ from the saved snapshot;
  // drop the entry once it matches again (saved or discarded). Runs after every
  // edit and after save/discard.
  metadataDraftCaptureDebounce() {
    if (!this._metadataDraftCaptureDebounce) {
      this._metadataDraftCaptureDebounce = debounce((sha256) => {
        const current = Number(widgetValue(this.node, "metadata_edit_serial") || 0);
        setWidgetValue(this.node, "metadata_edit_serial", current + 1);
        this.captureMetadataDraft(sha256, { dirty: false });
      }, 250);
    }
    return this._metadataDraftCaptureDebounce;
  },

  async ensureLoraDetail(lora, { refresh = false } = {}) {
    if (!lora?.sha256 || (!refresh && lora.descriptionLoaded && !this.hasDeferredLoraDetail(lora))) {
      return lora;
    }
    if (!refresh && lora._krcDetailPromise) {
      return lora._krcDetailPromise;
    }
    let wasModified = false;
    try {
      wasModified = this.isMetadataModified(lora);
    } catch {
      wasModified = false;
    }
    lora._krcDetailPromise = (async () => {
      const { ok, data: detail } = await getSharedJson(`/detail/${encodeURIComponent(lora.sha256)}`);
      if (!ok || this._destroyed) {
        return lora;
      }
      if (!detail || detail.sha256 !== lora.sha256) {
        return lora;
      }
      if (!wasModified && this.isMetadataModified(lora)) {
        return lora;
      }
      if (this.readMetadataDraft()[lora.sha256]) {
        mergeSavedMetadata(this, lora, { ...detail, descriptionLoaded: true, ...clearedDeferredDetailFlags() }, { complete: true });
        this.updateCachedMetadataSnapshots?.();
        return lora;
      }
      Object.assign(lora, detail, {
        descriptionLoaded: true,
        ...clearedDeferredDetailFlags(),
      });
      // Re-baseline the dirty snapshot to the freshly loaded server values whenever
      // the user has no persisted unsaved edit for this LoRA. Gating on draft-absence
      // (the real "unsaved edits" signal) rather than the old `wasModified` fixes the
      // Safari dirty-baseline desync: the snapshot is captured from the library list,
      // which defers the heavy fields (description/examplePrompts/usage/nsfwLevel), so
      // once detail loads an untouched LoRA could read as "modified" forever if
      // `wasModified` false-positived and the snapshot never got refreshed. An edit in
      // flight is still protected by the isMetadataModified bail above.
      if (this.readMetadataDraft()[lora.sha256] === undefined) {
        this.metadataSnapshots.set(lora.sha256, this.metadataSnapshotValue(lora));
        this.metadataBaselines?.delete(lora.sha256);
        this.updateCachedMetadataSnapshots();
      }
      return lora;
    })().finally(() => {
      delete lora._krcDetailPromise;
    });
    return lora._krcDetailPromise;
  },

  async blankMetadata(selected) {
    if (!selected?.sha256) {
      return null;
    }
    const response = await fetchLora(`/metadata/blank/${selected.sha256}`, { method: "POST" });
    if (!response.ok) {
      krcAlert(`Could not reset metadata (HTTP ${response.status}).`, this.node);
      return null;
    }
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    // Reset ID is the last-resort fix for a stuck record: no unsaved-edits draft
    // survives it, under either id.
    const draft = this.readMetadataDraft();
    const resetIds = [selected.sha256, payload?.identity?.oldId, payload?.identity?.newId].filter(Boolean);
    if (resetIds.some((id) => id in draft)) {
      resetIds.forEach((id) => delete draft[id]);
      this.writeMetadataDraft(draft, { dirty: false });
    }
    if (payload?.identity?.shared) {
      // The old id still belongs to another file on disk: this file moved to its own
      // id and the other one comes back as its own card, so this list is re-read.
      await this.loadLibrary({ restoreScroll: true, focusSelection: true, changed: true });
      this.selectedSha = payload.identity.newId;
      setWidgetValue(this.node, "selected_lora_sha256", payload.identity.newId);
      const current = this.loras.find((lora) => lora.sha256 === payload.identity.newId);
      const refreshed = current ? await this.ensureLoraDetail(current, { refresh: true }) : null;
      if (refreshed) this.commitSavedMetadata?.(refreshed);
      return refreshed;
    }
    if (payload?.identity?.oldId && payload?.identity?.newId) {
      this.applyIdentityChange(payload.identity, { rememberAlias: false });
      // The other surfaces used to learn of the new id from a full reload.
      this.broadcastIdentityChanged?.(payload.identity);
      setWidgetValue(this.node, "selected_lora_sha256", payload.identity.newId);
    }
    const refreshed = await this.refreshLibraryRecord(payload?.identity?.newId || selected.sha256);
    if (refreshed) {
      this.commitSavedMetadata?.(refreshed);
    }
    return refreshed;
  },

  // Civitai public by-hash fetch (shared by the info-panel FETCH glyph and the More
  // Info "Force Refresh"). Fetches + caches + merges server-side, then reloads so the
  // panel updates. On a merged hit, returns the refreshed detailed record (mirroring
  // blankMetadata) so the More Info modal can re-render from it rather
  // than a stale light record.
  // Returns { status, refreshed }: status drives in-button feedback (spinner/error);
  // refreshed is the reloaded detailed record on a merged hit (or null).
  async fetchCivitaiMetadata(selected, { force = false } = {}) {
    const sha = selected?.sha256;
    if (!sha) {
      showToast("Save metadata first to create a stable hash.", { duration: 2600 });
      return { status: "unavailable", refreshed: null };
    }
    // Point-of-need stabilization: a Civitai by-hash query needs the real content sha.
    // A still-local id is allowed through — the server hashes it first (attaching to any
    // background warm) and returns the promotion, which we reconcile below. Tell the user
    // why the wait is longer, since hashing a large model can take a while.
    const needsHash = String(sha).startsWith("local-");
    if (needsHash) {
      showToast("Computing content hash…", { duration: 2600 });
    }
    // Client-side ceiling so the button gives up instead of hanging if the server
    // stalls. Above the server's own worst case (~10s metadata + ~30s media download)
    // so a normal slow fetch still completes; this only trips on a real hang. A hash of
    // a 20GB+ model can run for minutes, so grant far more headroom when stabilizing.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), needsHash ? 600000 : 45000);
    let response;
    try {
      response = await fetchLora(`/civitai/fetch/${sha}${force ? "?force=1" : ""}`, { method: "POST", signal: controller.signal });
    } catch (err) {
      const timedOut = err?.name === "AbortError";
      showToast(timedOut ? "Civitai fetch timed out." : "Civitai fetch failed (network error).", { duration: 3200 });
      return { status: timedOut ? "timeout" : "error", refreshed: null };
    } finally {
      clearTimeout(timer);
    }
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    // If the server stabilized the id to satisfy the by-hash query, reconcile now —
    // before the switch — so every outcome (hit, not_found, error) lands on the new sha
    // rather than leaving a stale local id in the panel/stacks. applyIdentityChange only
    // updates the data model; a targeted re-window paints the new id (the hit branch
    // below additionally reloads, which is harmlessly redundant after this).
    if (payload?.identity?.oldId && payload?.identity?.newId) {
      this.applyIdentityChange?.(payload.identity);
      this.broadcastIdentityChanged?.(payload.identity);
      this.refreshBrowserResults?.();
      this.refreshInfo?.();
    }
    const status = payload?.status || "error";
    let refreshed = null;
    switch (status) {
      case "complete":
        showToast("Already have Civitai metadata — use Force Refresh to re-pull.", { duration: 3200 });
        break;
      case "hit":
        if (payload.merged) {
          // A rewritten thumbnail comes back with a new per-item thumbnailVersion, so
          // its image URL changes and the new image shows.
          refreshed = await this.refreshLibraryRecord(payload?.identity?.newId || sha);
          if (refreshed) {
            this.commitSavedMetadata?.(refreshed);
            // The Civitai preview may be a new thumbnail: tell the other copies too.
            this.announceThumbnailChange?.(refreshed.sha256);
          }
        }
        showToast(civitaiFetchMessage(payload), { duration: payload.kept?.length ? 4600 : 3000 });
        break;
      case "not_found": {
        // Flag it not-found now (civitai:none) — the server derives the same flag from the
        // cache on the next list load. (A later hit clears it via that reload.)
        const checkedAt = Number(payload.fetchedAt) || Date.now();
        const currentSha = payload?.identity?.newId || sha;
        for (const item of [selected, this.loras?.find((lora) => lora.sha256 === currentSha)]) {
          if (item) item.civitaiNotFoundAt = checkedAt;
        }
        this.refreshBrowserResults?.();
        this.refreshInfo?.();
        showToast("Not found on Civitai (or hidden on public fetch).", { duration: 3200 });
        break;
      }
      case "disabled":
        notifyNetworkDisabled();
        break;
      default:
        showToast(`Civitai fetch failed${payload?.detail ? ": " + payload.detail : ""}.`, { duration: 3200 });
    }
    return { status, refreshed };
  },
  };
}
