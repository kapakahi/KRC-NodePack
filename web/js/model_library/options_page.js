/*
 * Options — the KRC Portal's global Options page (GLOBAL_OPTIONS_PAGE_GAMEPLAN.md), an
 * Info Panel page (info_page.js) opened from the Portal's home menu. One section per
 * group in shared/global_settings.js, one row per setting, plus the video status under
 * Media and, first, the Portal's own behavior settings. A panel's own Options (palette override,
 * list thumbnails, …) stay behind its gear.
 *
 * Every row writes through the ComfyUI setting (writeGlobalSetting), so the setting's
 * own change handler in krc_theme.js applies it, exactly as ComfyUI's Settings dialog
 * used to. The body carries `krc-options-host`, which the shared switch / description /
 * button styles are scoped to.
 */
import { el } from "../shared/dom.js";
import { menuSelect, switchToggle } from "../shared/browser_controls.js";
import { videoStatusSection } from "../shared/video_status.js";
import { dbStatusSection } from "../shared/db_status.js";
import { externalApiRow } from "../shared/external_api_options.js";
import { networkHostsRow } from "../shared/network_hosts.js";
import { portalOptionsSection } from "../shared/library_modal.js";
import { downloadKrcDiagnostics } from "../shared/memory_stats.js";
import {
  EXPORT_DIAGNOSTICS_ACTION,
  GLOBAL_SETTING_SECTIONS,
  readGlobalSetting,
  settingOptions,
  writeGlobalSetting,
} from "../shared/global_settings.js";
import { profileOptionsSection } from "./profiles_page.js";
import { infoPageSection } from "./info_page.js";

export const OPTIONS_PAGE = "options";

const pageSection = ({ title = "", body = null } = {}) => infoPageSection(title, body);

const ACTIONS = {
  [EXPORT_DIAGNOSTICS_ACTION]: () => downloadKrcDiagnostics(),
};

// A combo stores the option's own type (the WebM quality is a number).
function coerceLike(row, value) {
  return typeof row.defaultValue === "number" ? Number(value) : value;
}

function settingControl(row) {
  const value = readGlobalSetting(row.id, row.defaultValue);
  if (row.kind === "switch") {
    const toggle = switchToggle({
      active: !!value,
      title: row.label,
      onClick: () => {
        const next = !toggle.classList.contains("is-on");
        toggle.classList.toggle("is-on", next);
        writeGlobalSetting(row.id, next);
      },
    });
    return toggle;
  }
  if (row.kind === "combo") {
    return menuSelect({
      className: "krc-setting-select",
      title: row.label,
      value: String(value),
      options: settingOptions(row).map(([optionValue, label]) => [String(optionValue), label]),
      align: "right",
      onChange: (next) => writeGlobalSetting(row.id, coerceLike(row, next)),
    });
  }
  if (row.kind === "text") {
    const input = el("input", "krc-setting-input", {
      type: "text",
      value: String(value || ""),
      placeholder: row.placeholder || "",
      spellcheck: false,
    });
    // Saved when the field is left or Enter is pressed, not per keystroke.
    input.addEventListener("change", () => writeGlobalSetting(row.id, input.value.trim()));
    input.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter") input.blur();
    });
    return input;
  }
  if (row.kind === "action") {
    const button = el("button", "krc-options-reset krc-setting-action", { type: "button", textContent: row.actionLabel || row.label });
    // A pack's action row brings its own onClick (registerPackOptions); NodePack's are in ACTIONS.
    button.addEventListener("click", () => (typeof row.onClick === "function" ? row.onClick : ACTIONS[row.id])?.());
    return button;
  }
  return null;
}

// One setting row (also Extra Options' pack rows, model_library/extra_options_page.js).
export function settingRow(row) {
  const wrap = el("div", "krc-setting-row");
  wrap.dataset.setting = row.id;
  const head = el("div", "krc-setting-head");
  head.append(el("span", "krc-setting-label", { textContent: row.label }), settingControl(row));
  wrap.append(head);
  if (row.desc) wrap.append(el("div", "krc-options-description krc-setting-desc", { textContent: row.desc }));
  return wrap;
}

export const optionsPageMethods = {
  openOptionsPage() {
    this.openInfoPage(OPTIONS_PAGE);
  },

  renderOptionsPage() {
    const { panel, body } = this.infoPageShell("Options", "krc-options-page");
    body.classList.add("krc-options-host");
    // The Portal's own behavior settings lead the page.
    body.append(portalOptionsSection(pageSection), profileOptionsSection());
    for (const group of GLOBAL_SETTING_SECTIONS) {
      const rows = group.rows.map(settingRow);
      // The video status sits with the media settings.
      if (group.title === "Media") rows.push(videoStatusSection(({ body: status }) => status));
      // Where KRC (and its packs) may connect, then a shortcut to KRC Portal ▸ API.
      if (group.title === "Network") rows.push(networkHostsRow(), externalApiRow({ openApiPage: () => this.openPortalPage("api") }));
      // Where KRC keeps its data (krc.db), with the support tools.
      if (group.title === "Support") rows.push(dbStatusSection(({ body: status }) => status));
      body.append(infoPageSection(group.title, rows));
    }
    return panel;
  },
};
