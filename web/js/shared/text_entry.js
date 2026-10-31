import { el, stopCanvasEvents } from "./dom.js";
import { openKrcModal } from "./modal.js";

export function createTextEntryControl({
  value = "",
  placeholder = "",
  maxLength = 160,
  title = "",
  autoSelect = true,
  normalize = (text) => String(text || "").trim(),
  validate = null,
  onInput = null,
  onSubmit = null,
  onCancel = null,
} = {}) {
  const wrap = el("div", "krc-text-entry");
  const shell = el("div", "krc-text-entry-shell");
  const input = el("input", "krc-text-entry-input", {
    type: "text",
    value: value || "",
    placeholder,
    maxLength,
    title,
    autocomplete: "off",
  });
  const clear = el("button", "krc-text-entry-clear", {
    type: "button",
    textContent: "x",
    title: "Clear",
  });
  const message = el("div", "krc-text-entry-message");

  const currentValue = () => normalize(input.value);
  const validationMessage = () => {
    const normalized = currentValue();
    if (typeof validate !== "function") return "";
    return validate(normalized, input.value) || "";
  };
  const sync = () => {
    const invalid = !!validationMessage();
    const empty = !String(input.value || "");
    wrap.classList.toggle("is-invalid", invalid);
    wrap.classList.toggle("is-empty", empty);
    clear.hidden = empty;
    message.textContent = invalid ? validationMessage() : "";
    onInput?.(currentValue(), input.value);
  };
  const focus = () => {
    input.focus();
    if (autoSelect) input.select();
  };
  const submit = async () => {
    sync();
    if (wrap.classList.contains("is-invalid")) return false;
    return await onSubmit?.(currentValue());
  };

  input.addEventListener("input", sync);
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel?.();
    }
  });
  clear.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    input.value = "";
    sync();
    input.focus();
  });

  shell.append(input, clear);
  wrap.append(shell, message);
  stopCanvasEvents(wrap);
  sync();

  return {
    el: wrap,
    input,
    value: currentValue,
    setValue(next) {
      input.value = next || "";
      sync();
    },
    focus,
    sync,
    submit,
  };
}

export function openTextEntryDialog({
  node = null,
  title = "Name",
  label = "",
  value = "",
  placeholder = "name",
  maxLength = 160,
  confirmTitle = "Save",
  width = 340,
  normalize = (text) => String(text || "").trim(),
  validate = null,
} = {}) {
  return new Promise((resolve) => {
    let resolved = false;
    let modal = null;
    let entry = null;
    let save = null;

    const body = el("div", "krc-text-entry-dialog");
    if (label) {
      body.appendChild(el("label", "krc-text-entry-dialog-label", { textContent: label }));
    }

    entry = createTextEntryControl({
      value,
      placeholder,
      maxLength,
      title,
      normalize,
      validate: (next, raw) => {
        if (!next) return `${placeholder || "Value"} is required.`;
        return validate?.(next, raw) || "";
      },
      onInput: () => syncSave(),
      onSubmit: () => save?.click(),
      onCancel: () => closeWith(null),
    });
    body.appendChild(entry.el);

    const footer = el("div", "krc-text-entry-dialog-footer");
    const cancel = el("button", "krc-modal-btn", { type: "button", textContent: "Cancel" });
    save = el("button", "krc-text-entry-submit", { type: "button", textContent: "✓", title: confirmTitle });

    function syncSave() {
      if (!save || !entry) return;
      const message = entry.el.querySelector(".krc-text-entry-message")?.textContent || "";
      save.disabled = !!message || !entry.value();
    }

    function closeWith(next) {
      if (resolved) return;
      resolved = true;
      modal?.close();
      resolve(next);
    }

    cancel.addEventListener("click", () => closeWith(null));
    save.addEventListener("click", () => {
      entry.sync();
      syncSave();
      if (save.disabled) return;
      closeWith(entry.value());
    });

    footer.append(cancel, save);
    modal = openKrcModal({
      node,
      title,
      body,
      footer,
      width,
      draggable: true,
      onClose: () => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      },
    });

    syncSave();
    requestAnimationFrame(() => entry.focus());
  });
}
