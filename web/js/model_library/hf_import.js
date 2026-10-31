import { openKrcModal } from "../shared/modal.js";
import { isNetworkAllowed, notifyNetworkDisabled } from "../shared/network_consent.js";
import { showToast } from "../shared/toast.js";
import { postLoraJson } from "./api.js";

// HuggingFace metadata import.
//
// Opens a paste-a-repo modal from the More Info footer's "Import from HF" button,
// then POSTs the repo to /krc/model-library/hf/import/{id}. The server (routes.py
// _hf_import_impl) fetches the model card via the shared egress client and maps it
// into the generic model schema (hf_map) — or the LoRA schema for a read-through id.
// Honors the network-consent gate before any request.
export const hfImportMethods = {
  // POST the pasted repo to the import route, then reload so the panel/modal update.
  // Mirrors fetchCivitaiMetadata: returns { status, refreshed } — refreshed is the
  // reloaded detailed record on success (or null).
  async importFromHuggingFace(selected, repo) {
    const sha = selected?.sha256;
    if (!sha) {
      return { status: "unavailable", refreshed: null };
    }
    let response;
    try {
      response = await postLoraJson(`/hf/import/${encodeURIComponent(sha)}`, { repo });
    } catch {
      showToast("HuggingFace import failed (network error).", { duration: 3200 });
      return { status: "error", refreshed: null };
    }
    let payload = {};
    try { payload = await response.json(); } catch { payload = {}; }
    const status = payload?.status || "error";
    let refreshed = null;
    switch (status) {
      case "hit":
        refreshed = await this.refreshLibraryRecord(sha);
        showToast(`Imported from HuggingFace (${payload.repo}).`, { duration: 2600 });
        break;
      case "not_found":
        showToast("Repo or model card not found on HuggingFace.", { duration: 3200 });
        break;
      case "invalid":
        showToast("Not a valid HuggingFace repo URL or author/model.", { duration: 3200 });
        break;
      case "disabled":
        notifyNetworkDisabled();
        break;
      default:
        showToast(`HuggingFace import failed${payload?.detail ? ": " + payload.detail : ""}.`, { duration: 3200 });
    }
    return { status, refreshed };
  },

  openHfImportModal(selected, { onImported = null } = {}) {
    if (!selected) {
      return null;
    }

    const body = document.createElement("div");
    body.className = "krc-hf-import-body";

    const field = document.createElement("label");
    field.className = "krc-modal-text-row is-edit is-block";
    const fieldLabel = document.createElement("span");
    fieldLabel.className = "krc-modal-text-label";
    fieldLabel.textContent = "HuggingFace repo";
    const input = document.createElement("input");
    input.className = "krc-modal-edit-control";
    input.type = "text";
    input.placeholder = "https://huggingface.co/author/model  or  author/model";
    field.append(fieldLabel, input);

    const hint = document.createElement("div");
    hint.className = "krc-hf-import-hint";
    hint.textContent = "Imports the model card, author, and license from the repo.";

    body.append(field, hint);

    const modal = openKrcModal({
      node: this.node,
      title: "Import from HuggingFace",
      body,
      width: 460,
      actions: [
        { label: "Cancel", onClick: ({ close }) => close() },
        {
          label: "Import",
          primary: true,
          className: "krc-hf-import-confirm",
          onClick: async ({ close, btn }) => {
            const value = input.value.trim();
            if (!value) {
              showToast("Paste a HuggingFace repo URL or author/model.", { duration: 2600 });
              input.focus();
              return;
            }
            // Egress happens here, so honor the consent gate before any request.
            if (!isNetworkAllowed()) {
              notifyNetworkDisabled();
              return;
            }
            btn.disabled = true;
            btn.textContent = "Importing…";
            const result = await this.importFromHuggingFace(selected, value);
            if (result?.status === "hit") {
              onImported?.(result.refreshed);
              close();
            } else {
              btn.disabled = false;
              btn.textContent = "Import";
            }
          },
        },
      ],
    });

    // Focus the field for an immediate paste.
    setTimeout(() => input.focus(), 0);
    return modal;
  },
};
