/*
 * Fetch (Civitai batch fetch) — the Portal's home-menu page on the Info Panel side: fill missing
 * Civitai metadata for every LoRA that has none, as one server-side batch job.
 * Spec + build order: CIVITAI_BATCH_FETCH_GAMEPLAN.md.
 *
 * The page is a VIEW of the server job, read through the page-level store in
 * shared/civitai_batch_client.js (status on attach + websocket deltas). Closing the
 * Portal, switching workflows, or reloading never stops the run — re-opening the page
 * re-attaches to it.
 *
 * Hosting: an Info Panel page (info_page.js) — renderInfo() dispatches here while
 * `infoPage === CIVITAI_FETCH_PAGE`; selecting any card clears it.
 */
import { el } from "../shared/dom.js";
import { menuSelect, switchToggle } from "../shared/browser_controls.js";
import { armConfirmButton } from "../shared/confirm_action.js";
import { openKrcConfirm } from "../shared/modal.js";
import { showToast } from "../shared/toast.js";
import { createBatchProgress } from "../shared/batch_progress.js";
import { infoPageSection as fetchSection } from "./info_page.js";
import { isNetworkAllowed } from "../shared/network_consent.js";
import { readGlobalSetting, writeGlobalSetting } from "../shared/global_settings.js";
import { NO_VIDEO_MESSAGE } from "../shared/video_status.js";
import { modelFolderMatch } from "./pure_helpers.js";
import {
  attachCivitaiBatch,
  cancelCivitaiBatch,
  civitaiBatchState,
  fetchCivitaiBatchTargets,
  clearCivitaiBatchIssues,
  generateMissingLoraThumbnails,
  startCivitaiBatch,
  subscribeCivitaiBatch,
} from "../shared/civitai_batch_client.js";
import {
  VIDEO_IMPORT_MODE_SETTING_ID,
  VIDEO_IMPORT_MODE_DEFAULT,
  VIDEO_IMPORT_MODE_OPTIONS,
  VIDEO_POSTER_FRAME_SETTING_ID,
  VIDEO_POSTER_FRAME_DEFAULT,
  VIDEO_POSTER_FRAME_OPTIONS,
  VIDEO_WEBM_CRF_SETTING_ID,
  VIDEO_WEBM_CRF_DEFAULT,
  VIDEO_WEBM_CRF_OPTIONS,
} from "../shared/settings.js";

export const CIVITAI_FETCH_PAGE = "civitaiFetch";
const HOME_CARD_ID = "civitai-fetch";
const HOME_CARD_SUBTITLE = "Fetch missing LoRA metadata";

const SKIP_LABELS = {
  civitai: "Already from Civitai",
  huggingface: "HuggingFace import",
  blanked: "Reset by you (blank)",
  not_found_cached: "Previously not found on Civitai",
};

export const CIVITAI_FETCH_CHIPS = [
  { key: "fetched", label: "fetched", kind: "ok", always: true },
  { key: "notFound", label: "not found", kind: "warn" },
  { key: "thumbPending", label: "thumb pending", kind: "warn" },
  { key: "skipped", label: "skipped", kind: "info" },
  { key: "failed", label: "failed", kind: "fail" },
];

const JOB_TITLES = {
  running: "Fetching Civitai metadata…",
  cancelling: "Stopping after the current LoRA…",
  done: "Fetch complete",
  cancelled: "Fetch cancelled",
  stopped: "Fetch stopped",
  failed: "Fetch failed",
};

function formatBytes(bytes) {
  const gb = (Number(bytes) || 0) / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(gb * 1000)} MB`;
}

function folderLabel(name) {
  return name ? name : "Root";
}

function scopeLabel(scope) {
  if (!scope || scope.folder === null || scope.folder === undefined) return "Whole library";
  return `${folderLabel(scope.folder)}${scope.subfolders ? " (+ subfolders)" : ""}`;
}

function formatWhen(ms) {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Server job → the shared progress view's job shape. Elapsed keeps ticking locally
// between events (a large hash can go minutes without one).
function toProgressJob(job) {
  const tick = job.active && job.receivedAt ? Date.now() - job.receivedAt : 0;
  const current = job.current
    ? { name: job.current.name, phase: job.current.phase, detail: job.current.detail }
    : null;
  return {
    id: job.id,
    title: JOB_TITLES[job.state] || "Civitai fetch",
    active: !!job.active,
    indeterminate: false,
    total: job.total,
    done: job.done,
    counts: job.counts || {},
    chipDefs: CIVITAI_FETCH_CHIPS,
    current,
    elapsedMs: (job.elapsedMs || 0) + tick,
    etaMs: job.etaMs || 0,
    log: job.log || [],
    note: job.note || "",
    cancellable: !!job.active,
    cancel: !!job.cancel,
  };
}

// ── Page building blocks ──────────────────────────────────────────────────────────

function statRow(value, label, detail = "", kind = "") {
  const row = el("div", `krc-fetch-stat${kind ? ` is-${kind}` : ""}`);
  row.append(el("span", "krc-fetch-stat-value", { textContent: String(value) }), el("span", "krc-fetch-stat-label", { textContent: label }));
  if (detail) row.append(el("span", "krc-fetch-stat-detail", { textContent: detail }));
  return row;
}

function callout(kind, text) {
  return el("div", `krc-fetch-callout is-${kind}`, { textContent: text });
}

// A label + KRC switch row (the Options page's markup; never a native checkbox).
function checkField(label, checked, onChange, { disabled = false } = {}) {
  const toggle = switchToggle({
    active: checked,
    title: label,
    onClick: () => {
      const next = !toggle.classList.contains("is-on");
      toggle.classList.toggle("is-on", next);
      onChange(next);
    },
  });
  toggle.disabled = disabled;
  const field = el("div", "krc-setting-head krc-fetch-check");
  field.append(el("span", "krc-fetch-check-label", { textContent: label }), toggle);
  return field;
}

function settingRow(label, control, hint = "") {
  const row = el("div", "krc-fetch-setting");
  row.append(el("span", "krc-fetch-setting-label", { textContent: label }), control);
  if (hint) row.append(el("span", "krc-fetch-setting-hint", { textContent: hint }));
  return row;
}

// The thumbnail-capability line (gameplan §7). Worded for the server's actual state
// so a missing animated thumbnail is never mistaken for a bug.
function capabilityLine(capability, videoImportMode) {
  if (!capability) return null;
  if (!capability.video) {
    return callout("warn", `${NO_VIDEO_MESSAGE} Until then, video previews get a still from Civitai (Force Refresh upgrades one later).`);
  }
  // PyAV, but no Pillow for posters (and no loop to fall back on) — the same Civitai
  // still the server uses when there's no PyAV at all.
  if (!capability.poster && !(videoImportMode === "animated" && capability.webm)) {
    return callout("warn", "No Pillow for posters: video previews get a still from Civitai instead.");
  }
  if (videoImportMode !== "animated") {
    return callout("info", "Static thumbnails only — animated is off (Video import mode above).");
  }
  if (!capability.webm) {
    return callout("warn", `Static thumbnails only — this ComfyUI's PyAV ${capability.pyav || ""} has no VP9 encoder.`);
  }
  if (!capability.poster) {
    return callout("warn", "Animated thumbnails on, but no Pillow for the static poster fallback.");
  }
  return callout("ok", `Animated thumbnails: on (PyAV ${capability.pyav || ""}).`);
}

function previewKey(ui) {
  return ui.scope === "folder" && ui.folder !== null
    ? `folder:${ui.folder}:${ui.subfolders ? 1 : 0}`
    : "library";
}

// Counts + issue rows for a finished run (the live job, or the persisted last run).
// onIssue(id) selects that LoRA; thumbAction() builds the Generate missing thumbnails
// control, asked for only when the run left thumbnails pending; onClearIssues() empties
// the Errors & warnings list.
function runSummary(run, { onIssue, thumbAction = null, onClearIssues = null } = {}) {
  const counts = run.counts || {};
  const children = [
    el("div", "krc-fetch-note", {
      textContent: [formatWhen(run.finishedAt), scopeLabel(run.scope), run.overwrite ? "overwrite" : ""].filter(Boolean).join(" · "),
    }),
    statRow(counts.fetched || 0, "fetched", "", "ok"),
  ];
  if (counts.notFound) children.push(statRow(counts.notFound, "not found on Civitai", "", "warn"));
  if (counts.thumbPending) {
    children.push(statRow(counts.thumbPending, "thumbnail pending", "saved preview videos, no PyAV", "warn"));
    const action = thumbAction?.();
    if (action) children.push(action);
  }
  if (counts.skipped) children.push(statRow(counts.skipped, "skipped", "changed since the run was planned", "dim"));
  if (counts.failed) children.push(statRow(counts.failed, "failed", "", "fail"));
  if (run.note) children.push(callout("warn", run.note));

  const issues = [
    ...(run.errors || []).map((issue) => ({ ...issue, kind: "fail" })),
    ...(run.warnings || []).map((issue) => ({ ...issue, kind: "warn" })),
  ];
  if (issues.length) {
    const list = el("div", "krc-fetch-issues");
    issues.forEach((issue) => {
      const row = el("button", `krc-fetch-issue is-${issue.kind}`, { type: "button", title: "Show this LoRA", disabled: !issue.id });
      row.addEventListener("click", () => onIssue?.(issue.id));
      row.append(
        el("span", "krc-fetch-issue-sym", { textContent: issue.kind === "fail" ? "✗" : "⚠" }),
        el("span", "krc-fetch-issue-name", { textContent: issue.name || issue.id }),
        el("span", "krc-fetch-issue-text", { textContent: issue.text || "" }),
      );
      list.append(row);
    });
    children.push(el("div", "krc-fetch-subtitle", { textContent: "Errors & warnings" }), list);
    if (onClearIssues) {
      const clear = el("button", "krc-modal-btn krc-fetch-clear-issues", {
        type: "button",
        textContent: "Clear errors & warnings",
        title: "Empty this list. LoRAs with no Civitai match stay findable with civitai:none.",
      });
      clear.addEventListener("click", () => {
        clear.disabled = true;
        onClearIssues();
      });
      children.push(clear);
    }
  }
  return children;
}

export const civitaiFetchPageMethods = {
  openCivitaiFetchPage() {
    this.civitaiFetchPreview = null;  // counts are recomputed on every open
    this.openInfoPage(CIVITAI_FETCH_PAGE);
  },

  civitaiFetchUiState() {
    // folder: null until the folder list is known (then the first folder is picked).
    this.civitaiFetchUi ||= { scope: "library", folder: null, subfolders: false, overwrite: false };
    return this.civitaiFetchUi;
  },

  // One store subscription per panel (node or Portal): patches the home card subtitle
  // and the mounted progress view on every delta; re-renders the page only when the
  // job starts/finishes or the last run changes.
  ensureCivitaiBatchAttached() {
    if (this._civitaiBatchUnsub || this._destroyed) return;
    let lastSig = "";
    this._civitaiBatchUnsub = subscribeCivitaiBatch((state) => {
      if (this._destroyed) {
        this._civitaiBatchUnsub?.();
        return;
      }
      this.refreshCivitaiHomeSubtitle();
      const job = state.job;
      const sig = `${job?.id || ""}:${job?.active ? 1 : 0}:${job?.state || ""}:${state.lastRun?.finishedAt || 0}:${(job?.errors || []).length}:${(job?.warnings || []).length}:${(state.lastRun?.errors || []).length + (state.lastRun?.warnings || []).length}`;
      if (sig !== lastSig) {
        const wasActive = lastSig.split(":")[1] === "1";
        lastSig = sig;
        if (wasActive && !job?.active) this.civitaiFetchPreview = null;  // recount after a run
        if (this.infoPage === CIVITAI_FETCH_PAGE) this.refreshInfo();
        return;
      }
      if (job && this._civitaiProgressView?.element.isConnected) {
        this._civitaiProgressView.update(toProgressJob(job));
      }
    });
    attachCivitaiBatch().catch(() => {});
  },

  // Issue row → select that LoRA and open its folder so the card is in view. The id is
  // the post-hash one (the job records promotions), and canonicalId covers aliases.
  revealCivitaiIssue(id) {
    const sha = this.canonicalId?.(id) || id;
    const lora = (this.loras || []).find((item) => item.sha256 === sha);
    if (!lora) {
      showToast("That LoRA isn't in the library any more — or the list is still reloading.", { duration: 3200 });
      return;
    }
    this.leaveHome?.();   // from the Portal's Home tab: to the Models tab first
    const folders = this.folders || [];
    const row = folders.find((f) => f.kind === "folder" && modelFolderMatch(lora, f.name, folders))
      || folders.find((f) => f.name !== "__model_home__" && modelFolderMatch(lora, f.name, folders));
    this.selectLora(sha);
    if (row && row.name !== this.folder) this.setFolder(row.name);
    this.refreshBrowser?.({ focusSelection: true });
  },

  // "Generate missing thumbnails" for a run that left video previews without one.
  // Offered only when the server can read video (PyAV); without it the route could
  // schedule nothing.
  civitaiThumbAction(capability) {
    if (!capability?.video) {
      return el("div", "krc-fetch-note", { textContent: `${NO_VIDEO_MESSAGE} Then restart ComfyUI and generate the missing thumbnails here.` });
    }
    const button = el("button", "krc-modal-btn krc-fetch-thumbs", { type: "button", textContent: "Generate missing thumbnails" });
    button.addEventListener("click", async () => {
      button.disabled = true;
      const result = await generateMissingLoraThumbnails().catch((err) => ({ ok: false, error: String(err?.message || err) }));
      if (!result.ok) {
        showToast(`Couldn't queue thumbnails: ${result.error}`, { duration: 3600 });
        button.disabled = false;
        return;
      }
      button.textContent = result.scheduled ? `Queued ${result.scheduled}` : "Nothing to generate";
      showToast(result.scheduled
        ? `Generating ${result.scheduled} thumbnail${result.scheduled === 1 ? "" : "s"} — cards fill in as they finish.`
        : "No video previews are missing a thumbnail.", { duration: 3200 });
    });
    return button;
  },

  civitaiHomeSubtitle() {
    const job = civitaiBatchState().job;
    if (job?.active) return job.state === "cancelling" ? "Stopping…" : `Fetching ${job.done}/${job.total}…`;
    return HOME_CARD_SUBTITLE;
  },

  refreshCivitaiHomeSubtitle() {
    const sub = this.root?.querySelector?.(`[data-shortcut-id="${HOME_CARD_ID}"] .krc-lora-sub`);
    if (sub) sub.textContent = this.civitaiHomeSubtitle();
  },

  // Loads the targets preview for the current scope; re-renders the page when it
  // lands (if the page and the scope are still current).
  loadCivitaiFetchPreview(key, ui) {
    const previous = this.civitaiFetchPreview;
    this.civitaiFetchPreview = { key, status: "loading", data: previous?.data || null, error: "" };
    fetchCivitaiBatchTargets({ scope: key === "library" ? "library" : "folder", folder: ui.folder || "", subfolders: ui.subfolders })
      .then((data) => {
        if (this.civitaiFetchPreview?.key !== key) return;
        this.civitaiFetchPreview = { key, status: "ready", data, error: "" };
      })
      .catch((err) => {
        if (this.civitaiFetchPreview?.key !== key) return;
        this.civitaiFetchPreview = { key, status: "error", data: previous?.data || null, error: String(err?.message || err) };
      })
      .finally(() => {
        if (!this._destroyed && this.infoPage === CIVITAI_FETCH_PAGE && this.civitaiFetchPreview?.key === key) {
          this.refreshInfo();
        }
      });
  },

  renderCivitaiFetchPage() {
    this.ensureCivitaiBatchAttached();
    const ui = this.civitaiFetchUiState();
    const batch = civitaiBatchState();
    const job = batch.job;
    const running = !!job?.active;
    const rerender = () => !this._destroyed && this.infoPage === CIVITAI_FETCH_PAGE && this.refreshInfo();

    // Default the folder pick from the last-known folder list BEFORE keying the
    // preview, so a Folder scope never shows whole-library numbers.
    const knownFolders = this.civitaiFetchPreview?.data?.folders || [];
    if (ui.folder === null && knownFolders.length) ui.folder = knownFolders[0].name;

    // Preview for the current scope (fetched on open, on every scope change, and
    // after a run finishes).
    const key = previewKey(ui);
    if (this.civitaiFetchPreview?.key !== key) this.loadCivitaiFetchPreview(key, ui);
    const previewState = this.civitaiFetchPreview;
    const data = previewState?.data || null;
    const loading = previewState?.status === "loading";
    const folders = data?.folders || [];

    const { panel, body } = this.infoPageShell("Fetch", "krc-fetch-page");
    body.classList.add("krc-options-host"); // the shared switch styles

    // Live progress first while running — it's what the user came back to check.
    this._civitaiProgressView = null;
    const progressSection = () => {
      const view = createBatchProgress({
        onCancel: async () => {
          const result = await cancelCivitaiBatch();
          if (!result.ok && result.error) showToast(result.error, { duration: 3200 });
        },
      });
      view.update(toProgressJob(job));
      this._civitaiProgressView = view;
      return view.element;
    };
    if (running) {
      body.append(fetchSection("Progress", progressSection(), el("div", "krc-fetch-note", {
        textContent: `${scopeLabel(job.scope)}${job.overwrite ? " · overwrite" : ""} — cards update when the run finishes.`,
      })));
    }

    // 1. Scope
    const seg = el("div", "krc-fetch-seg");
    [["library", "Whole library"], ["folder", "Folder"]].forEach(([value, label]) => {
      const button = el("button", `krc-fetch-seg-btn${ui.scope === value ? " is-active" : ""}`, { type: "button", textContent: label, disabled: running });
      button.addEventListener("click", () => {
        if (ui.scope === value) return;
        ui.scope = value;
        rerender();
      });
      seg.append(button);
    });
    const scopeChildren = [seg];
    if (ui.scope === "folder") {
      if (!folders.length) {
        scopeChildren.push(el("div", "krc-fetch-note", { textContent: loading ? "Loading LoRA folders…" : "No LoRA folders found." }));
      } else {
        const folderPick = menuSelect({
          className: "krc-fetch-folder",
          title: "LoRA folder",
          value: ui.folder,
          options: folders.map((folder) => [folder.name, `${folderLabel(folder.name)} (${folder.count})`]),
          onChange: (value) => { ui.folder = value; rerender(); },
        });
        folderPick.disabled = running;
        scopeChildren.push(
          settingRow("Folder", folderPick),
          checkField("Include subfolders", ui.subfolders, (value) => { ui.subfolders = value; rerender(); }, { disabled: running }),
        );
      }
    }
    body.append(fetchSection("Scope", ...scopeChildren));

    // 2. Preview
    const preview = data?.preview || null;
    const previewChildren = [];
    if (previewState?.status === "error") {
      const retry = el("button", "krc-modal-btn", { type: "button", textContent: "Retry" });
      retry.addEventListener("click", () => { this.civitaiFetchPreview = null; rerender(); });
      previewChildren.push(callout("fail", `Couldn't count LoRAs: ${previewState.error}`), retry);
    } else if (!preview) {
      previewChildren.push(el("div", "krc-fetch-note", { textContent: "Counting LoRAs…" }));
    } else {
      if (loading) previewChildren.push(el("div", "krc-fetch-note", { textContent: "Updating…" }));
      if (running) previewChildren.push(el("div", "krc-fetch-note", { textContent: "Counted before this run — refreshes when it finishes." }));
      previewChildren.push(
        statRow(preview.count, "LoRAs without Civitai metadata", "", "lead"),
        statRow(preview.hashed, "already hashed", "quick lookups"),
        statRow(preview.unhashed, "need hashing first", preview.unhashed ? `${formatBytes(preview.unhashedBytes)} to read from disk` : ""),
      );
      const skipRows = Object.entries(preview.skipped || {})
        .filter(([, count]) => count > 0)
        .map(([reason, count]) => statRow(count, SKIP_LABELS[reason] || reason, "", "dim"));
      if (skipRows.length) {
        previewChildren.push(el("div", "krc-fetch-subtitle", { textContent: "Skipped" }), ...skipRows);
      }
      if (preview.unhashed) {
        previewChildren.push(callout("warn", "Unhashed LoRAs must be read in full first — on large libraries this can take a long time. Fetching one LoRA or one folder at a time is recommended."));
      }
    }
    body.append(fetchSection("Preview", ...previewChildren));

    // 3. Fetch settings — mirrors of the global settings (never moved; gameplan §1)
    const allowInternet = isNetworkAllowed();
    const videoImportMode = readGlobalSetting(VIDEO_IMPORT_MODE_SETTING_ID, VIDEO_IMPORT_MODE_DEFAULT);
    const internet = el("div", "krc-fetch-internet");
    internet.append(el("span", `krc-fetch-pill ${allowInternet ? "is-on" : "is-off"}`, { textContent: allowInternet ? "On" : "Off" }));
    const settingsLink = el("button", "krc-fetch-link", {
      type: "button",
      textContent: "Options → Network",
      title: "Internet access is changed on the Portal's Options page",
    });
    settingsLink.addEventListener("click", () => this.openOptionsPage?.());
    internet.append(settingsLink);
    const mirror = (title, id, fallback, options, coerce = (value) => value) => menuSelect({
      title,
      value: coerce(readGlobalSetting(id, fallback)),
      options,
      onChange: async (value) => {
        await writeGlobalSetting(id, value);
        rerender();  // the capability line depends on the import mode
      },
    });
    body.append(fetchSection(
      "Fetch settings",
      settingRow("Internet access", internet),
      allowInternet ? null : callout("warn", "Internet access is off — turn it on in Options → Network to fetch."),
      settingRow("Video import mode", mirror("Video import mode", VIDEO_IMPORT_MODE_SETTING_ID, VIDEO_IMPORT_MODE_DEFAULT, VIDEO_IMPORT_MODE_OPTIONS)),
      settingRow("Poster frame", mirror("Video poster frame", VIDEO_POSTER_FRAME_SETTING_ID, VIDEO_POSTER_FRAME_DEFAULT, VIDEO_POSTER_FRAME_OPTIONS)),
      settingRow("WebM quality", mirror("Animated WebM quality", VIDEO_WEBM_CRF_SETTING_ID, VIDEO_WEBM_CRF_DEFAULT, VIDEO_WEBM_CRF_OPTIONS, Number)),
      el("div", "krc-fetch-note", { textContent: "Video settings also apply to Prompt Vault imports." }),
      capabilityLine(data?.capability, videoImportMode),
    ));

    // 4. Run — overwrite override + Start
    const overwrite = checkField("Overwrite my edits", ui.overwrite, (value) => { ui.overwrite = value; rerender(); }, { disabled: running });
    overwrite.classList.add("is-danger");
    const runChildren = [overwrite];
    if (ui.overwrite) {
      runChildren.push(callout("fail", "Civitai values will REPLACE names, descriptions, trained words and tags you set yourself on these LoRAs. Thumbnails you set are never replaced."));
    }
    const count = preview?.count || 0;
    const start = el("button", "krc-modal-btn krc-modal-btn-primary krc-fetch-start", {
      type: "button",
      textContent: running ? "Running…" : `Start — ${count} LoRA${count === 1 ? "" : "s"}`,
      disabled: running || loading || !allowInternet || !count,
    });
    const runConfirmed = async () => {
      const where = ui.scope === "folder" ? `${folderLabel(ui.folder)}${ui.subfolders ? " (+ subfolders)" : ""}` : "the whole library";
      const hashNote = preview.unhashed
        ? ` ${preview.unhashed} must be hashed first (${formatBytes(preview.unhashedBytes)} to read), which can take a long time.`
        : "";
      const ok = await openKrcConfirm({
        node: this.node,
        title: "Fetch Civitai metadata",
        message: `Fetch ${count} LoRA${count === 1 ? "" : "s"} in ${where}?${hashNote} It keeps running if you close the Portal.`,
        confirmLabel: "Continue",
        danger: ui.overwrite,
        width: 400,
      });
      if (!ok) return;
      start.disabled = true;
      const result = await startCivitaiBatch({
        scope: ui.scope,
        folder: ui.folder || "",
        subfolders: ui.subfolders,
        overwrite: ui.overwrite,
      });
      if (!result.ok) {
        showToast(`Couldn't start: ${result.error}`, { duration: 3600 });
        rerender();
      }
    };
    if (ui.overwrite) {
      armConfirmButton(start, {
        armedText: "Confirm overwrite",
        armedTitle: "Click again — this run will overwrite your own edits",
        onConfirm: runConfirmed,
      });
    } else {
      start.addEventListener("click", runConfirmed);
    }
    runChildren.push(start);
    body.append(fetchSection("Run", ...runChildren));

    // 5. Last run — this server session's finished job (with its log), else the
    //    summary persisted across restarts.
    const summaryOptions = {
      onIssue: (id) => this.revealCivitaiIssue(id),
      thumbAction: () => (data?.capability ? this.civitaiThumbAction(data.capability) : null),
      onClearIssues: async () => {
        // The store update re-renders this page (subscription signature changes).
        const result = await clearCivitaiBatchIssues().catch((err) => ({ ok: false, error: String(err?.message || err) }));
        if (!result.ok) {
          showToast(`Couldn't clear: ${result.error}`, { duration: 3600 });
          this.refreshInfo();
        }
      },
    };
    if (job && !running) {
      body.append(fetchSection("Last run", progressSection(), ...runSummary(job, summaryOptions)));
    } else if (!job && batch.lastRun) {
      body.append(fetchSection("Last run", ...runSummary(batch.lastRun, summaryOptions)));
    }

    // Tick elapsed time between events while this page shows a live run.
    clearInterval(this._civitaiTick);
    if (running) {
      this._civitaiTick = setInterval(() => {
        const view = this._civitaiProgressView;
        const current = civitaiBatchState().job;
        if (!view?.element.isConnected || !current?.active) {
          clearInterval(this._civitaiTick);
          return;
        }
        view.update(toProgressJob(current));
      }, 1000);
    }

    return panel;
  },
};
