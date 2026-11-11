/*
 * KRC Portal ▸ API (2026-11-09; KRC_EXTERNAL_API.md "API profiles"): the external API's
 * administration. Local Portal only: an API client can't reach any of this (the routes are
 * same-site /krc/ext-api/*, never ext/v1). Whoever can open KRC Portal can manage it:
 * ComfyUI has no login, so this page is as protected as ComfyUI itself.
 *
 *   Global     External API, Read only, write areas (shared/external_api_options.js):
 *              install-wide; a profile is allowed less, never more.
 *   Profiles   one row per API profile: name, rename, activity (Recently active · Last
 *              used · Never used, plus the app's unverified label) on the left; its key's
 *              hint, REGENERATE / CREATE KEY (shown once, with Copy), delete and the
 *              enabled switch on the right. Then NEW PROFILE. Click a row to edit below:
 *   Profile    Access: one row per kind, grouped, one dropdown each (None / Read /
 *              Read/Write; Prompt Vault profiles and Media folders also Selected, with their
 *              picks and default destination under the row; ComfyUI images with Media).
 *              Every profile may use every API feature; what it may write follows from
 *              Read/Write.
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

const ACCESS_OPTIONS = [["read", "Read"], ["write", "Read/Write"]];
const ITEM_OPTIONS = [["", "No access"], ["read", "Read"], ["write", "Read/Write"]];
const BOUNDARY = "A profile is whoever holds its key. It limits apps using the API, not ComfyUI itself: keep ComfyUI where only people you trust can reach it.";

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

// Icon buttons: a symmetric inline SVG drawn as a 12px block (never a text glyph).
const GLYPHS = {
  pencil: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
};

function glyphButton(kind, title, onClick, extra = "") {
  const button = el("button", `krc-api-glyph${extra ? ` ${extra}` : ""}`, { type: "button", title });
  button.setAttribute("aria-label", title);
  button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPHS[kind]}</svg>`;
  button.addEventListener("click", (event) => { event.stopPropagation(); onClick(); });
  return button;
}

// Resource access groups: related kinds side by side (Prompt Vault prompts with the presets
// they link to; Media folders with Media presets). Each kind keeps its own access.
const SCOPE_GROUPS = [
  { label: "Prompts and loadouts", test: (name) => name === "prompts" || name === "presets.ll" || name.startsWith("presets.kit:") },
  { label: "Media", test: (name) => name === "mediaFolders" || name === "presets.media" },
  { label: "Models and other presets", test: () => true },
];

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

    // One row per profile: name, rename, activity on the left; its key's hint, REGENERATE
    // (or CREATE KEY), delete and the enabled switch on the right. Click a row to edit its
    // permissions below.
    const drawList = () => {
      const rows = profiles.map((profile) => {
        const base = `/profiles/${encodeURIComponent(profile.id)}`;
        const row = el("div", `krc-setting-head krc-api-profile-row${profile.id === selected ? " is-selected" : ""}${profile.enabled ? "" : " is-disabled"}`);
        const rename = glyphButton("pencil", "Rename", async () => {
          const name = await askName(node, "Rename API profile", profile.name, "Profile name");
          if (name && name !== profile.name) await act("Rename", `${base}/update`, { name });
        });
        const label = profile.usage?.label ? ` · ${profile.usage.label}` : "";
        const left = el("span", "krc-api-profile-left");
        left.append(el("span", "krc-setting-label", { textContent: profile.name }), rename,
          el("span", "krc-api-activity", { textContent: activityText(profile.usage) + label,
            title: "Recently active = a request in the last 15 minutes. It doesn't mean an app is connected now. The app's label is unverified." }));
        const makeKey = el("button", "krc-options-reset", { type: "button", textContent: profile.key ? "REGENERATE" : "CREATE KEY" });
        makeKey.addEventListener("click", async (event) => {
          event.stopPropagation();
          if (profile.key) {
            const ok = await openKrcConfirm({ title: "Regenerate key", danger: true, confirmLabel: "Regenerate",
              message: `The current key of “${profile.name}” stops working at once, along with its file links. Give the app the new key.` });
            if (!ok) return;
          }
          const answer = await act("Key", `${base}/key`, {});
          if (answer?.key) showNewKey(node, answer.key);
        });
        const remove = glyphButton("trash", "Delete profile", async () => {
          const ok = await openKrcConfirm({ title: "Delete API profile", danger: true, confirmLabel: "Delete",
            message: `“${profile.name}” and its key stop working at once. Its prompts, presets and media stay.` });
          if (ok) await act("Delete", `${base}/delete`, {});
        }, "is-danger");
        const toggle = switchToggle({ active: profile.enabled, title: profile.enabled ? "Enabled: click to disable (its key is refused at once)" : "Disabled: click to enable",
          onClick: () => act("Enable", `${base}/update`, { enabled: !profile.enabled }) });
        toggle.addEventListener("click", (event) => event.stopPropagation());
        const right = el("span", "krc-api-profile-right");
        right.append(...(profile.key ? [el("span", "krc-api-key-hint", { textContent: `••••${profile.key.hint}` })] : []), makeKey, remove, toggle);
        row.append(left, right);
        row.addEventListener("click", () => { selected = profile.id; this._apiSelected = selected; drawList(); drawEditor(); });
        return row;
      });
      const add = el("button", "krc-options-reset", { type: "button", textContent: "NEW PROFILE" });
      add.addEventListener("click", async () => {
        const name = await askName(node, "New API profile", "", "e.g. Studio tablet");
        if (!name) return;
        const made = await act("New API profile", "/profiles/create", { name });
        if (made?.id) { selected = made.id; this._apiSelected = selected; await load(); }
      });
      const addRow = el("div", "krc-setting-head krc-api-add-row");
      addRow.append(add);
      list.replaceChildren(infoPageSection("API profiles", description(BOUNDARY), ...rows, addRow));
    };

    // The open profile's access: one row per kind with one dropdown (None / Read /
    // Read/Write; Prompt Vault profiles and Media folders also Selected, which lists their
    // picks under the row). What it may write follows from Read/Write here.
    const drawEditor = () => {
      const profile = profiles.find((entry) => entry.id === selected);
      if (!profile) { editor.replaceChildren(); return; }
      const base = `/profiles/${encodeURIComponent(profile.id)}`;
      const policy = profile.policy;
      // Every profile may use every API feature (no per-feature list on this page).
      const savePolicy = (next) => act("Save the profile", `${base}/update`, { policy: { ...next, capabilities: "all" } });
      const sub = (row) => { row.classList.add("krc-api-subrow"); return row; };
      const select = (title, value, options, onChange) => menuSelect({ className: "krc-setting-select krc-api-select", title, value,
        options, align: "right", onChange });
      const scopeRowsFor = (scope) => {
        const entry = policy.scopes[scope.name] || policy.scopes["*"] || { mode: "none", level: "read", items: {}, default: "" };
        const save = (patch) => savePolicy({ ...policy, scopes: { ...policy.scopes, [scope.name]: { ...entry, ...patch } } });
        const options = [["none", "None"], ...ACCESS_OPTIONS.filter(([level]) => (scope.levels || ["read", "write"]).includes(level)),
          ...(scope.picks ? [["selected", "Selected"]] : [])];
        const value = entry.mode === "all" ? (scope.levels?.includes(entry.level) ? entry.level : "read") : entry.mode;
        const rows = [sectionRow(scope.label, select(scope.label, value, options, (next) => {
          if (next === "none" || next === "selected") save({ mode: next });
          else save({ mode: "all", level: next });
        }))];
        if (scope.picks && entry.mode === "selected") {
          for (const item of scope.items || []) {
            rows.push(sub(sectionRow(item.label || item.id, select(item.label, entry.items[item.id] || "", ITEM_OPTIONS, (level) => {
              const items = { ...entry.items };
              if (level) items[item.id] = level; else delete items[item.id];
              save({ items });
            }))));
          }
        }
        if (scope.picks && entry.mode !== "none") {
          rows.push(sub(sectionRow("Default destination", select("Default destination", entry.default || "",
            [["", "(automatic)"], ...(scope.items || []).filter((item) => item.canDefault !== false)
              .map((item) => [item.id, item.label || item.id])],
            (next) => save({ default: next })))));
        }
        return rows;
      };
      const scopes = resources?.scopes || [];
      const placed = new Set();
      const rows = SCOPE_GROUPS.flatMap((group) => {
        const members = scopes.filter((scope) => !placed.has(scope.name) && group.test(scope.name));
        members.forEach((scope) => placed.add(scope.name));
        if (!members.length) return [];
        const groupRows = [el("div", "krc-api-group", { textContent: group.label }), ...members.flatMap(scopeRowsFor)];
        // ComfyUI images: Media's other source (Load Image files by name), so it sits with Media.
        if (group.label === "Media") {
          groupRows.push(sectionRow("ComfyUI images", switchToggle({ active: Boolean(policy.fileSources), title: "ComfyUI images",
            onClick: () => savePolicy({ ...policy, fileSources: !policy.fileSources }) })),
          description("Preview images from ComfyUI's input and output folders by file name, as a Load Image node does. Off: Media items only."));
        }
        return groupRows;
      });
      editor.replaceChildren(infoPageSection("Access",
        description("Read/Write lets the profile change what it can read (the global switches above still apply first). Selected: only the picks under it, plus what this profile creates itself."),
        ...rows));
    };

    body.append(infoPageSection("Global", globalApiSection({ onChange: () => { if (panel.isConnected) load(); } })), list, editor);
    load();
    return panel;
  },
};
