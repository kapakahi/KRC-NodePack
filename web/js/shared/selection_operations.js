// Shared confirmation/lifecycle for provider mutations and cancellable model jobs.
import { el } from "./dom.js";
import { openKrcModal } from "./modal.js";
import { armConfirmButton } from "./confirm_action.js";

export function openSelectionOperation({ controller, operation }) {
  if (controller.status().busy || !controller.status().count) return null;
  let ids = controller.beginOperation();
  const deleting = operation.kind === "delete";
  const longRunning = Boolean(operation.longRunning);
  let phase = "loading";
  let released = false;
  let disposed = false;
  let arming = null;
  const release = (exit) => { if (!released) { released = true; controller.finishOperation({ exit }); } };
  const body = el("div", "krc-modal-list");
  const summary = el("div", "krc-modal-count", { textContent: `${ids.length} ${operation.noun} selected` });
  const message = el("div", "krc-confirm-message", { textContent: "Checking selected records…" });
  const status = el("div", "krc-modal-count", { role: "status", textContent: "" });
  body.append(summary, message);
  let destination = null;
  const cancel = { label: "Cancel", onClick: async ({ close, btn }) => {
    if (phase !== "running") { close(); return; }
    if (!longRunning) return;
    btn.disabled = true;
    try { await operation.cancel(); if (phase === "running") status.textContent = "Stopping after the current item finishes…"; }
    catch (error) { status.textContent = String(error?.message || error); btn.disabled = false; }
  } };
  const confirm = { label: deleting ? "DELETE" : longRunning ? "Start" : "Move", primary: true, className: deleting ? "is-danger" : "", disabled: true };
  const modal = openKrcModal({
    node: operation.node, title: operation.title, body, actions: [cancel, confirm], width: 840,
    canClose: () => phase !== "running",
    onClose: () => { disposed = true; arming?.dispose(); release(false); },
  });
  const execute = async () => {
    if (phase !== "ready" || confirm.btn.disabled) return;
    if (released) {
      if (!controller.status().active || !controller.status().count) {
        status.textContent = "Selection expired or changed. Close and select cards again.";
        confirm.btn.disabled = true; return;
      }
      ids = controller.beginOperation(); released = false;
      summary.textContent = `${ids.length} ${operation.noun} selected`;
    }
    phase = "running"; confirm.btn.disabled = true; cancel.btn.disabled = true;
    if (destination) destination.disabled = true;
    status.textContent = `${deleting ? "Deleting" : longRunning ? "Starting" : "Moving"} ${ids.length} ${operation.noun}…`;
    try {
      const result = await operation.execute(ids, { destination: destination?.value, confirmed: deleting || longRunning,
        onProgress: (job) => {
          cancel.btn.disabled = !job.active || job.state === "cancelling";
          cancel.btn.textContent = job.state === "cancelling" ? "Stopping…" : "Cancel remaining";
          status.textContent = `${job.done}/${job.total} · ${job.succeeded} succeeded · ${job.skipped} skipped · ${job.notFound || 0} no match · ${job.failed} failed${job.current ? ` · ${job.current.phase}: ${job.current.name}` : ""}`;
        },
      });
      if (!result || result.ok === false || result.success === false) throw new Error(result?.error || "The operation failed.");
      phase = "done";
      const retry = longRunning && result.retryIds?.length;
      release(!retry);
      if (retry) controller.retain(result.retryIds);
      status.textContent = longRunning ? `${result.state} · ${result.updated || 0} succeeded · ${result.skipped || 0} skipped · ${result.notFound || 0} no match · ${result.failed || 0} failed · ${result.retryIds?.length || 0} remaining/failed` : `${result.updated || 0} ${deleting ? "deleted" : "moved"} · ${result.skipped || 0} skipped`;
      for (const warning of result.warnings || []) body.append(el("div", "krc-confirm-message", { textContent: warning }));
      confirm.btn.hidden = !retry; cancel.btn.disabled = false; cancel.btn.textContent = "Close";
      if (retry) { phase = "ready"; confirm.btn.disabled = false; confirm.btn.textContent = "Retry failed / remaining"; }
      if (destination) destination.disabled = true;
    } catch (error) {
      phase = "ready";
      status.textContent = String(error?.message || error);
      confirm.btn.disabled = false; cancel.btn.disabled = false;
      if (longRunning) { confirm.btn.textContent = "Reconnect / retry"; cancel.btn.textContent = "Close"; }
      if (destination) destination.disabled = false;
      // Keep the original ID snapshot. A destructive retry always requires arming
      // again; there is no automatic retry or widening to newly arrived results.
    }
  };
  if (deleting) arming = armConfirmButton(confirm.btn, { armedText: "Confirm DELETE", shouldArm: () => phase === "ready" && !confirm.btn.disabled, onConfirm: execute });
  else confirm.btn.addEventListener("click", execute);
  const ready = Promise.resolve().then(() => operation.preview(ids)).then((preview) => {
    if (disposed) return;
    if (!preview || preview.ok === false || preview.success === false) throw new Error(preview?.error || "Could not check selected records.");
    if (preview.count !== ids.length) throw new Error("The selected records changed. Close and select again.");
    message.textContent = preview.message || "";
    if (!deleting && !longRunning) {
      const label = el("label", "krc-modal-row", { textContent: operation.destinationLabel || "Destination" });
      destination = el("select", "krc-modal-select");
      for (const entry of preview.destinations || []) destination.append(el("option", "", { value: entry.value, textContent: entry.label }));
      label.append(destination); body.append(label);
      if (!destination.children.length) throw new Error("No destination is available.");
    }
    body.append(status);
    phase = "ready"; confirm.btn.disabled = longRunning && !preview.eligible;
  }).catch((error) => {
    if (disposed) return;
    phase = "failed"; message.textContent = String(error?.message || error);
    release(false); cancel.btn.textContent = "Close";
  });
  return { ...modal, ready };
}
