// Browser-local choices, workflow-local overrides, one shared profile registry.
import { api } from "../../../scripts/api.js";
import { menuSelect } from "../shared/browser_controls.js";
import { el } from "./dom.js";
import { apiGet } from "./api.js";

export const DEFAULT_PROFILE = "default";
export const FOLLOW_GLOBAL = "global";
const keys = { global: "krc.promptProfile.global", portal: "krc.promptProfile.portal" };
let profiles = [{ id: DEFAULT_PROFILE, name: "Default", promptCount: 0 }];
let loaded = false;
let pending = null;
let refreshQueued = false;
const listeners = new Set();
const controls = new Set();
const read = key => { try { return localStorage.getItem(key); } catch { return null; } };
export const profileChoice = kind => read(keys[kind]) || (kind === "global" ? DEFAULT_PROFILE : FOLLOW_GLOBAL);
export const effectiveProfile = override => !override || override === FOLLOW_GLOBAL ? profileChoice("global") : override;
export const profileName = id => profiles.find(profile => profile.id === id)?.name || "Missing profile";
export const profileExists = id => !loaded || profiles.some(profile => profile.id === id);
export const profileSnapshot = () => profiles;

function changed() {
  for (const control of [...controls]) {
    if (!control.isConnected) controls.delete(control);
    else control.renderProfile();
  }
  for (const listener of listeners) listener();
}
export function setProfileChoice(kind, id) {
  try { localStorage.setItem(keys[kind], id); } catch { /* storage unavailable */ }
  changed();
}
export function watchProfiles(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function loadProfiles({ force = false } = {}) {
  if (pending) { refreshQueued ||= force; return pending; }
  if (loaded && !force) return Promise.resolve(profiles);
  pending = apiGet("/profiles").then(data => {
    if (!Array.isArray(data?.profiles)) return profiles;
    profiles = data.profiles;
    loaded = true;
    // Browser defaults recover to Default / Global (default). Workflow overrides remain
    // explicit missing ids, preserving their content and requiring a destination.
    for (const kind of ["global", "portal"]) {
      const choice = profileChoice(kind);
      if (choice !== FOLLOW_GLOBAL && !profileExists(choice)) {
        try { localStorage.setItem(keys[kind], kind === "global" ? DEFAULT_PROFILE : FOLLOW_GLOBAL); } catch { /* storage unavailable */ }
      }
    }
    changed();
    return profiles;
  }).finally(() => {
    pending = null;
    if (refreshQueued) { refreshQueued = false; return loadProfiles({ force: true }); }
  });
  return pending;
}

// The follow-Global choice reads like the node palette's inherit option.
export const FOLLOW_GLOBAL_LABEL = "Global (default)";

// variant "page": a Portal Options page row; "modal": an Options / import dialog field
// (krc-modal-field, like the node palette picker).
export function profileControl({ label = "Profile", value, onChange, follow = true, variant = "page" } = {}) {
  // Browser refreshes replace these rows frequently; retain only live controls.
  for (const control of controls) if (!control.isConnected) controls.delete(control);
  const modal = variant === "modal";
  const row = el("div", modal ? "krc-modal-field" : "krc-setting-row");
  row.renderProfile = () => {
    const current = value();
    const options = profiles.map(profile => [profile.id, profile.name]);
    if (follow) options.unshift([FOLLOW_GLOBAL, FOLLOW_GLOBAL_LABEL]);
    if (!options.some(([id]) => id === current)) options.push([current, "Missing profile"]);
    const select = menuSelect({
      className: modal ? "krc-modal-select" : "krc-setting-select krc-browser-select", title: label, value: current, options,
      align: "right", onChange,
    });
    if (modal) {
      row.replaceChildren(el("span", "krc-modal-field-label", { textContent: label }), select);
      return;
    }
    const head = el("div", "krc-setting-head");
    head.append(el("span", "krc-setting-label", { textContent: label }), select);
    row.replaceChildren(head);
  };
  controls.add(row);
  row.renderProfile();
  loadProfiles().then(() => row.renderProfile());
  return row;
}

window.addEventListener("storage", event => {
  if (Object.values(keys).includes(event.key)) changed();
});
api.addEventListener("krc-prompt-profiles-changed", () => { loadProfiles({ force: true }); });

export const profileMethods = {
  profileOverride() {
    return this.surface === "detached" ? profileChoice("portal") : this.node.properties?.pmProfile || FOLLOW_GLOBAL;
  },
  effectiveProfileId() { return effectiveProfile(this.profileOverride()); },
  profileMissing() { return !profileExists(this.effectiveProfileId()); },
  profileMismatch() {
    const owner = this.orig?.profileId || this.draft?.profileId;
    return !!this.orig && !!owner && owner !== this.effectiveProfileId();
  },
  renderProfileControl() {
    const wrap = el("div", "krc-options-host");
    wrap.append(profileControl({ variant: "modal", label: "Node profile", value: () => this.profileOverride(), onChange: id => {
      if (this.surface === "detached") setProfileChoice("portal", id);
      else {
        this.setSerializableProperty("pmProfile", id);
        this.markCanvasDirty();
        this.updateProfile();
      }
    } }));
    if (this.profileMissing()) wrap.append(el("div", "krc-options-description", {
      textContent: "Missing profile. Choose a profile before saving. Loaded content is preserved.",
    }));
    else if (this.profileMismatch()) wrap.append(el("div", "krc-options-description", {
      textContent: `Loaded from “${profileName(this.orig?.profileId || this.draft?.profileId)}”. SAVE a copy here, or DISCARD to clear.`,
    }));
    return wrap;
  },
  async updateProfile() {
    const next = this.effectiveProfileId();
    if (next === this._profileId) { this.refreshBrowserPanel({ keepChips: true }); return; }
    this._profileId = next;
    // Keep the editor and its reference, but never select an unrelated same-name card.
    this.selKey = null;
    this.activeCategory = "__all__";
    this.categoryEditor = null;
    this._browserSelectionUI?.endForEdit?.();
    this._selectRequestKey = null;
    await this.loadPromptLibrary({ force: true });
    if (this._destroyed || next !== this.effectiveProfileId()) return;
    const item = this.items.find(item => item.id === this.draft?.id);
    if (item) this.selKey = this.itemKey(item);
    this.syncWidgetsFromDraft();
    this.refreshAll({ preserveScroll: true });
  },
};
