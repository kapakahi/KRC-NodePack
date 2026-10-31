/*
 * KRC database status: the "Storage" cell under Options ▸ Support (KRC_SQLITE_GAMEPLAN.md
 * stages 1 + 4): where krc.db is, the SQLite build, the latest snapshot, what was moved in
 * from the old JSON files, the server's location warning if there is one, and restoring
 * everything or one area (Prompt Vault, presets, library) from a snapshot.
 */
import { el } from "./dom.js";
import { makeNodeApi } from "./api.js";
import { menuSelect } from "./browser_controls.js";
import { openKrcAlert, openKrcConfirm } from "./modal.js";
import { showToast } from "./toast.js";

const { fetchLora, postLoraJson } = makeNodeApi("/krc/db");

const AREA_LABELS = Object.freeze({
  all: "Everything",
  prompts: "Prompt Vault",
  presets: "Presets",
  word_banks: "Word Bank banks",
  library: "Library (LoRAs + models)",
  media: "Media (catalog + presets)",
});

const MIGRATION_LABELS = Object.freeze({
  prompt_vault: "Prompt Vault",
  presets: "Presets",
  library: "Library",
  word_banks: "Word Bank banks",
});

// → the server's status ({path, sqliteVersion, fts5, warning, migrated, snapshots}) or null.
export async function fetchDbStatus() {
  try {
    const response = await fetchLora("/status", { cache: "no-store" });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

function snapshotText(snapshots) {
  if (!snapshots?.count) return "No snapshot yet";
  const when = snapshots.newestMs ? new Date(snapshots.newestMs).toLocaleString() : snapshots.newest;
  return `Latest snapshot ${when} · ${snapshots.count} kept`;
}

// One area's import record → "Prompt Vault: 611 prompts from prompt_vault_data.json",
// "Presets: 42 moved in" (records of every kind added up), or "…: new" for an install
// that had nothing to move.
function migrationPart(key, info) {
  const label = MIGRATION_LABELS[key] || key;
  if (key === "prompt_vault") {
    if (!info?.source) return `${label}: new`;
    const count = Number.isFinite(info.prompts) ? `${info.prompts} prompts` : "moved in";
    return `${label}: ${count} from ${info.source}`;
  }
  const total = Object.entries(info || {})
    .filter(([field, value]) => field !== "atMs" && field !== "skipped" && Number.isFinite(value))
    .reduce((sum, [, value]) => sum + value, 0);
  return total ? `${label}: ${total} moved in` : `${label}: new`;
}

function migrationText(migrated) {
  return Object.entries(migrated || {}).map(([key, info]) => migrationPart(key, info)).join(" · ");
}

function renderStatus(body, status) {
  body.replaceChildren();
  if (!status) {
    body.append(el("div", "krc-options-description", { textContent: "Couldn't read the database status from the server." }));
    return;
  }
  if (status.warning) {
    body.append(el("div", "krc-options-description krc-options-warning", { textContent: status.warning }));
  }
  const fts = status.fts5 ? "full-text search ✓" : "full-text search ✗";
  body.append(el("div", "krc-options-description", {
    textContent: `✓ krc.db · SQLite ${status.sqliteVersion || "?"} · ${fts}`,
  }));
  if (status.path) body.append(el("div", "krc-options-description", { textContent: status.path }));
  body.append(el("div", "krc-options-description", { textContent: snapshotText(status.snapshots) }));
  const moved = migrationText(status.migrated);
  if (moved) body.append(el("div", "krc-options-description", { textContent: moved }));
}

// → {snapshots: [{name, sizeBytes, mtimeMs}], areas: [...]} or null.
async function fetchSnapshots() {
  try {
    const response = await fetchLora("/snapshots", { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

function snapshotLabel(snapshot) {
  return new Date(snapshot.mtimeMs).toLocaleString();
}

// A dropdown wide enough for its longest option, so no choice is clipped and the button
// doesn't change width with the selection.
function restoreSelect({ title, value, options, onChange }) {
  const select = menuSelect({ className: "krc-setting-select krc-db-restore-select", title, value, options, align: "right", onChange });
  const longest = Math.max(...options.map(([, label]) => String(label).length));
  select.style.width = `calc(${longest}ch + 22px)`;
  return select;
}

// Area + snapshot pickers and a Restore button, into the Restore row's control slot.
// Restoring saves the current state as a snapshot first, so it can be undone the same way.
function renderRestore(host, listing, refresh) {
  host.replaceChildren();
  const snapshots = listing?.snapshots || [];
  if (!snapshots.length) {
    host.append(el("span", "krc-options-description", { textContent: "No snapshot yet" }));
    return;
  }
  let snapshot = snapshots[0].name;
  let area = "all";
  const pickSnapshot = restoreSelect({
    title: "Snapshot to restore from",
    value: snapshot,
    options: snapshots.map((item) => [item.name, snapshotLabel(item)]),
    onChange: (next) => { snapshot = next; },
  });
  const pickArea = restoreSelect({
    title: "What to restore",
    value: area,
    options: (listing.areas || Object.keys(AREA_LABELS)).map((key) => [key, AREA_LABELS[key] || key]),
    onChange: (next) => { area = next; },
  });
  const button = el("button", "krc-options-reset", { type: "button", textContent: "Restore…" });
  button.addEventListener("click", async () => {
    const when = snapshotLabel(snapshots.find((item) => item.name === snapshot) || snapshots[0]);
    const confirmed = await openKrcConfirm({
      title: "Restore from a snapshot",
      message: `Replace ${AREA_LABELS[area] || area} with the snapshot from ${when}? `
        + "The current state is saved as a snapshot first, so you can undo this the same way. "
        + "Reload open ComfyUI pages afterwards to see the restored data.",
      confirmLabel: "Restore",
      danger: true,
    });
    if (!confirmed) return;
    button.disabled = true;
    let payload = null;
    try {
      const response = await postLoraJson("/restore", { snapshot, area });
      payload = await response.json();
    } catch {
      payload = null;
    }
    button.disabled = false;
    if (payload?.ok) {
      await openKrcAlert({
        title: "Restored",
        message: `${AREA_LABELS[area] || area} restored from ${when}. Reload this page (and any other open ComfyUI page) to see it.`,
      });
    } else {
      await openKrcAlert({ title: "Not restored", message: payload?.error || "The restore failed." });
    }
    refresh();
  });
  host.append(pickArea, pickSnapshot, button);
}

// The Restore row, laid out like the page's other setting rows: name on the left, the
// pickers and button at the right edge, the description under it.
function restoreRow() {
  const row = el("div", "krc-setting-row");
  row.dataset.setting = "KRC.Restore";
  const head = el("div", "krc-setting-head");
  const controls = el("div", "krc-db-restore");
  head.append(el("span", "krc-setting-label", { textContent: "Restore" }), controls);
  row.append(head, el("div", "krc-options-description krc-setting-desc", { textContent: "Restore from automated backups." }));
  return { row, controls };
}

// A setting row like the page's others (model_library/options_page.js settingRow): name
// and control on one line, the description under it.
function backupRow(id, label, control, desc) {
  const row = el("div", "krc-setting-row");
  row.dataset.setting = id;
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: label }), control);
  row.append(head, el("div", "krc-options-description krc-setting-desc", { textContent: desc }));
  return row;
}

// → {intervalHours, keep, intervalChoices, keepChoices} or null; a POST sends either or both.
async function backupSettings(change = null) {
  try {
    const response = change ? await postLoraJson("/backup-settings", change) : await fetchLora("/backup-settings", { cache: "no-store" });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

// A backup-setting dropdown, saved on the server when changed (reverted if refused).
function backupSelect(settings, key, choices, label, unit) {
  let current = String(settings[key]);
  const select = menuSelect({
    className: "krc-setting-select",
    title: label,
    value: current,
    options: choices.map((value) => [String(value), unit(value)]),
    align: "right",
    onChange: async (next) => {
      const saved = await backupSettings({ [key]: Number(next) });
      if (saved?.ok) {
        current = next;
        return;
      }
      select.value = current;
      await openKrcAlert({ title: label, message: "The server didn't take the change, so it stays as it was." });
    },
  });
  return select;
}

// Back up every / Keep backups / Back up now, above Restore.
function renderBackupRows(host, refresh) {
  host.replaceChildren(el("div", "krc-options-description", { textContent: "Reading the backup settings…" }));
  backupSettings().then((settings) => {
    host.replaceChildren();
    if (!settings) {
      host.append(el("div", "krc-options-description", { textContent: "Couldn't read the backup settings from the server." }));
      return;
    }
    const now = el("button", "krc-options-reset krc-setting-action", { type: "button", textContent: "Back up now" });
    now.addEventListener("click", async () => {
      now.disabled = true;
      let payload = null;
      try {
        payload = await (await postLoraJson("/backup-now", {})).json();
      } catch {
        payload = null;
      }
      now.disabled = false;
      if (payload?.ok) showToast("Backup saved.");
      else await openKrcAlert({ title: "No backup", message: payload?.error || "The backup failed." });
      refresh();
    });
    host.append(
      backupRow("KRC.BackupInterval", "Back up every",
        backupSelect(settings, "intervalHours", settings.intervalChoices || [12, 24, 48, 72], "Back up every", (hours) => `${hours} hours`),
        "How often KRC saves a backup of its database while ComfyUI runs (checked after changes)."),
      backupRow("KRC.BackupKeep", "Keep backups",
        backupSelect(settings, "keep", settings.keepChoices || [3, 7, 14], "Keep backups", (count) => `${count} backups`),
        "How many backups to keep. Lowering it removes the oldest extras at the next backup."),
      backupRow("KRC.BackupNow", "Back up now", now, "Save a backup right away, e.g. before trying something risky."),
    );
  });
}

// The Options "Storage" cell. `section({ title, body })` is the caller's cell builder.
export function dbStatusSection(section) {
  const body = el("div", "krc-options-stack-output");
  const status = el("div", "krc-db-status");
  status.append(el("div", "krc-options-description", { textContent: "Checking the database…" }));
  const backups = el("div", "krc-db-backups");
  const { row: restoreHost, controls: restore } = restoreRow();
  body.append(status, backups, restoreHost);
  const refresh = () => {
    fetchDbStatus().then((payload) => renderStatus(status, payload));
    fetchSnapshots().then((listing) => renderRestore(restore, listing, refresh));
  };
  refresh();
  renderBackupRows(backups, refresh);
  return section({ title: "Storage", body });
}
