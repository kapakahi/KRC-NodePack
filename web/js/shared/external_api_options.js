/*
 * External API's global switches (KRC Portal ▸ API, top) and the Options ▸ Network shortcut
 * to that page. The switch, off until turned on; while it's on: Read only (on until turned
 * off; it blocks every app write), then one switch per permission area, each off until
 * turned on, drawn from the server's registry (state.areas, ext_api.WRITE_AREAS). API
 * profiles and their keys are on the same page (model_library/api_page.js). The server is
 * the source of truth (krc.db settings): read when the page opens, written straight back
 * through /krc/ext-api/*.
 */
import { el } from "./dom.js";
import { makeNodeApi } from "./api.js";
import { switchToggle } from "./browser_controls.js";
import { openKrcAlert } from "./modal.js";

const { fetchLora, postLoraJson } = makeNodeApi("/krc/ext-api");

const LABEL = "External API";
const GLOBAL_DESCRIPTION = "Lets other apps use KRC with a key from an API profile below. These switches cover every profile: a profile can be allowed less, never more. Apps can't change anything while Read only is on.";
const SHORTCUT_DESCRIPTION = "Apps that use KRC (such as KRC LegitComfy): the switches, API profiles and their keys are on KRC Portal's API page.";
const READ_ONLY_DESCRIPTION = "On: apps can only read, whatever is allowed below. Turn it off to let apps make the changes you allow. Turning it on never undoes or stops anything already done.";

// → the server state {enabled, readOnly, areas, …} or null; a refused POST -> null.
async function readState(path = "/state", body = undefined) {
  try {
    const response = body === undefined ? await fetchLora(path, { cache: "no-store" }) : await postLoraJson(path, body);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// The write switches, under the key while the API is on: Read only, then each permission
// area. The area switches stay editable while Read only is on (they take effect once it's
// off) and say so.
function renderWrites(host, state, apply) {
  host.replaceChildren();
  if (!state?.enabled) return;
  const rows = [
    { label: "Read only", description: READ_ONLY_DESCRIPTION, on: Boolean(state.readOnly), area: false,
      send: (next) => readState("/read-only", { enabled: next }) },
    ...(Array.isArray(state.areas) ? state.areas : []).map((entry) => ({
      label: entry.label, description: entry.description, on: Boolean(entry.enabled), area: true,
      send: (next) => readState("/area", { area: entry.id, enabled: next }),
    })),
  ];
  for (const row of rows) {
    const toggle = switchToggle({
      active: row.on,
      title: row.label,
      onClick: async () => {
        const next = !row.on;
        toggle.classList.toggle("is-on", next);
        const result = await row.send(next);
        if (!result) {
          toggle.classList.toggle("is-on", row.on);
          await openKrcAlert({ title: row.label, message: "The server didn't take the change, so it stays as it was." });
          return;
        }
        apply(result);
      },
    });
    const head = el("div", "krc-setting-head krc-ext-api-writes");
    head.append(el("span", "krc-setting-label", { textContent: row.label }), toggle);
    const waiting = row.area && state.readOnly;
    const note = waiting ? " (Read only is on, so this waits until it's off.)" : "";
    if (waiting) head.classList.add("is-waiting");
    host.append(head, el("div", "krc-options-description krc-setting-desc", { textContent: (row.description || "") + note }));
  }
}

// KRC Portal ▸ API's global block (2026-11-09): the External API switch, then (while it's
// on) Read only and each permission area. These are the install-wide switches: every API
// profile's own permissions sit under them and never get past them. Keys live with their
// profiles now (model_library/api_page.js), so there's no key row here.
export function globalApiSection({ onChange } = {}) {
  const wrap = el("div", "krc-setting-row");
  wrap.dataset.setting = "KRC.ExternalApi";
  const writesHost = el("div", "krc-ext-api-writes-host");
  let state = null;
  const toggle = switchToggle({
    active: false,
    title: LABEL,
    onClick: async () => {
      if (!state) return;
      const next = !state.enabled;
      toggle.classList.toggle("is-on", next);
      const result = await readState("/consent", { enabled: next });
      if (!result) {
        toggle.classList.toggle("is-on", state.enabled);
        await openKrcAlert({ title: LABEL, message: "The server didn't take the change, so External API stays as it was." });
        return;
      }
      apply(result);
    },
  });
  const apply = (next) => {
    state = next;
    toggle.classList.toggle("is-on", !!state.enabled);
    renderWrites(writesHost, state, apply);
    onChange?.(state);
  };
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: LABEL }), toggle);
  wrap.append(head, el("div", "krc-options-description krc-setting-desc", { textContent: GLOBAL_DESCRIPTION }), writesHost);
  readState().then((loaded) => {
    if (loaded) apply(loaded);
    else writesHost.replaceChildren(el("div", "krc-options-description", { textContent: "Couldn't read the External API setting from the server." }));
  });
  return wrap;
}

// Options ▸ Network: a shortcut to KRC Portal ▸ API, where the switches, profiles and keys are.
export function externalApiRow({ openApiPage } = {}) {
  const wrap = el("div", "krc-setting-row");
  wrap.dataset.setting = "KRC.ExternalApi";
  const status = el("span", "krc-options-description", { textContent: "…" });
  const open = el("button", "krc-options-reset", { type: "button", textContent: "Open API page" });
  open.addEventListener("click", () => openApiPage?.());
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: LABEL }), status, open);
  wrap.append(head, el("div", "krc-options-description krc-setting-desc", { textContent: SHORTCUT_DESCRIPTION }));
  readState().then((loaded) => {
    status.textContent = !loaded ? "" : loaded.enabled ? (loaded.readOnly ? "On · read only" : "On") : "Off";
  });
  return wrap;
}
