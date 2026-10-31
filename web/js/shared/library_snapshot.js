// Stale-while-refresh library snapshots (Perceived Loading gameplan, Stage 2).
//
// Persist the last successful light-mode library payload per source so a hard
// refresh can paint the previous library instantly, then refresh in the
// background. The browser /library route already serializes cards in light mode
// (no heavy description/examplePrompts, detail fields deferred), so the payload
// is stored close to verbatim — no separate trim projection to drift.
//
// Snapshot Contract (see PERCEIVED_LOADING_TECHNIQUES.md):
//   - Schema-versioned: bump SNAPSHOT_VERSION whenever the card-paint shape
//     changes; a mismatch is discarded (never rendered) → cold start.
//   - Keyed per library source ("loras" / "models"), shared across every node
//     instance on the origin — never per node.
//   - Age-capped: a snapshot older than SNAPSHOT_MAX_AGE_MS is discarded.
//   - Lightweight: card-paint fields only (already true from the route); a hard
//     byte cap is a backstop against an unexpectedly large payload.
//   - Best-effort storage: any read/write failure (quota, private mode, storage
//     disabled) is treated as "no snapshot" — a cold start, never an error.

// Bump when the persisted card-paint shape changes so old snapshots are dropped.
const SNAPSHOT_VERSION = 3;   // 2: rows carry a per-item thumbnailVersion; 3: rows carry nsfwLevel
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SNAPSHOT_MAX_BYTES = 3_500_000; // ~3.5 MB backstop, well under a ~5 MB quota
const KEY_PREFIX = "krc:snap:";
// Tiny, separate "last known item count" hint. Kept apart from the full snapshot
// so it still survives when the snapshot is absent (byte-capped or aged out) —
// it sizes the Stage-3 cold-start skeletons so their count matches reality.
const COUNT_PREFIX = "krc:snapn:";

function keyFor(source) {
  return `${KEY_PREFIX}${source}`;
}

// Queue only the latest immutable value per source. Capture before callers can
// edit their copy; defer JSON encoding/storage until after the interactive work.
const pendingSnapshots = new Map();
const writtenTokens = new Map();
let scheduled = false;

function capture(value) {
  return typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function scheduleSnapshotWrite() {
  if (scheduled || !pendingSnapshots.size) return;
  scheduled = true;
  const flush = () => {
    scheduled = false;
    const next = pendingSnapshots.entries().next().value;
    if (!next) return;
    const [source, value] = next;
    pendingSnapshots.delete(source);
    try {
      const payload = JSON.stringify(value);
      if (payload.length > SNAPSHOT_MAX_BYTES) localStorage.removeItem(keyFor(source));
      else localStorage.setItem(keyFor(source), payload);
    } catch {
      // Quota, serialization or storage failure must never interrupt the page.
    }
    scheduleSnapshotWrite();
  };
  if (typeof requestIdleCallback === "function") requestIdleCallback(flush, { timeout: 2000 });
  else setTimeout(flush, 32);
}

function queueSnapshot(source, value) {
  try {
    pendingSnapshots.set(source, capture(value));
    scheduleSnapshotWrite();
  } catch {
    // Capturing a snapshot is also best-effort. Cancel an older pending value.
    pendingSnapshots.delete(source);
  }
}

function readSnapshot(source) {
  if (pendingSnapshots.has(source)) return capture(pendingSnapshots.get(source));
  const raw = localStorage.getItem(keyFor(source));
  return raw ? JSON.parse(raw) : null;
}

export function readLibrarySnapshot(source) {
  try {
    const data = readSnapshot(source);
    if (!data || data.version !== SNAPSHOT_VERSION || !Array.isArray(data.loras)) {
      return null;
    }
    if (typeof data.savedAt === "number" && Date.now() - data.savedAt > SNAPSHOT_MAX_AGE_MS) {
      return null;
    }
    return {
      loras: data.loras,
      folders: Array.isArray(data.folders) ? data.folders : [],
      scan: data.scan || null,
      savedAt: typeof data.savedAt === "number" ? data.savedAt : 0,
    };
  } catch {
    // Corrupt JSON, storage disabled, or a private-mode throw → cold start.
    return null;
  }
}

// Nodes sharing a response capture and queue it once, rather than once per node.
export function writeLibrarySnapshot(source, { loras, folders, scan } = {}, { token = null } = {}) {
  if (!Array.isArray(loras)) return;
  if (token) {
    if (writtenTokens.get(source) === token) return;
    writtenTokens.set(source, token);
  }
  queueSnapshot(source, {
    version: SNAPSHOT_VERSION, savedAt: Date.now(), loras,
    folders: Array.isArray(folders) ? folders : [], scan: scan || null,
  });
}

export function clearLibrarySnapshot(source) {
  pendingSnapshots.delete(source);
  writtenTokens.delete(source);
  try {
    localStorage.removeItem(keyFor(source));
  } catch {
    // ignore
  }
}

// Prompt Vault's library is an object ({category: {name: record}}), not an
// array, so it gets its own read/write that persists the whole map under `data`.
// Same version/age/byte contract as the array form.
export function readPromptSnapshot(source) {
  try {
    const parsed = readSnapshot(source);
    if (!parsed || parsed.version !== SNAPSHOT_VERSION || !parsed.data || typeof parsed.data !== "object") {
      return null;
    }
    if (typeof parsed.savedAt === "number" && Date.now() - parsed.savedAt > SNAPSHOT_MAX_AGE_MS) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function writePromptSnapshot(source, data) {
  if (!data || typeof data !== "object") return;
  queueSnapshot(source, { version: SNAPSHOT_VERSION, savedAt: Date.now(), data });
}

export function readCountHint(source) {
  try {
    const raw = localStorage.getItem(`${COUNT_PREFIX}${source}`);
    if (!raw) return 0;
    const data = JSON.parse(raw);
    if (!data || data.version !== SNAPSHOT_VERSION) return 0;
    const count = Number(data.count);
    return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  } catch {
    return 0;
  }
}

export function writeCountHint(source, count) {
  try {
    const value = Math.max(0, Math.floor(Number(count) || 0));
    localStorage.setItem(
      `${COUNT_PREFIX}${source}`,
      JSON.stringify({ version: SNAPSHOT_VERSION, count: value }),
    );
  } catch {
    // best-effort
  }
}
