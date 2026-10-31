/*
 * Extra Options — the KRC Portal's page for KRC sibling packs (KRC NodePack Extras, future
 * KRC packs; KRC_PACKS_GAMEPLAN.md). Opened from the home-menu card right after Options,
 * which only exists while GET /krc/packs lists a pack. One section per pack: version +
 * status, the problem when it isn't OK, its nodes (missing ones dimmed), then the
 * settings it registered through krc_packs.js (same rows as the Options page).
 */
import { el } from "../shared/dom.js";
import {
  krcPacksSnapshot,
  loadKrcPacks,
  onPackOptionsChanged,
  packOptionSections,
  PACK_STATUS_LABELS,
} from "../krc_packs.js";
import { infoPageSection } from "./info_page.js";
import { settingRow } from "./options_page.js";

export const EXTRA_OPTIONS_PAGE = "extraOptions";

function packSection(pack) {
  const head = el("div", "krc-pack-head");
  const version = pack.version ? `Version ${pack.version}` : "Version unknown";
  head.append(
    el("span", "krc-pack-version", { textContent: `${version} · ${pack.folder}` }),
    el("span", `krc-pack-status is-${pack.status}`, { textContent: PACK_STATUS_LABELS[pack.status] || pack.status }),
  );
  const parts = [head];
  if (pack.problem) parts.push(el("div", "krc-options-description krc-pack-problem", { textContent: pack.problem }));
  if (pack.duplicates?.length) {
    parts.push(el("div", "krc-options-description krc-pack-problem", {
      textContent: `Also installed in ${pack.duplicates.join(", ")} (ignored). Remove the extra copy.`,
    }));
  }
  if (pack.nodes?.length) {
    const nodes = el("div", "krc-pack-nodes");
    pack.nodes.forEach((node) => {
      const chip = el("span", "krc-pack-node", { textContent: node.name });
      chip.classList.toggle("is-missing", !node.loaded);
      chip.title = node.loaded ? "Loaded" : "Not loaded - see the ComfyUI console";
      nodes.append(chip);
    });
    parts.push(nodes);
  }
  const sections = [infoPageSection(pack.name, parts)];
  packOptionSections(pack.id).forEach((group) => {
    sections.push(infoPageSection(group.title ? `${pack.name} · ${group.title}` : pack.name, group.rows.map(settingRow)));
  });
  return sections;
}

export const extraOptionsPageMethods = {
  openExtraOptionsPage() {
    this.openInfoPage(EXTRA_OPTIONS_PAGE);
  },

  // Once per panel: when the pack list arrives (or a pack registers options), show the
  // home card / re-render the page.
  ensureKrcPacksWatched() {
    if (this._krcPacksWatched) return;
    this._krcPacksWatched = true;
    const refresh = () => {
      if (this._destroyed) return;
      if (this.folder === "__model_home__") this.scheduleBrowserResultsRefresh?.();
      if (this.infoPage === EXTRA_OPTIONS_PAGE) this.refreshInfo();
    };
    loadKrcPacks().then((packs) => { if (packs.length) refresh(); });
    this._krcPacksOptionsCleanup = onPackOptionsChanged(refresh);
  },

  // The home card, or null while no KRC pack is installed (or the list hasn't loaded).
  extraOptionsHomeItem() {
    this.ensureKrcPacksWatched();
    const packs = krcPacksSnapshot() || [];
    if (!packs.length) return null;
    const problems = packs.filter((pack) => pack.status !== "ok").length;
    return {
      id: "extra-options",
      name: "Extra Options",
      subtitle: problems
        ? `${problems} KRC pack${problems === 1 ? "" : "s"} need${problems === 1 ? "s" : ""} attention`
        : packs.map((pack) => pack.name).join(", "),
      cardColor: problems ? "red" : "black",
      glyphClass: "krc-gear-glyph",
      action: () => this.openPortalPage(EXTRA_OPTIONS_PAGE),
    };
  },

  renderExtraOptionsPage() {
    this.ensureKrcPacksWatched();
    const { panel, body } = this.infoPageShell("Extra Options", "krc-options-page krc-extra-options-page");
    body.classList.add("krc-options-host");
    const packs = krcPacksSnapshot();
    if (!packs) {
      body.append(infoPageSection("", el("div", "krc-options-description", { textContent: "Loading KRC packs…" })));
    } else if (!packs.length) {
      body.append(infoPageSection("", el("div", "krc-options-description", { textContent: "No other KRC packs are installed." })));
    } else {
      packs.forEach((pack) => body.append(...packSection(pack)));
    }
    return panel;
  },
};
