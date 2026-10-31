// Keep focused prompt drafts attached to their stable IDs across batch structure edits.
export function reconcilePromptBulk(controller, selectedId, patch) {
  if (!selectedId) return;
  if (patch.deleted?.includes(selectedId)) {
    controller.selKey = null; controller.orig = null; controller.draft = null;
    controller._savedPromptDetail = null;
    controller.clearPersistedDraft?.();
    return;
  }
  const moved = patch.records?.find((record) => record.id === selectedId);
  if (!moved) return;
  controller.selKey = controller.keyOf(moved.category, moved.name);
  controller.orig = { ...controller.orig, category: moved.category, name: moved.name };
  for (const record of [controller.draft, controller._savedPromptDetail]) {
    if (record) Object.assign(record, moved);
  }
  controller.followSelectionCategory?.(moved.category);
  controller.syncWidgetsFromDraft?.();
  controller.captureRecordBaseline?.();
}

// A compact server notification refetches the library once per page. Follow the
// focused stable ID and update affordances, without adopting unsaved content.
export function reconcilePromptBulkRefresh(controller, selectedId) {
  if (!selectedId) return;
  const saved = controller.items.find((item) => item.id === selectedId);
  if (!saved) { reconcilePromptBulk(controller, selectedId, { deleted: [selectedId] }); return; }
  if (controller.selKey !== controller.keyOf(saved.category, saved.name)) {
    const baseline = controller.recordBaseline?.();
    reconcilePromptBulk(controller, selectedId, { records: [{ id: saved.id, category: saved.category, name: saved.name,
      dateAdded: saved.dateAdded, dateModified: saved.dateModified }] });
    // Keep the old content revision until the existing stale/detail catch-up runs.
    if (baseline) controller.setSerializableProperty?.("pmRecordBaseline", { ...baseline, key: controller.selKey });
  }
  for (const field of ["favorite", "pinned", "nsfw", "cardColor", "customBadge"]) {
    const value = saved[field] ?? (["cardColor", "customBadge"].includes(field) ? "" : false);
    if (controller.draft) controller.draft[field] = value;
    if (controller._savedPromptDetail) controller._savedPromptDetail[field] = value;
  }
}
