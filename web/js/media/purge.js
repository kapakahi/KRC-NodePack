// The global Delete (the toolbar's trash; called Purge until 2026-10-27) uses server eligibility and a fixed confirmation snapshot for every scope.
import { armConfirmButton, closeFloatingMenu, openKrcModal, toggleFloatingMenu } from "./krc.js";
import { formatBytes, mediaApi } from "./api.js";

const el = (tag, className = "", props = {}) => Object.assign(document.createElement(tag), className ? { className } : {}, props);
export const PURGE_SCOPES = Object.freeze([
  ["unsorted", "Delete unsorted"], ["selected", "Delete selected"], ["all", "Delete all"], ["output", "Delete output"],
]);

const menus = new WeakMap();
export function openPurgeMenu({ anchor, node, controller, onChanged }) {
  if (menus.has(anchor)) { closeFloatingMenu(); return; }
  const menu = el("div", "krc-card-context-menu krc-mio-purge-menu");
  menu.hidden = true;
  menu.setAttribute("role", "menu");
  const scopes = controller?.status().active ? PURGE_SCOPES.filter(([scope]) => scope === "selected") : PURGE_SCOPES;
  for (const [scope, label] of scopes) {
    const disabled = controller?.status().busy || (scope === "selected" && !controller?.status().count);
    menu.append(el("button", "krc-card-menu-item is-danger", {
      type: "button", textContent: label, disabled: Boolean(disabled), role: "menuitem",
      title: scope === "selected" ? "Delete the selected cards, sparing protected folders" : label,
      onclick: event => {
        event.stopPropagation();
        closeFloatingMenu();
        openPurgeDialog({ scope, node, controller, onChanged });
      },
    }));
  }
  anchor.setAttribute("aria-haspopup", "menu");
  menus.set(anchor, menu);
  toggleFloatingMenu(anchor, menu, { align: "right", onClose: () => { menus.delete(anchor); anchor.setAttribute("aria-expanded", "false"); } });
  anchor.setAttribute("aria-expanded", "true");
}

export function openPurgeDialog({ scope, node, controller, onChanged }) {
  if (controller?.status().busy) return null;
  let held = false;
  let ids = [];
  if (controller?.status().active) { ids = controller.beginOperation(); held = true; }
  if (scope === "selected" && !ids.length) {
    if (held) controller.finishOperation({ exit: false });
    return null;
  }
  const release = exit => { if (held) { held = false; controller.finishOperation({ exit }); } };
  let running = false;
  let disposed = false;
  let preview = null;
  let arming = null;
  const summary = el("div", "krc-modal-count", { textContent: "Checking Media…" });
  const message = el("div", "krc-confirm-message");
  const status = el("div", "krc-modal-count", { role: "status" });
  const body = el("div", "krc-mio-flush-body");
  body.append(summary, message, status);
  const cancel = { label: "Cancel", onClick: ({ close }) => close() };
  const confirm = { label: "DELETE", primary: true, className: "is-danger", disabled: true };
  const modal = openKrcModal({ node, title: PURGE_SCOPES.find(entry => entry[0] === scope)?.[1] || "Delete Media", width: 840,
    body, actions: [cancel, confirm], canClose: () => !running,
    onClose: () => { disposed = true; arming?.dispose(); release(false); },
  });
  arming = armConfirmButton(confirm.btn, {
    armedText: "Confirm DELETE", shouldArm: () => Boolean(preview?.eligible) && !running && !confirm.btn.disabled,
    onConfirm: async () => {
      running = true;
      confirm.btn.disabled = true;
      cancel.btn.disabled = true;
      status.textContent = "Deleting…";
      try {
        const result = await mediaApi.purge(scope, { ids: scope === "selected" ? ids : undefined, snapshot: preview.snapshot, confirmed: true });
        release(true);
        status.textContent = `${result.removed} deleted · ${result.kept} kept`;
        for (const warning of result.warnings || []) body.append(el("div", "krc-confirm-message", { textContent: warning }));
        confirm.btn.hidden = true;
        cancel.btn.textContent = "Close";
        await onChanged?.(result);
      } catch (error) {
        // Never re-arm a stale scope automatically or expand to newly arrived outputs.
        preview = null;
        status.textContent = String(error?.message || error);
        cancel.btn.textContent = "Close";
      } finally {
        running = false;
        cancel.btn.disabled = false;
      }
    },
  });
  const ready = mediaApi.previewPurge(scope, scope === "selected" ? ids : undefined).then(result => {
    if (disposed) return;
    preview = result;
    summary.textContent = `${result.eligible} to delete (${formatBytes(result.bytes)}) · ${result.skipped} kept · ${result.count} in scope`;
    message.textContent = result.message;
    confirm.btn.disabled = !result.eligible;
  }).catch(error => {
    if (!disposed) { summary.textContent = "Could not check Media"; status.textContent = String(error?.message || error); }
  });
  return { ...modal, ready };
}
