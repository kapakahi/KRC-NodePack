import { fetchLora, postLoraJson } from "../model_library/api.js";

async function responseJson(response) {
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

export function modelSelectionOperation(panel, kind, { pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let handle = null;
  const seen = new Set();
  return {
    node: panel.node, kind, longRunning: true, noun: "cards",
    title: kind === "fetch" ? "Fetch selected LoRAs" : "Stabilize selected models",
    preview: (ids) => postLoraJson("/selection-jobs/preview", { ids, operation: kind }).then(responseJson),
    async cancel() {
      if (!handle) return;
      await responseJson(await postLoraJson(`/selection-jobs/${encodeURIComponent(handle)}/cancel`, {}));
    },
    async execute(ids, { onProgress }) {
      // A retry after a transport error reattaches to this run, never starts a duplicate.
      if (!handle) {
        const started = await responseJson(await postLoraJson("/selection-jobs/start", { ids, operation: kind, confirmed: true }));
        handle = started.job.id;
      }
      while (true) {
        let job;
        try { ({ job } = await responseJson(await fetchLora(`/selection-jobs/${encodeURIComponent(handle)}`))); }
        catch (error) { throw new Error(`Could not monitor the job: ${error.message}. Retry reconnects to the same run; remaining work may still be running.`); }
        for (const identity of job.identities || []) {
          const key = `${identity.oldId}:${identity.newId}`;
          if (!seen.has(key)) { seen.add(key); panel.applyIdentityChange(identity); }
        }
        onProgress?.(job);
        if (!job.active) {
          handle = null;
          return { ok: true, state: job.state, updated: job.succeeded, skipped: job.skipped,
            failed: job.failed, notFound: job.notFound, retryIds: job.retryIds,
            warnings: [job.note, ...(job.issues || []).slice(0, 20).map((issue) => `${issue.name || issue.id}: ${issue.text}`),
              ...((job.issues || []).length > 20 ? [`${job.issues.length - 20} more issues; all failed/remaining IDs are retained for retry.`] : [])].filter(Boolean) };
        }
        await pause(750);
      }
    },
  };
}
