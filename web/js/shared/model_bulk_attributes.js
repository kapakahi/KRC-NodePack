import { postLoraJson } from "../model_library/api.js";
import { PAGE_SYNC_ID } from "./sync_origin.js";

export function modelBulkAttributes(panel) {
  return {
    read: (item, field) => item[field],
    async apply(ids, field, value) {
      const selectedIds = new Set(ids);
      const targets = panel.loras.filter((item) => selectedIds.has(String(item.sha256)));
      if (targets.length !== ids.length) throw new Error("A selected card no longer exists. Refresh and select again.");
      const response = await postLoraJson("/bulk-attributes", { ids, field, value, originPage: PAGE_SYNC_ID });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "Could not save attributes.");
      for (const item of targets) item[field] = value;
      panel.broadcastMetadataChanged(targets[0], { affected: ids, fields: [field] });
      panel.invalidateVisibleLoras?.();
      panel.refreshBrowser({ focusSelection: true });
      panel.refreshInfo();
      panel.refreshStacks?.();
      return result;
    },
  };
}
