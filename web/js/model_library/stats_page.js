/*
 * Stats — the home-menu page on the Info Panel side (ML node + Portal): a library
 * overview computed from the loaded list. An Info Panel page (info_page.js), so it
 * sits beside the browser instead of covering it, and it recomputes on every panel
 * render (a library reload refreshes the numbers while it's open).
 *
 * Health cells with a matching search are buttons: a click goes to HOME with that search
 * (e.g. missing:thumb), which lists the matching models from every type. "Your KRC" is
 * the rest of krc.db (prompts, presets, banks, the database and its backups), read from
 * GET /krc/db/summary when the page opens.
 */
import { makeNodeApi } from "../shared/api.js";
import { el } from "../shared/dom.js";
import { infoPageSection } from "./info_page.js";

export const STATS_PAGE = "stats";

const { getSharedJson } = makeNodeApi("/krc/db");

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function sizeText(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024 * 1024) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// `onClick` makes the cell a button (the clickable health cells).
function statCell(label, value, sub = "", onClick = null) {
  const cell = onClick
    ? el("button", "krc-stats-cell is-clickable", { type: "button", title: `Show these models (${label})` })
    : el("div", "krc-stats-cell");
  if (onClick) cell.addEventListener("click", onClick);
  cell.append(
    el("div", "krc-stats-value", { textContent: String(value) }),
    el("div", "krc-stats-label", { textContent: label }),
  );
  if (sub) cell.append(el("div", "krc-stats-sub", { textContent: sub }));
  return cell;
}

function statGrid(cells = []) {
  const grid = el("div", "krc-stats-grid");
  grid.append(...cells);
  return grid;
}

function typeStatsList(typeBreakdown = [], empty = "No scanned models yet.") {
  const list = el("div", "krc-stats-type-list");
  if (!typeBreakdown.length) {
    list.append(el("div", "krc-stats-empty", { textContent: empty }));
    return list;
  }
  typeBreakdown.forEach((row) => {
    const item = el("div", "krc-stats-type-row");
    item.append(
      el("span", "krc-stats-type-name", { textContent: row.label }),
      el("span", "krc-stats-type-count", { textContent: String(row.count) }),
    );
    list.append(item);
  });
  return list;
}

export const statsPageMethods = {
  openStatsPage() {
    this._krcSummary = null; // fresh counts each time the page opens
    this.openInfoPage(STATS_PAGE);
  },

  // GET /krc/db/summary once per opening; the page re-renders when it arrives.
  loadKrcSummary() {
    if (this._krcSummaryLoading) return;
    this._krcSummaryLoading = true;
    getSharedJson("/summary")
      .then(({ ok, data }) => { this._krcSummary = ok && data ? data : { error: true }; })
      .catch(() => { this._krcSummary = { error: true }; })
      .finally(() => {
        this._krcSummaryLoading = false;
        if (this.infoPage === STATS_PAGE) this.refreshInfo();
      });
  },

  // A health cell's click: HOME with that search, which lists matches from every type.
  showStatsSearch(query) {
    this.leaveHome?.();   // from the Portal's Home tab: to the Models tab first
    this.setFolder("__model_home__");
    this.query = query;
    this.refreshBrowser({ focusSelection: false });
  },

  krcSummarySection() {
    const summary = this._krcSummary;
    if (!summary) {
      this.loadKrcSummary();
      return infoPageSection("Your KRC", el("div", "krc-stats-empty", { textContent: "Counting…" }));
    }
    if (summary.error) {
      return infoPageSection("Your KRC", el("div", "krc-stats-empty", { textContent: "Couldn't read the totals from the server." }));
    }
    const backups = summary.backups || {};
    const latest = backups.newestMs ? new Date(backups.newestMs).toLocaleString() : "";
    return infoPageSection("Your KRC",
      statGrid([
        statCell("Prompts", summary.prompts ?? 0, `${summary.promptCategories ?? 0} ${(summary.promptCategories ?? 0) === 1 ? "category" : "categories"} · ${summary.promptProfiles ?? 1} ${(summary.promptProfiles ?? 1) === 1 ? "profile" : "profiles"}`),
        statCell("Word Bank banks", summary.wordBanks ?? 0),
        statCell("Collections", summary.collections ?? 0),
        statCell("Database", sizeText(summary.databaseBytes),
          backups.count ? `${plural(backups.count, "backup")}${latest ? ` · latest ${latest}` : ""}` : "no backup yet"),
      ]),
      el("div", "krc-stats-subtitle", { textContent: "Presets" }),
      typeStatsList((summary.presets || []).map((row) => ({ label: row.label, count: row.count })), "No presets yet."),
    );
  },

  modelLibraryStats() {
    const items = this.loras || [];
    const files = items.reduce((total, item) => total + Math.max(1, Number(item.duplicateCount || 0)), 0);
    const typeRows = (this.folders || []).filter((folder) =>
      folder.parent === "__model_home__" &&
      folder.name !== "__model_home__" &&
      folder.kind === "type"
    );
    const typeLabels = Object.fromEntries(typeRows.map((row) => [row.modelType || "", row.label || row.modelType || "Other"]));
    const byType = new Map();
    items.forEach((item) => {
      const type = item.modelType || "other";
      const current = byType.get(type) || { type, label: typeLabels[type] || type, count: 0 };
      current.count += 1;
      byType.set(type, current);
    });
    const typeBreakdown = Array.from(byType.values())
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
    return {
      total: items.length,
      files,
      typeBreakdown,
      favorites: items.filter((item) => item.favorite).length,
      missingThumbnails: items.filter((item) => !item.thumbnail).length,
      customBadges: items.filter((item) => item.customBadge).length,
      missingFiles: items.filter((item) => item.unavailable).length,
      animated: items.filter((item) => item.thumbnailHasAnimation).length,
      noMetadata: items.filter((item) => !(item.originalName || item.version || item.creator?.username)).length,
      duplicateGroups: items.filter((item) => (item.duplicateCount || 0) > 1).length,
      duplicateFiles: items.reduce((total, item) => total + Math.max(0, Number(item.duplicateCount || 0) - 1), 0),
      unstabilized: items.filter((item) => this.isGenericModel?.(item) && String(item.sha256 || "").startsWith("local-")).length,
      used: items.filter((item) => Number(item.useCount || 0) > 0).length,
    };
  },

  renderStatsPage() {
    const stats = this.modelLibraryStats();
    const { panel, body } = this.infoPageShell("Stats", "krc-stats-page");
    const show = (query) => () => this.showStatsSearch(query);
    body.append(
      infoPageSection("Overview", statGrid([
        statCell("Models", stats.total),
        statCell("Files", stats.files),
        statCell("Types", stats.typeBreakdown.length),
        statCell("Used", stats.used),
      ])),
      infoPageSection("Model Types", typeStatsList(stats.typeBreakdown)),
      infoPageSection("Library Health", statGrid([
        statCell("Missing thumbs", stats.missingThumbnails, "", show("missing:thumb")),
        statCell("Missing files", stats.missingFiles, "", show("missing:file")),
        statCell("No metadata", stats.noMetadata, "never fetched", show("missing:metadata")),
        statCell("Duplicate groups", stats.duplicateGroups, stats.duplicateFiles ? plural(stats.duplicateFiles, "extra file") : "", show("duplicates")),
        statCell("Unstabilized", stats.unstabilized),
        statCell("Animated thumbs", stats.animated, "", show("has:animated")),
        statCell("Badges", stats.customBadges, "", show("has:badge")),
        statCell("Favorites", stats.favorites, "", show("has:favorite")),
      ])),
      this.krcSummarySection(),
    );
    return panel;
  },
};
