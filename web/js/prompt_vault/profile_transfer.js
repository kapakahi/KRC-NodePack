// Profile choices shared by the node and Portal bundle dialogs.
import { el } from "./dom.js";
import { menuSelect } from "../shared/browser_controls.js";
import { effectiveProfile, profileChoice, profileControl, profileExists } from "./profiles.js";

export const transferProfileId = explicit => explicit || effectiveProfile(profileChoice("portal"));

export function promptImportControls({ id, name = "", onChange }) {
  const state = { id, action: "merge", name: name ? `${name.slice(0, 57)} import` : "Imported prompts" };
  const element = el("div", "krc-options-host");
  const destination = profileControl({ label: "Destination profile", follow: false, variant: "modal", value: () => state.id,
    onChange: value => { state.id = value; onChange(); } });
  const nameRow = el("div", "krc-modal-field");
  const nameInput = el("input", "krc-modal-select", { type: "text", value: state.name, maxLength: 64, placeholder: "Profile name" });
  nameInput.setAttribute("aria-label", "New profile name");
  nameInput.addEventListener("input", () => { state.name = nameInput.value; onChange(); });
  nameRow.append(el("span", "krc-modal-field-label", { textContent: "New profile name" }), nameInput);
  const actionRow = el("div", "krc-modal-field");
  actionRow.append(el("span", "krc-modal-field-label", { textContent: "Import" }), menuSelect({
    className: "krc-modal-select", title: "How to import the prompts", value: state.action,
    options: [["merge", "Merge with active profile"], ["replace", "Overwrite active profile completely"], ["new", "Import as new profile"]],
    onChange: value => { state.action = value; sync(); onChange(); } }));
  const description = el("div", "krc-options-description");
  const sync = () => {
    destination.hidden = state.action === "new";
    nameRow.hidden = state.action !== "new";
    description.textContent = state.action === "replace"
      ? "Replaces every prompt and category in the destination profile. Other profiles stay unchanged. Undo is available after import."
      : state.action === "new" ? "Creates a separate profile. Existing profiles stay unchanged; model presets remain shared."
        : "Adds new prompts and fills empty fields. Existing edits and prompt identities are kept.";
  };
  element.append(actionRow, destination, nameRow, description);
  sync();
  return { element, state, valid: () => state.action === "new" ? !!state.name.trim() : profileExists(state.id) };
}
