/*
 * KRC Portal ▸ API (2026-11-09; KRC_EXTERNAL_API.md "API profiles"): the external API's
 * administration. Local Portal only: an API client can't reach any of this (the routes are
 * same-site /krc/ext-api/*, never ext/v1). Whoever can open KRC Portal can manage it:
 * ComfyUI has no login, so this page is as protected as ComfyUI itself.
 *
 *   Global     External API, Read only, write areas (shared/external_api_options.js):
 *              install-wide; a profile is allowed less, never more.
 *   Profiles   one row per API profile (name, Enabled / Disabled, Recently active · Last
 *              used · Never used), + New profile. Click a row to edit it below:
 *   Profile    name, enabled; its one key (…hint; Create / Regenerate, shown once with
 *              Copy; regenerating ends the old key at once); write areas;
 *              capabilities; file sources; resources per kind (All / Selected / None,
 *              read or write, may make new ones, the default for new things, the picked
 *              items); usage and the client's own (unverified) label; Delete profile.
 *
 * Every change is sent at once and the page redraws from the server's answer.
 */
import { el } from "../shared/dom.js";
import { makeNodeApi } from "../shared/api.js";
import { menuSelect, switchToggle } from "../shared/browser_controls.js";
import { copyText } from "../shared/clipboard.js";
import { openKrcAlert, openKrcConfirm, openKrcModal } from "../shared/modal.js";
import { showToast } from "../shared/toast.js";
import { globalApiSection } from "../shared/external_api_options.js";
import { infoPageSection } from "./info_page.js";

export const API_PAGE = "api";
const { fetchLora, postLoraJson } = makeNodeApi("/krc/ext-api");

const MODE_OPTIONS = [["all", "All"], ["selected", "Selected"], ["none", "None"]];
const LEVEL_OPTIONS = [["read", "Read"], ["write", "Read/Write"]];
const ITEM_OPTIONS = [["", "No access"], ["read", "Read"], ["write", "Read/Write"]];
const BOUNDARY = "A profile is whoever holds its key: it isn't a login. It limits what apps can do through the API, not the ComfyUI page, its other routes, files on disk or workflows that run. Keep ComfyUI where only people you trust can reach it; to keep people apart, let them reach KRC only through an app (such as KRC LegitComfy) that holds their key.";

async function getJson(path) {
  try {
    const response = await fetchLora(path, { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// -> [answer, null] or [null, message]
async function post(path, body = {}) {
  try {
    const response = await postLoraJson(path, body);
    const answer = await response.json().catch(() => ({}));
    return response.ok ? [answer, null] : [null, answer?.message || answer?.error || `HTTP ${response.status}`];
  } catch (error) {
    return [null, String(error?.message || error)];
  }
}

function timeAgo(ms) {
  if (!ms) return "Never used";
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "Last used just now";
  if (minutes < 60) return `Last used ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last used ${hours} h ago`;
  return `Last used ${new Date(ms).toLocaleDateString()}`;
}

function activityText(usage) {
  if (usage?.activity === "recent") return "Recently active";
  return timeAgo(usage?.lastUsed);
}

function textInput(value, placeholder, maxLength) {
  const input = el("input", "krc-setting-input", { type: "text", value, placeholder, maxLength, spellcheck: false });
  input.addEventListener("keydown", (event) => event.stopPropagation());
  return input;
}

// A new key: shown once, with Copy.
function showNewKey(node, key) {
  const field = textInput(key, "", 200);
  field.readOnly = true;
  const copy = el("button", "krc-options-reset", { type: "button", textContent: "Copy" });
  copy.addEventListener("click", async () => {
    showToast(await copyText(key) ? "Key copied." : "Couldn't copy; select the key and copy it by hand.");
  });
  openKrcModal({ node, title: "New key", body: [
    field, copy,
    el("div", "krc-options-description krc-options-warning", { textContent: "Copy it now: KRC won't show it again. Lost it? Regenerate it." }),
  ] });
}

// Asks for a name. -> the name, or null.
function askName(node, title, value, placeholder) {
  return new Promise((resolve) => {
    const input = textInput(value, placeholder, 60);
    const note = el("div", "krc-options-description");
    const save = el("button", "krc-options-reset", { type: "button", textContent: "SAVE" });
    let done = false;
    const modal = openKrcModal({ node, title, body: [input, note, save], onClose: () => { if (!done) resolve(null); } });
    save.addEventListener("click", () => {
      const name = input.value.trim();
      if (!name) { note.textContent = "A name can't be empty."; return; }
      done = true;
      resolve(name);
      modal.close();
    });
  });
}

function sectionRow(label, ...controls) {
  const row = el("div", "krc-setting-head");
  row.append(el("span", "krc-setting-label", { textContent: label }), ...controls);
  return row;
}

function description(text) {
  return el("div", "krc-options-description krc-setting-desc", { textContent: text });
}

export const apiPageMethods = {
  openApiPage() { this.openInfoPage(API_PAGE); },

  renderApiPage() {
    const { panel, body } = this.infoPageShell("API", "krc-options-page");
    body.classList.add("krc-options-host");
    const node = this.node;
    const list = el("div");
    const editor = el("div");
    let profiles = [];
    let resources = null;
    let selected = this._apiSelected || "";

    const fail = (title, message) => openKrcAlert({ title, message: message || "The server didn't take the change." });

    const load = async () => {
      const [answer, found] = await Promise.all([getJson("/profiles"), resources ? resources : getJson("/resources")]);
      resources = found;
      if (!panel.isConnected) return;
      if (!answer) {
        list.replaceChildren(description("Couldn't read the API profiles from the server."));
        return;
      }
      profiles = answer.profiles || [];
      if (!profiles.some((profile) => profile.id === selected)) selected = profiles[0]?.id || "";
      this._apiSelected = selected;
      drawList();
      drawEditor();
    };

    // Run an admin action, then redraw from the server. -> the answer, or null.
    const act = async (title, path, payload) => {
      const [answer, message] = await post(path, payload);
      if (!answer) { await fail(title, message); return null; }
      await load();
      return answer;
    };

    const drawList = () => {
      const add = el("button", "krc-options-reset", { type: "button", textContent: "New profile" });
      add.addEventListener("click", async () => {
        const name = await askName(node, "New API profile", "", "e.g. Studio tablet");
        if (!name) return;
        const made = await act("New API profile", "/profiles/create", { name });
        if (made?.id) { selected = made.id; this._apiSelected = selected; await load(); }
      });
      const rows = profiles.map((profile) => {
        const row = el("button", `krc-setting-head krc-api-profile-row${profile.id === selected ? " is-selected" : ""}`, { type: "button" });
        row.append(
          el("span", "krc-setting-label", { textContent: profile.name }),
          el("span", "krc-options-description", { textContent: `${profile.enabled ? "Enabled" : "Disabled"} · ${activityText(profile.usage)}` }),
        );
        row.addEventListener("click", () => { selected = profile.id; this._apiSelected = selected; drawList(); drawEditor(); });
        return row;
      });
      list.replaceChildren(infoPageSection("API profiles", description(BOUNDARY), ...rows, add));
    };

    const drawEditor = () => {
      const profile = profiles.find((entry) => entry.id === selected);
      if (!profile) { editor.replaceChildren(); return; }
      const base = `/profiles/${encodeURIComponent(profile.id)}`;
      const policy = profile.policy;
      const savePolicy = (next) => act("Save the profile", `${base}/update`, { policy: next });

      // ---- name, enabled, delete
      const rename = el("button", "krc-options-reset", { type: "button", textContent: "Rename" });
      rename.addEventListener("click", async () => {
        const name = await askName(node, "Rename API profile", profile.name, "Profile name");
        if (name && name !== profile.name) await act("Rename", `${base}/update`, { name });
      });
      const enabled = switchToggle({ active: profile.enabled, title: "Enabled", onClick: () => act("Enable", `${base}/update`, { enabled: !profile.enabled }) });
      const remove = el("button", "krc-options-reset is-danger", { type: "button", textContent: "Delete profile…" });
      remove.addEventListener("click", async () => {
        const ok = await openKrcConfirm({ title: "Delete API profile", danger: true, confirmLabel: "Delete",
          message: `“${profile.name}” and its key stop working at once. Its prompts, presets and media stay.` });
        if (ok) await act("Delete", `${base}/delete`, {});
      });
      const head = infoPageSection(profile.name,
        sectionRow("Enabled", enabled),
        description("Disabled: its key is refused at once; enabling the profile again brings it back."),
        sectionRow(`Id ${profile.id}`, rename),
        sectionRow(activityText(profile.usage), el("span", "krc-options-description", {
          textContent: profile.usage?.label ? `Client says: “${profile.usage.label}” (unverified)` : "",
        })),
        description("Recently active = a request within the last 15 minutes. Shown from requests KRC accepted; it doesn't mean an app is connected now."),
        remove);

      // ---- its key (one per profile)
      const makeKey = el("button", `krc-options-reset${profile.key ? " is-danger" : ""}`, { type: "button",
        textContent: profile.key ? "Regenerate…" : "Create key" });
      makeKey.addEventListener("click", async () => {
        if (profile.key) {
          const ok = await openKrcConfirm({ title: "Regenerate key", danger: true, confirmLabel: "Regenerate",
            message: `The current key of “${profile.name}” stops working at once, along with its file links. Give the app the new key.` });
          if (!ok) return;
        }
        const answer = await act("Key", `${base}/key`, {});
        if (answer?.key) showNewKey(node, answer.key);
      });
      const keys = infoPageSection("Key",
        sectionRow(profile.key ? `•••• ${profile.key.hint}` : "No key yet", makeKey),
        description("Give this key to the app. KRC shows it once and keeps only a fingerprint of it."));

      // ---- write areas, capabilities, file sources
      const areas = (resources?.writeAreas || []).map((area) => {
        const all = policy.writeAreas === "all";
        const on = all || policy.writeAreas.includes(area.id);
        return sectionRow(area.label, switchToggle({ active: on, title: area.label, onClick: () => {
          const current = all ? (resources.writeAreas || []).map((entry) => entry.id) : [...policy.writeAreas];
          savePolicy({ ...policy, writeAreas: on ? current.filter((id) => id !== area.id) : [...current, area.id] });
        } }));
      });
      const writes = infoPageSection("Write permissions",
        description("The areas this profile may write to. The global switches above apply first: while Read only is on, no writes are accepted."),
        ...areas);
      const allCaps = policy.capabilities === "all";
      const capRows = allCaps ? [] : (resources?.capabilities || []).map((cap) => {
        const on = policy.capabilities.includes(cap);
        return sectionRow(cap, switchToggle({ active: on, title: cap, onClick: () => savePolicy({ ...policy,
          capabilities: on ? policy.capabilities.filter((id) => id !== cap) : [...policy.capabilities, cap] }) }));
      });
      const features = infoPageSection("Features",
        sectionRow("Every feature", switchToggle({ active: allCaps, title: "Every feature", onClick: () => savePolicy({ ...policy,
          capabilities: allCaps ? ["info"] : "all" }) })),
        description("Off: only the features switched on below (by capability name). New features KRC adds later need switching on."),
        ...capRows,
        sectionRow("ComfyUI files by name", switchToggle({ active: Boolean(policy.fileSources), title: "ComfyUI files by name",
          onClick: () => savePolicy({ ...policy, fileSources: !policy.fileSources }) })),
        description("Lets the profile preview Load Image files by their name (input / output folders). Leave off to limit it to Media."));

      // ---- resources: one row per kind (its name and access side by side); a kind set to
      // Selected lists its picks, indented, under its row.
      const sub = (row) => { row.classList.add("krc-api-subrow"); return row; };
      const scopeRows = (resources?.scopes || []).flatMap((scope) => {
        const entry = policy.scopes[scope.name] || policy.scopes["*"] || { mode: "none", level: "read", items: {}, default: "", create: false };
        const save = (patch) => savePolicy({ ...policy, scopes: { ...policy.scopes, [scope.name]: { ...entry, ...patch } } });
        const controls = [menuSelect({ className: "krc-setting-select krc-api-select", title: scope.label, value: entry.mode,
          options: MODE_OPTIONS, align: "right", onChange: (mode) => save({ mode }) })];
        if (entry.mode === "all") {
          controls.push(menuSelect({ className: "krc-setting-select krc-api-select", title: `${scope.label}: access level`, value: entry.level,
            options: LEVEL_OPTIONS, align: "right", onChange: (level) => save({ level }) }));
        }
        const rows = [sectionRow(scope.label, ...controls)];
        if (entry.mode === "selected") {
          rows.push(sub(sectionRow("May create new", switchToggle({ active: Boolean(entry.create), title: "May create new",
            onClick: () => save({ create: !entry.create }) }))));
          for (const item of scope.items) {
            rows.push(sub(sectionRow(item.label || item.id, menuSelect({ className: "krc-setting-select krc-api-select", title: item.label, value: entry.items[item.id] || "",
              options: ITEM_OPTIONS, align: "right", onChange: (level) => {
                const items = { ...entry.items };
                if (level) items[item.id] = level; else delete items[item.id];
                save({ items });
              } }))));
          }
        }
        if (entry.mode !== "none" && ["prompts", "mediaFolders"].includes(scope.name)) {
          rows.push(sub(sectionRow("Default destination", menuSelect({ className: "krc-setting-select krc-api-select", title: "Default destination", value: entry.default || "",
            options: [["", "(automatic)"], ...scope.items.map((item) => [item.id, item.label || item.id])], align: "right",
            onChange: (value) => save({ default: value }) }))));
        }
        return rows;
      });
      const scopeSections = [infoPageSection("Resource access",
        description("All: everything of that kind, including what's added later. Selected: only the picks below it, plus what this profile creates itself. None: nothing."),
        ...scopeRows)];
      editor.replaceChildren(head, keys, writes, features, ...scopeSections);
    };

    body.append(infoPageSection("Global", globalApiSection({ onChange: () => { if (panel.isConnected) load(); } })), list, editor);
    load();
    return panel;
  },
};
