// Shared "More Info" modal internals: the read-only row, the inline edit field,
// the section wrapper, the metadata provenance cell/footer, the NSFW rating row, and
// the list / usage / creator formatters + parsers. Byte-shared by LoRA Loadout and Model
// Library. Each node keeps its own openMoreInfoModal + renderMoreInfoBody (and the
// generic-model body/footer variants) and composes those over this mixin via `this`.
import { renderVerificationShield, isVerified, manualVerification, clearedVerification } from "./verification_shield.js";
import { openKrcConfirm, krcAlert } from "./modal.js";
import { menuSelect } from "./browser_controls.js";
import { NSFW_RATINGS } from "./metadata_fields.js";

export const sharedMoreInfoModalMethods = {
  // The manual "Verify" toggle for the More Info footer action row. Reflects the
  // current verified state; confirms via a themed dialog; clears ANY verification
  // (manual or an auto Civitai/HF one) when already verified. Persists through the
  // node's persistVerification, then onChanged re-renders the modal.
  renderVerifyAction(selected, { onChanged } = {}) {
    const verified = isVerified(selected?.verification);
    const btn = document.createElement("button");
    btn.className = `krc-modal-btn krc-verify-button${verified ? " is-on" : ""}`;
    btn.type = "button";
    btn.textContent = verified ? "Verified ✓" : "Verify";
    btn.title = verified ? "Clear this record's verification" : "Mark this record as manually verified";
    btn.disabled = !selected;
    btn.addEventListener("click", async () => {
      if (!selected) return;
      const confirmed = await openKrcConfirm({
        node: this.node,
        title: verified ? "Clear verification" : "Verify record",
        message: verified
          ? "Clear the verification badge for this record?"
          : "Mark this record as manually verified? This asserts you have confirmed the file yourself.",
        confirmLabel: verified ? "Clear" : "Mark verified",
        danger: verified,
      });
      if (!confirmed) return;
      const next = verified ? clearedVerification() : manualVerification(selected.sha256 || "");
      const ok = await this.persistVerification(selected, next);
      if (ok) onChanged?.();
    });
    return btn;
  },

  // Persist a record's verification object through the node's writeMetadataFlag
  // (which already routes LoRA vs generic-model saves). Optimistic: set locally,
  // roll back on failure. Refreshes the info panel behind the modal so its footer
  // shield updates too.
  async persistVerification(selected, verification) {
    if (!selected?.sha256) return false;
    const previous = selected.verification;
    selected.verification = verification;
    try {
      const response = await this.writeMetadataFlag(selected, "verification", verification);
      if (!response || response.ok === false) throw new Error(`HTTP ${response?.status}`);
      this.refreshInfo?.();
      return true;
    } catch {
      selected.verification = previous;
      krcAlert("Could not save verification. Check the ComfyUI server log.", this.node);
      return false;
    }
  },


  renderMoreInfoRow(label, value) {
    const row = document.createElement("div");
    row.className = "krc-modal-text-row";
    const name = document.createElement("span");
    name.className = "krc-modal-text-label";
    name.textContent = label;
    const content = document.createElement("span");
    content.className = "krc-modal-text-value";
    const text = value || "—";
    content.textContent = text;
    content.title = text;
    row.append(name, content);
    return row;
  },

  renderMoreInfoEditField(label, value, onInput, { multiline = false, prominent = false, onEdited = null, className = "" } = {}) {
    const field = document.createElement("label");
    field.className = "krc-modal-text-row is-edit";
    if (multiline) {
      field.classList.add("is-block");
    }
    if (prominent) {
      field.classList.add("is-prominent");
    }
    if (className) {
      field.classList.add(className);
    }
    const name = document.createElement("span");
    name.className = "krc-modal-text-label";
    name.textContent = label;
    const control = document.createElement(multiline ? "textarea" : "input");
    control.className = "krc-modal-edit-control";
    control.value = value || "";
    control.addEventListener("input", (event) => {
      onInput?.(event.target.value);
      onEdited?.();
    });
    field.append(name, control);
    return field;
  },

  renderMoreInfoSection(label, rows) {
    const section = document.createElement("section");
    section.className = "krc-modal-text-section";
    const title = document.createElement("div");
    title.className = "krc-modal-text-section-title";
    title.textContent = label;
    section.append(title, ...rows.filter(Boolean));
    return section;
  },

  renderMoreInfoMetaCell(label, value, { align = "left", copy = false, leading = null } = {}) {
    const cell = document.createElement("span");
    cell.className = `krc-modal-meta-cell is-${align}`;
    const text = value ? `${label} ${value}` : `${label} —`;
    const valueText = String(value || "");
    // Optional leading node (e.g. the verification shield left of the ID).
    if (leading) cell.append(leading);
    const labelText = document.createElement("span");
    labelText.className = "krc-modal-meta-text";
    labelText.textContent = text;
    cell.append(labelText);
    if (copy && valueText) {
      const button = document.createElement("button");
      button.className = "krc-modal-meta-copy";
      button.type = "button";
      button.textContent = "⧉";
      button.title = `Copy ${label}`;
      button.setAttribute("aria-label", `Copy ${label}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        this.copyText(valueText);
      });
      cell.append(button);
    }
    cell.title = text;
    return cell;
  },

  // Empty wide cell that keeps a right-column cell in place when its row has no
  // left value.
  renderMoreInfoMetaSpacer() {
    const cell = document.createElement("span");
    cell.className = "krc-modal-meta-cell is-wide";
    return cell;
  },

  renderMoreInfoMetaFooter(selected) {
    const wrap = document.createElement("div");
    wrap.className = "krc-modal-meta-grid";
    const rowOne = document.createElement("div");
    rowOne.className = "krc-modal-meta-grid-row";
    rowOne.append(
      this.renderMoreInfoMetaCell("Origin", selected?.originUrl || "", { align: "wide", copy: true }),
      this.renderMoreInfoMetaCell("Date Added", this.formatDateOnly(selected?.dateAdded), { align: "right" })
    );
    const rowTwo = document.createElement("div");
    rowTwo.className = "krc-modal-meta-grid-row";
    rowTwo.append(
      this.renderMoreInfoMetaCell("File", this.displayFilePath(selected), { align: "wide", copy: true }),
      this.renderMoreInfoMetaCell("Date Modified", this.formatDate(selected?.dateModified), { align: "right" })
    );
    // One ID cell (the KRC id: the content SHA256 once stabilized, a local- id
    // before) lives in the footer, dimmed and copyable, mirroring the generic-model
    // footer, so it needs no Identity-section row.
    const rowThree = document.createElement("div");
    rowThree.className = "krc-modal-meta-grid-row";
    rowThree.append(
      this.renderMoreInfoMetaCell("ID", selected?.sha256 || "", { align: "wide", copy: true, leading: renderVerificationShield(selected?.verification) }),
      this.renderMoreInfoMetaCell("Source", this.formatMetadataSource(selected), { align: "right" })
    );
    const rowFour = document.createElement("div");
    rowFour.className = "krc-modal-meta-grid-row";
    rowFour.append(
      this.renderMoreInfoMetaSpacer(),
      this.renderMoreInfoMetaCell("Fetched", this.formatDateOnly(selected?.sourceFetchedAt), { align: "right" })
    );
    wrap.append(rowOne, rowTwo, rowThree, rowFour, this.renderMoreInfoUsageRow(selected));
    return wrap;
  },

  // The footer's last row: how often it's been used (once per run, by KRC nodes; the
  // per-run counter in utils/library/run_usage.py) and when last.
  renderMoreInfoUsageRow(selected) {
    const row = document.createElement("div");
    row.className = "krc-modal-meta-grid-row";
    row.append(this.renderMoreInfoMetaSpacer(), this.renderMoreInfoMetaCell("Used", this.formatUsage(selected), { align: "right" }));
    return row;
  },

  formatUsage(selected) {
    const count = Math.max(0, Number(selected?.useCount) || 0);
    if (!count) return "Never";
    const times = `${count} time${count === 1 ? "" : "s"}`;
    const last = Number(selected?.lastUsedMs) ? this.formatDateOnly(Number(selected.lastUsedMs)) : "";
    return last ? `${times} · last ${last}` : times;
  },

  // Human-readable provenance for the Source line. Reads metadataSource +
  // sourceImportType (both serialized from the record). "· preview hidden" flags a
  // mature LoRA whose preview the public/anonymous fetch couldn't retrieve.
  formatMetadataSource(selected) {
    const source = selected?.metadataSource || "";
    const importType = selected?.sourceImportType || "";
    let label;
    switch (source) {
      case "civitai": label = "Civitai"; break;
      case "huggingface": label = "HuggingFace"; break;
      case "krc": label = importType === "krc_manual" ? "Manual (user-entered)" : "KRC"; break;
      default: label = importType === "krc_manual" ? "Manual (user-entered)" : "Local file only";
    }
    if (selected?.previewWithheld) {
      label += " · preview hidden (public fetch)";
    }
    return label;
  },

  formatMoreInfoList(values) {
    return (Array.isArray(values) ? values : [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(", ");
  },

  formatMoreInfoCreator(selected) {
    return selected?.creator?.username || "";
  },

  formatUsageValue(value) {
    if (Array.isArray(value)) {
      return value.map((item) => String(item || "").trim()).filter(Boolean).join(", ");
    }
    if (value === true) {
      return "yes";
    }
    if (value === false) {
      return "no";
    }
    return String(value || "").trim();
  },

  formatMoreInfoUsage(selected) {
    const usage = selected?.usage || {};
    const values = [
      usage.license ? String(usage.license) : "",
      // uploadType ("Created"/"Trained") is Civitai upload-method provenance, not a
      // licensing term — kept in the record, but excluded from the permissions summary.
      this.formatUsageValue(usage.allowCommercialUse) ? `commercial ${this.formatUsageValue(usage.allowCommercialUse)}` : "",
      usage.allowDerivatives !== undefined && usage.allowDerivatives !== null ? `derivatives ${this.formatUsageValue(usage.allowDerivatives)}` : "",
      usage.allowNoCredit !== undefined && usage.allowNoCredit !== null ? `no credit ${this.formatUsageValue(usage.allowNoCredit)}` : "",
      usage.allowDifferentLicense !== undefined && usage.allowDifferentLicense !== null ? `license change ${this.formatUsageValue(usage.allowDifferentLicense)}` : "",
      usage.credit ? `credit ${usage.credit}` : "",
    ].filter(Boolean);
    return values.join(" · ");
  },

  // The NSFW rating row: a menu of the shared ratings (never a native <select>),
  // writing `selected.nsfwLevel` (0 or one content flag).
  renderMoreInfoNsfwField(selected, { onEdited = null } = {}) {
    const field = document.createElement("div");
    field.className = "krc-modal-text-row is-edit krc-more-info-nsfw-row";
    const name = document.createElement("span");
    name.className = "krc-modal-text-label";
    name.textContent = "NSFW";
    const level = Number(selected?.nsfwLevel) || 0;
    const picker = menuSelect({
      className: "krc-modal-select",
      title: "Content rating (Civitai's scale)",
      value: String(NSFW_RATINGS.some(([value]) => value === level) ? level : 0),
      options: NSFW_RATINGS.map(([value, label]) => [String(value), label]),
      onChange: (value) => {
        selected.nsfwLevel = Number(value) || 0;
        this.markMetadataEdited();
        onEdited?.();
      },
    });
    field.append(name, picker);
    return field;
  },

  parseMoreInfoList(value) {
    return String(value || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  },
};
