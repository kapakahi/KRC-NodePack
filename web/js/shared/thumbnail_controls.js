import { armConfirmButton } from "./confirm_action.js";
import { el } from "./dom.js";

const MODE_TITLE = "Switch between Upload and Paste modes.";

export function thumbnailControlRow({
  pasteMode = false,
  actionDisabled = false,
  removeDisabled = false,
  onAction = () => {},
  onRemove = () => {},
  onPasteModeChange = () => {},
} = {}) {
  let mode = !!pasteMode;
  const row = el("div", "krc-thumb-control");
  const group = el("div", "krc-thumb-mode-group");
  const action = el("button", "krc-action-button krc-thumb-action krc-thumb-main");
  const modeToggle = el("button", "krc-action-button krc-thumb-action krc-thumb-mode-toggle");
  const remove = el("button", "krc-action-button krc-thumb-action krc-thumb-remove-icon");

  action.type = "button";
  action.disabled = !!actionDisabled;
  modeToggle.type = "button";
  modeToggle.title = MODE_TITLE;
  modeToggle.setAttribute("aria-label", "Paste thumbnail mode");
  remove.type = "button";
  remove.title = "Remove thumbnail";
  remove.setAttribute("aria-label", "Remove thumbnail");
  remove.disabled = !!removeDisabled;

  const syncMode = () => {
    action.textContent = mode ? "Paste" : "Upload";
    action.title = mode ? "Paste an image from the clipboard" : "Upload an image, or an mp4/webm to convert into an animated thumbnail";
    modeToggle.textContent = "";
    modeToggle.classList.toggle("is-active", mode);
    modeToggle.setAttribute("aria-pressed", mode ? "true" : "false");
  };

  action.addEventListener("click", () => onAction(mode));
  modeToggle.addEventListener("click", () => {
    mode = !mode;
    syncMode();
    onPasteModeChange(mode);
  });
  row.removeConfirm = armConfirmButton(remove, {
    armedText: "!",
    armedTitle: "Confirm thumbnail removal",
    restoreText: "",
    restoreTitle: "Remove thumbnail",
    shouldArm: () => !remove.disabled,
    onConfirm: onRemove,
  });

  syncMode();
  group.append(action, modeToggle);
  row.append(group, remove);
  return row;
}
