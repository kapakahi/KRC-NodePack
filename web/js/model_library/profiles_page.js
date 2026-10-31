import { el } from "../shared/dom.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { openKrcModal } from "../shared/modal.js";
import { apiPost } from "../prompt_vault/api.js";
import { loadProfiles, profileControl, profileChoice, setProfileChoice, watchProfiles } from "../prompt_vault/profiles.js";
import { infoPageSection } from "./info_page.js";

export function profileOptionsSection() {
  return infoPageSection("Prompt profiles", ["global", "portal"].map(kind => profileControl({
    label: kind === "global" ? "Global Profile" : "Portal Profile", follow: kind !== "global",
    value: () => profileChoice(kind), onChange: id => setProfileChoice(kind, id),
  })));
}

export const profilesPageMethods = {
  openProfilesPage() { this.openInfoPage("profiles"); },
  renderProfilesPage() {
    const { panel, body } = this.infoPageShell("Profiles", "krc-options-page");
    body.classList.add("krc-options-host");
    const status = el("div", "krc-options-description", { textContent: "Manage profiles for Prompt Vault." });
    const list = el("div");
    const create = el("button", "krc-options-reset", { type: "button", textContent: "Create profile" });
    const save = async (id, name) => {
      const result = await apiPost("/profiles/save", { id, name });
      if (!result?.success) throw new Error(result?.error || "Could not save profile.");
      await loadProfiles({ force: true });
    };
    const edit = profile => {
      const input = el("input", "krc-setting-input", { type: "text", value: profile?.name || "", maxLength: 64, placeholder: "Profile name" });
      const note = el("div", "krc-options-description");
      const button = el("button", "krc-options-reset", { type: "button", textContent: "SAVE" });
      const modal = openKrcModal({ node: this.node, title: profile ? "Rename profile" : "Create profile", body: [input, note, button] });
      button.addEventListener("click", async () => {
        button.disabled = true;
        try { await save(profile?.id, input.value.trim()); modal.close(); }
        catch (error) { note.textContent = error.message; button.disabled = false; }
      });
    };
    const remove = profile => {
      const note = el("div", "krc-options-description", { textContent: `Delete “${profile.name}” and its ${profile.promptCount} prompts? Workflow references will become missing; their loaded content is preserved. Shared model presets are untouched.` });
      const button = el("button", "krc-options-reset is-danger", { type: "button", textContent: "DELETE" });
      const modal = openKrcModal({ node: this.node, title: "Delete profile", body: [note, button] });
      armConfirmButton(button, { armedText: "CONFIRM DELETE", onConfirm: async () => {
        button.disabled = true;
        const result = await apiPost("/profiles/delete", { id: profile.id, confirmed: true });
        if (!result?.success) { note.textContent = result?.error || "Could not delete profile."; button.disabled = false; return; }
        await loadProfiles({ force: true }); modal.close();
      } });
    };
    create.addEventListener("click", () => edit(null));
    body.append(infoPageSection("", status, create), list);
    const render = async () => {
      const profiles = await loadProfiles();
      if (!panel.isConnected) return;
      list.replaceChildren(...profiles.map(profile => {
        const row = el("div", "krc-setting-head");
        row.append(el("span", "krc-setting-label", { textContent: `${profile.name} · ${profile.promptCount} prompts` }));
        if (profile.id === "default") row.append(el("span", "krc-options-description", { textContent: "Permanent" }));
        else {
          const rename = el("button", "krc-options-reset", { type: "button", textContent: "Rename" });
          const del = el("button", "krc-options-reset", { type: "button", textContent: "Delete" });
          rename.addEventListener("click", () => edit(profile)); del.addEventListener("click", () => remove(profile));
          row.append(rename, del);
        }
        return infoPageSection("", row);
      }));
    };
    // One page subscription per panel; no rebuilds on profile-choice changes.
    this._profilesPageOff?.();
    this._profilesPageOff = watchProfiles(() => { if (panel.isConnected) render(); else { this._profilesPageOff?.(); this._profilesPageOff = null; } });
    loadProfiles({ force: true }).then(render);
    return panel;
  },
};
