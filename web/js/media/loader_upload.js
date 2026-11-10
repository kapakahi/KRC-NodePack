// KRC Media Loader's UPLOAD with one to six files (the Media Portal's Batch page is separate).
// The files go one after another into consecutive slots of one preset, from the slot that
// was selected when the upload began, wrapping after slot 6 (slot 5 + three files -> 5, 6, 1).
// The preset, its version and the first slot are captured in the batch: changing the node's
// preset or slot meanwhile doesn't redirect it.
//
// Each file reserves its slot. A failed file leaves its slot as it was and the next files
// keep their own slots. Each save carries the preset's version from the previous answer; a
// conflict (another window changed the preset) stops the batch rather than overwrite it.
// Stop cancels the conversion in progress (or the request that's sending) and skips the rest;
// slots already filled stay filled. Replaced items stay in Media (a slot only references one).
//
// No DOM and no server calls of its own (the node passes them in), so this runs in tests.
export const LOADER_SLOT_COUNT = 6;
export const MAX_LOADER_FILES = 6;
const POLL_MS = 500;
const TAG = "[KRC Media]";

export const tooManyFiles = (count) => `Select up to ${MAX_LOADER_FILES} files. You selected ${count}.`;
export const batchSlot = (start, index) => (start + index) % LOADER_SLOT_COUNT;

// The picked files -> { files } (1-6) or { error } (more than six: the whole pick is refused
// before anything is uploaded, converted or created).
export function loaderFiles(list) {
  const files = Array.from(list || []);
  return files.length > MAX_LOADER_FILES ? { files: [], error: tooManyFiles(files.length) } : { files, error: "" };
}
const message = (error) => String(error?.message || error || "failed");

// status: "uploading" | "converting" | "saving" while active; "done" once it ended.
export function newLoaderBatch(files, { preset = "", version = "", start = 0 } = {}) {
  return {
    files: [...files], preset, version, start,
    index: 0, slot: start, status: "uploading", progress: 0, jobId: "",
    active: true, stopped: false, conflict: "", completed: [], failures: [], controller: null,
  };
}

// Stop: no further files; the conversion in progress is cancelled, a sending request aborted.
export function stopLoaderBatch(batch, { cancelJob }) {
  if (!batch?.active || batch.stopped) return;
  batch.stopped = true;
  batch.controller?.abort();
  if (batch.jobId) {
    cancelJob(batch.jobId).catch((error) => console.warn(`${TAG} couldn't stop the conversion: ${message(error)}`));
  }
}

// What the preview says while it runs.
export function batchLabel(batch) {
  const where = `${batch.files.length > 1 ? `${batch.index + 1}/${batch.files.length} · ` : ""}Slot ${batch.slot + 1}`;
  if (batch.status === "converting") return `Converting ${where} · ${Math.round((batch.progress || 0) * 100)}%`;
  if (batch.status === "saving") return `Saving ${where}…`;
  return `Uploading ${where}…`;
}

// What it reports when it ends ("" = nothing to report: every file is in its slot, or one
// file was stopped, as before).
export function batchReport(batch) {
  const parts = [];
  if (batch.conflict) parts.push(batch.conflict);
  else if (batch.stopped && batch.files.length > 1) parts.push("Upload stopped. Completed slots were kept.");
  for (const failure of batch.failures) parts.push(`${failure.name} (slot ${failure.slot + 1}): ${failure.error}`);
  return parts.join(" · ");
}

// Runs the batch. `deps`: upload(file, signal) -> { item } | { job }; job(id) -> { job };
// cancelJob(id); save(preset, slot, itemId, version) -> { ok, version } | { ok: false,
// conflict, error }; wait(ms); changed() (re-render). Resolves to the batch, ended.
export async function runLoaderBatch(batch, deps) {
  const { upload, job, cancelJob, save, changed = () => {} } = deps;
  const wait = deps.wait || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  try {
    for (let index = 0; index < batch.files.length; index += 1) {
      if (batch.stopped || batch.conflict) break;
      const file = batch.files[index];
      const slot = batchSlot(batch.start, index);
      Object.assign(batch, { index, slot, status: "uploading", progress: 0, jobId: "" });
      changed();
      let item = null;
      try {
        batch.controller = typeof AbortController === "function" ? new AbortController() : null;
        const answer = await upload(file, batch.controller?.signal);
        batch.controller = null;
        if (answer?.job) {
          batch.jobId = answer.job.id;
          if (batch.stopped) {
            // Stopped while it was sending: its conversion never runs.
            await cancelJob(batch.jobId).catch(() => {});
            break;
          }
          batch.status = "converting";
          let current = answer.job;
          while (!["done", "error", "cancelled"].includes(current?.status)) {
            batch.progress = current?.progress || 0;
            changed();
            await wait(POLL_MS);
            if (batch.stopped) break;
            try {
              current = (await job(batch.jobId)).job;
            } catch (error) {
              console.warn(`${TAG} couldn't read the conversion's progress: ${message(error)}`);
            }
          }
          if (batch.stopped) break;
          if (current.status === "cancelled") throw new Error("Its conversion was cancelled.");
          if (current.status === "error") throw new Error(current.error || "The conversion failed.");
          item = current.item;
        } else {
          item = answer?.item;
        }
        if (!item?.id) throw new Error("The upload returned no Media item.");
      } catch (error) {
        batch.controller = null;
        if (batch.stopped) break;
        batch.failures.push({ name: file?.name || "file", slot, error: message(error) });
        continue;
      }
      batch.jobId = "";
      if (batch.stopped) break;
      batch.status = "saving";
      changed();
      const saved = await save(batch.preset, slot, item.id, batch.version);
      if (saved?.ok) {
        batch.version = saved.version || batch.version;
        batch.completed.push({ name: file?.name || "file", slot, id: item.id });
      } else if (saved?.conflict) {
        batch.conflict = `The preset changed elsewhere, so the upload stopped before slot ${slot + 1} `
          + `(${file?.name || "the file"} is in Media). Completed slots were kept.`;
      } else {
        batch.failures.push({ name: file?.name || "file", slot, error: saved?.error || "Couldn't fill the slot." });
      }
    }
  } finally {
    Object.assign(batch, { active: false, status: "done", jobId: "", controller: null });
    changed();
  }
  return batch;
}
