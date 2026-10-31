/*
 * A node's Options-dialog row for moving its data: EXPORT / IMPORT open the KRC bundle
 * dialogs (bundle_dialogs.js; UNIFIED_BUNDLE_GAMEPLAN.md) with only this node's sections
 * ticked. Everything else still moves from Portal ▸ Import and Export. Item-level transfers
 * (a Prompt Vault category, a Word Bank .txt) stay in their node.
 *
 * Each button closes the dialog it sits in first, so the node's Options never show stale
 * data after an import.
 */
import { el } from "../dom.js";
import { ACTION_EXPORT, ACTION_IMPORT } from "../actions.js";
import { krcIoButton } from "../modal.js";
import { openBundleExport, openBundleImport } from "./bundle_dialogs.js";

// sections: the bundle section ids this node owns. sources: as in the runner (a node skips
// its own sync echo). onImported(): after an import landed (e.g. the node reloads).
export function nodeTransferRow({ node = null, sections, label = "this node's data", sources = null, onImported = null, promptProfile = null } = {}) {
  const row = el("div", "krc-io-row krc-node-transfer-row");
  row.append(
    el("span", "krc-io-row-text", { textContent: `Move ${label} in a KRC bundle.` }),
    el("span", "krc-io-row-spacer"),
    krcIoButton({
      action: ACTION_EXPORT,
      title: `Export ${label} as a KRC bundle`,
      onClick: ({ close }) => {
        close();
        openBundleExport({ node, only: sections, promptProfile: typeof promptProfile === "function" ? promptProfile() : promptProfile });
      },
    }),
    krcIoButton({
      action: ACTION_IMPORT,
      title: `Import ${label} from a KRC bundle`,
      onClick: async ({ close }) => {
        close();
        const { ok } = await openBundleImport({ node, only: sections, sources, promptProfile: typeof promptProfile === "function" ? promptProfile() : promptProfile });
        if (ok) await onImported?.();
      },
    }),
  );
  return row;
}
