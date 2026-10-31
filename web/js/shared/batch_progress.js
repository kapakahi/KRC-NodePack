/*
 * KRC shared batch-progress view — an embeddable (not modal) live view of one
 * batch job: a progress bar (determinate % or an indeterminate sweep), count
 * chips, the current item + phase, and an auto-tailing CLI-style log.
 *
 * DOM port of the KRC Editor's BatchProgress.svelte. It is a pure VIEW of a job
 * object; whoever runs the job (the server-side Civitai batch, via a page bridge)
 * owns the state. `update(job)` patches only what moved — bar width, chip values,
 * meta text, and newly appended log lines — never a full re-render, so a long run
 * stays cheap on Safari.
 *
 * Job shape (mirror of the Editor's batchRunner job, plus `current`/timing):
 *   id              -> run id; a change resets the log
 *   title           -> heading text
 *   active          -> live run (false = finished; shows the summary state)
 *   indeterminate   -> no known total yet (sweep instead of a fill)
 *   total, done     -> item counts
 *   counts          -> { key: n }
 *   chipDefs        -> [{ key, label, kind: ok|warn|fail|info, always }]
 *   current         -> { name, phase, detail } | null — the item in flight
 *   elapsedMs, etaMs-> optional timing (etaMs 0/absent = unknown)
 *   log             -> [{ seq, i, kind: ok|cached|warn|fail|dim, sym, name, text }]
 *   note            -> optional amber line (e.g. "Internet access was turned off")
 *   cancellable, cancel -> Cancel button state ("Stopping…" once requested)
 */
import { ensureStylesheet } from "./stylesheets.js";
import { el } from "./dom.js";

// Preloaded at import (not on first use) so the first paint is styled — a lazily
// injected sheet paints unstyled for a beat (see lazy-stylesheet flash).
ensureStylesheet(
  "krc-batch-progress-css",
  "./batch_progress.css",
  import.meta.url,
  { version: "2", ready: true },
);

const LOG_DOM_LIMIT = 500;  // cap rendered lines; the server ring-buffers too
const PIN_SLACK_PX = 24;    // "near the bottom" → keep following the tail

function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
  if (m) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function logLine(entry, total) {
  const line = el("div", `krc-bp-line is-${entry.kind || "dim"}`);
  if (total > 0 && entry.i > 0) {
    line.append(el("span", "krc-bp-idx", { textContent: `[${entry.i}/${total}]` }));
  }
  line.append(
    el("span", "krc-bp-sym", { textContent: entry.sym || "·" }),
    el("span", "krc-bp-name", { textContent: entry.name || "", title: entry.name || "" }),
  );
  if (entry.text) {
    line.append(el("span", "krc-bp-text", { textContent: `— ${entry.text}` }));
  }
  return line;
}

export function createBatchProgress({ onCancel = null } = {}) {
  const root = el("div", "krc-bp");

  const head = el("div", "krc-bp-head");
  const title = el("span", "krc-bp-title");
  const chips = el("div", "krc-bp-chips");
  head.append(title, chips);

  const bar = el("div", "krc-bp-bar");
  const fill = el("div", "krc-bp-fill");
  bar.append(fill);

  const meta = el("div", "krc-bp-meta");
  const metaLeft = el("span", "krc-bp-meta-count");
  const metaRight = el("span", "krc-bp-meta-pct");
  meta.append(metaLeft, metaRight);

  const current = el("div", "krc-bp-current");
  const timing = el("div", "krc-bp-timing");

  const log = el("div", "krc-bp-log");
  log.setAttribute("aria-label", "Batch log");
  let pinned = true;
  log.addEventListener("scroll", () => {
    pinned = log.scrollHeight - log.scrollTop - log.clientHeight < PIN_SLACK_PX;
  });

  const note = el("div", "krc-bp-note");
  const foot = el("div", "krc-bp-foot");
  const cancel = el("button", "krc-modal-btn krc-bp-cancel", { type: "button", textContent: "Cancel" });
  if (onCancel) {
    cancel.addEventListener("click", () => onCancel());
    foot.append(cancel);
  }

  root.append(head, bar, meta, current, timing, log, note, foot);

  let jobId = null;
  let lastSeq = 0;
  let chipSig = "";

  function update(job) {
    if (!job) return;
    const total = Number(job.total) || 0;
    const done = Number(job.done) || 0;
    const active = !!job.active;
    const indet = !!job.indeterminate;
    const pct = !indet && total ? Math.round((done / total) * 100) : 0;

    // A new run → start the log fresh.
    if (job.id !== jobId) {
      jobId = job.id;
      lastSeq = 0;
      log.replaceChildren();
      pinned = true;
    }

    title.textContent = job.title || (active ? "Working…" : "Done");

    // Chips: rebuild only when a visible value changed (tiny node set).
    const chipList = (job.chipDefs || [])
      .map((def) => ({ ...def, value: (job.counts && job.counts[def.key]) || 0 }))
      .filter((chip) => chip.always || chip.value > 0);
    const sig = chipList.map((chip) => `${chip.key}:${chip.value}`).join("|");
    if (sig !== chipSig) {
      chipSig = sig;
      chips.replaceChildren(...chipList.map((chip) =>
        el("span", `krc-bp-chip is-${chip.kind || "info"}`, { textContent: `${chip.value} ${chip.label}` })));
    }

    bar.classList.toggle("is-indeterminate", indet && active);
    bar.classList.toggle("is-done", !active);
    fill.style.width = indet && active ? "" : `${pct}%`;
    metaLeft.textContent = indet ? (active ? "Working…" : "Done") : `${done} / ${total}`;
    metaRight.textContent = indet ? "" : `${pct}%`;

    const cur = active ? job.current : null;
    current.hidden = !cur;
    if (cur) {
      current.textContent = `${cur.phase ? `${cur.phase} · ` : ""}${cur.name || ""}${cur.detail ? ` — ${cur.detail}` : ""}`;
      current.title = current.textContent;
    }

    const timeParts = [];
    if (job.elapsedMs) timeParts.push(`Elapsed ${formatDuration(job.elapsedMs)}`);
    if (active && job.etaMs) timeParts.push(`~${formatDuration(job.etaMs)} left`);
    timing.hidden = !timeParts.length;
    timing.textContent = timeParts.join(" · ");

    // Append only lines we haven't rendered (monotonic seq).
    const fresh = (job.log || []).filter((entry) => (entry.seq || 0) > lastSeq);
    if (fresh.length) {
      log.querySelector(".krc-bp-empty")?.remove();
      const frag = document.createDocumentFragment();
      fresh.forEach((entry) => frag.append(logLine(entry, total)));
      log.append(frag);
      lastSeq = fresh[fresh.length - 1].seq || lastSeq;
      while (log.childElementCount > LOG_DOM_LIMIT) log.firstElementChild.remove();
      if (pinned) log.scrollTop = log.scrollHeight;
    }
    const empty = log.querySelector(".krc-bp-empty");
    if (!log.childElementCount || empty) {
      const text = active ? "Starting…" : "Nothing to report.";
      if (empty) empty.textContent = text;
      else log.append(el("div", "krc-bp-line is-dim krc-bp-empty", { textContent: text }));
    }

    note.hidden = !job.note;
    note.textContent = job.note || "";

    const showCancel = !!onCancel && active && job.cancellable;
    foot.hidden = !showCancel;
    cancel.disabled = !!job.cancel;
    cancel.textContent = job.cancel ? "Stopping…" : "Cancel";
  }

  return { element: root, update };
}
