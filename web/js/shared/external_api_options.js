/*
 * External API: the row under Options ▸ Network (KRC_EXTERNAL_API_GAMEPLAN.md stages 1
 * and 16). The switch, off until turned on, and the access key apps need: shown once when
 * it's made (with Copy), afterwards only its last 4 characters, plus Make a new key. Under
 * it, while the API is on: Read only (on until turned off; it blocks every app write), then
 * one switch per permission area, each off until turned on, drawn from the server's
 * registry (state.areas, ext_api.WRITE_AREAS), so a new area needs no change here. The
 * server is the source of truth (krc.db settings), not a ComfyUI setting: it's read when the
 * page opens and written straight back through /krc/ext-api/*.
 */
import { el } from "./dom.js";
import { makeNodeApi } from "./api.js";
import { switchToggle } from "./browser_controls.js";
import { copyText } from "./clipboard.js";
import { openKrcAlert, openKrcConfirm } from "./modal.js";
import { showToast } from "./toast.js";

const { fetchLora, postLoraJson } = makeNodeApi("/krc/ext-api");

const LABEL = "External API";
const DESCRIPTION = "Lets other apps read your prompts, presets and libraries. They can't change anything unless you turn Read only off and allow an area below.";
const READ_ONLY_DESCRIPTION = "On: apps can only read, whatever is allowed below. Turn it off to let apps make the changes you allow. Turning it on never undoes or stops anything already done.";
const KEY_HELP = "Apps need this key to connect. KRC shows it only once, when it's made; lost it? Make a new key (that disconnects every app).";
const KEY_ONCE = "Copy it now: KRC won't show it again. Lost it? Make a new key.";

// → {enabled, hasKey, keyHint[, key]} or null; a refused POST -> null.
async function readState(path = "/state", body = undefined) {
  try {
    const response = body === undefined ? await fetchLora(path, { cache: "no-store" }) : await postLoraJson(path, body);
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function maskedKey(hint) {
  return hint ? `${"•".repeat(12)}${hint}` : "";
}

function keyField(value, label) {
  const field = el("input", "krc-setting-input", { type: "text", readOnly: true, value, spellcheck: false });
  field.setAttribute("aria-label", label);
  // Keys typed here (select, copy) must not reach ComfyUI's canvas shortcuts.
  field.addEventListener("keydown", (event) => event.stopPropagation());
  return field;
}

// The key row. The server never sends the key again after making it (stage 16), so the
// row shows its last 4 characters; `state.key` is there only in the answer that made it,
// and then the full key shows once, with Copy, until Done.
function renderKey(host, state, apply) {
  host.replaceChildren();
  if (!state?.enabled || !state.hasKey) return;
  const renew = el("button", "krc-options-reset", { type: "button", textContent: "New key…" });
  renew.addEventListener("click", async () => {
    const confirmed = await openKrcConfirm({
      title: "Make a new key",
      message: "Apps using the old key will stop working until you give them the new one.",
      confirmLabel: "Make a new key",
      danger: true,
    });
    if (!confirmed) return;
    const next = await readState("/new-key", {});
    if (!next?.key) {
      await openKrcAlert({ title: "No new key", message: "The server didn't make a new key. The old one still works." });
      return;
    }
    apply(next);
  });
  const row = el("div", "krc-ext-api-key");
  if (state.key) {
    const copy = el("button", "krc-options-reset", { type: "button", textContent: "Copy" });
    copy.addEventListener("click", async () => {
      showToast(await copyText(state.key) ? "Access key copied." : "Couldn't copy; select the key and copy it by hand.");
    });
    const done = el("button", "krc-options-reset", { type: "button", textContent: "Done" });
    done.addEventListener("click", () => apply({ ...state, key: "" }));
    row.append(el("span", "krc-options-description", { textContent: "New key" }), keyField(state.key, "New access key"), copy, done);
    host.append(row, el("div", "krc-options-description krc-options-warning krc-setting-desc", { textContent: KEY_ONCE }));
    return;
  }
  row.append(el("span", "krc-options-description", { textContent: "Access key" }), keyField(maskedKey(state.keyHint), "Access key (last 4 characters)"), renew);
  host.append(row, el("div", "krc-options-description krc-setting-desc", { textContent: KEY_HELP }));
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
        apply({ ...result, key: state.key || "" });
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

// The "External API" row, built like the page's other setting rows (settingRow).
export function externalApiRow() {
  const wrap = el("div", "krc-setting-row");
  wrap.dataset.setting = "KRC.ExternalApi";
  const keyHost = el("div", "krc-ext-api-key-host");
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
    renderKey(keyHost, state, apply);
    renderWrites(writesHost, state, apply);
  };
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: LABEL }), toggle);
  wrap.append(
    head,
    el("div", "krc-options-description krc-setting-desc", { textContent: DESCRIPTION }),
    keyHost,
    writesHost,
  );
  readState().then((loaded) => {
    if (loaded) apply(loaded);
    else keyHost.replaceChildren(el("div", "krc-options-description", { textContent: "Couldn't read the External API setting from the server." }));
  });
  return wrap;
}
