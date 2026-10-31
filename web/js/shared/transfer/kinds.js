/*
 * KRC import/export — the one kind of file outside the KRC bundle, as data: a Word Bank
 * .txt (a plain word list). Everything else moves in a KRC bundle (bundle_sections.js,
 * bundle_dialogs.js; UNIFIED_BUNDLE_GAMEPLAN.md).
 *
 * One descriptor per kind; shared/transfer/runner.js does the rest (download, file
 * pick, request, error display, sync broadcast). `kind` is also its key in the server's
 * transfer history (krc.db's transfer_history table).
 *
 * Descriptor fields:
 *   label, hint      the page's line name + one-line description
 *   noun             what messages call it
 *   picker           "bank": export needs a chosen item (detail)
 *   exportPath(d)    GET route → the download; exportName(d, name) → its filename
 *   accept, multiple the file picker
 *   request(files)   → Response
 *   summary(result)  optional message after success
 *   events           sync events to publish after success (the runner adds source + refetch)
 */
import { api } from "../../../../scripts/api.js";
import { formBodyInit } from "../api.js";
import { KRC_SYNC_EVENTS, KRC_SYNC_LANES } from "../sync_bus.js";

const { STRUCTURE } = KRC_SYNC_LANES;

function form(field, files) {
  const data = new FormData();
  for (const file of files) data.append(field, file, file.name);
  return formBodyInit("POST", data);
}

export const WORD_BANK_TEXT_KIND = "word_bank.bank";

const KINDS = [
  {
    kind: WORD_BANK_TEXT_KIND,
    label: "Word Bank .txt",
    hint: "One word bank as a plain word list",
    picker: "bank",
    noun: "word banks",
    exportPath: (bankId) => `/wordbank/banks/${encodeURIComponent(bankId)}/export`,
    exportName: (bankId, bankName) => `${bankName || bankId || "word_bank"}.txt`,
    accept: ".txt",
    multiple: true,
    request: (files) => api.fetchApi("/wordbank/banks/import", form("files", files)),
    summary: (result) => {
      const rejected = Array.isArray(result?.rejected) ? result.rejected : [];
      return rejected.length
        ? `Some files were not imported as word banks:\n\n${rejected.map((r) => `• ${r.name}: ${r.reason}`).join("\n")}`
        : "";
    },
    events: [{ name: KRC_SYNC_EVENTS.WORDBANK_BANKS_CHANGED, lane: STRUCTURE }],
  },
];

const BY_KIND = new Map(KINDS.map((entry) => [entry.kind, entry]));

export function transferKind(kind) {
  return BY_KIND.get(kind) || null;
}

async function fetchJson(path, fallback) {
  try {
    const response = await api.fetchApi(path);
    return response.ok ? await response.json() : fallback;
  } catch {
    return fallback;
  }
}

// The registered Loadout Kits (GET /krc/loadout/kits), sorted by label. → [{ id, label, … }]
export async function loadKits() {
  const kits = await fetchJson("/krc/loadout/kits", {});
  return (kits && typeof kits === "object" ? Object.values(kits) : [])
    .filter((descriptor) => descriptor?.id)
    .sort((a, b) => String(a.label || a.id).localeCompare(String(b.label || b.id), undefined, { sensitivity: "base" }));
}

const byLabel = (a, b) => a[1].localeCompare(b[1], undefined, { sensitivity: "base" });

// The items a picker chooses from → [[value, label]] (sorted): Prompt Vault categories
// (the bundle's category subset) and Word Bank banks (the bundle's bank subset and the .txt export).
export const TRANSFER_PICKERS = Object.freeze({
  category: {
    placeholder: "Choose a category",
    load: async (profileId = "default") => {
      const prompts = await fetchJson(`/krc/prompt-vault/get-prompts?profile=${encodeURIComponent(profileId)}`, {});
      const names = prompts && typeof prompts === "object" && !prompts.error ? Object.keys(prompts) : [];
      return names.map((name) => [name, name]).sort(byLabel);
    },
  },
  bank: {
    placeholder: "Choose a bank",
    load: async () => {
      const banks = await fetchJson("/wordbank/banks", []);
      return (Array.isArray(banks) ? banks : [])
        .map((bank) => (typeof bank === "string" ? [bank, bank] : [String(bank?.id || ""), String(bank?.name || bank?.id || "")]))
        .filter(([value]) => value)
        .sort(byLabel);
    },
  },
});

// → the server's transfer history, { kind: { lastExportMs, lastImportMs, … } }, or null.
export async function fetchTransferHistory() {
  const payload = await fetchJson("/krc/transfer/history", null);
  return payload?.ok ? payload.kinds || {} : null;
}
