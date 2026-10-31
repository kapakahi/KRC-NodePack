/*
 * KRC global settings, as data — the sections and rows of the KRC Portal's Options
 * page (model_library/options_page.js). GLOBAL_OPTIONS_PAGE_GAMEPLAN.md §2.
 *
 * Each row is one ComfyUI setting (the IDs in settings.js; values persist in ComfyUI's
 * settings store). Row fields:
 *   id           the ComfyUI setting id
 *   kind         "switch" | "combo" | "text" | "action"
 *   label, desc  the row's name and its one-line description
 *   options      combo only: [[value, label], …], or a function returning them
 *   defaultValue the value when nothing is stored
 *
 * The Portal section (info panel default, click outside) is the Portal's own UI store
 * (shared/library_modal.js), and the ffmpeg status sits under the Media rows; the page
 * adds both.
 *
 * krc_theme.js registers every non-action row as a hidden ComfyUI setting (so ComfyUI's
 * Settings dialog lists none of them) with its change handler; the page reads and writes
 * through readGlobalSetting / writeGlobalSetting, so those handlers still fire.
 */
import { app } from "../../../scripts/app.js";
import { PALETTES, DEFAULT_PALETTE_ID, portalPaletteOptions } from "./palettes.js";
import { NETWORK_CONSENT_SETTING_ID, NETWORK_CONSENT_DEFAULT } from "./network_consent.js";
import {
  THEME_SETTING_ID,
  PORTAL_THEME_SETTING_ID,
  PORTAL_THEME_DEFAULT,
  SHOW_NSFW_SETTING_ID,
  SHOW_NSFW_DEFAULT,
  NSFW_DISPLAY_MODE_SETTING_ID,
  NSFW_DISPLAY_MODE_DEFAULT,
  LOG_LORA_NAMES_SETTING_ID,
  LOG_LORA_NAMES_DEFAULT,
  ENABLE_WEBM_THUMBNAILS_SETTING_ID,
  ENABLE_WEBM_THUMBNAILS_DEFAULT,
  WEBM_AUTOPLAY_SETTING_ID,
  WEBM_AUTOPLAY_DEFAULT,
  THUMBNAIL_PREVIEW_SETTING_ID,
  THUMBNAIL_PREVIEW_DEFAULT,
  THUMBNAIL_FRAMING_SETTING_ID,
  THUMBNAIL_FRAMING_DEFAULT,
  THUMBNAIL_FRAMING_OPTIONS,
  VIDEO_IMPORT_MODE_SETTING_ID,
  VIDEO_IMPORT_MODE_DEFAULT,
  VIDEO_IMPORT_MODE_OPTIONS,
  VIDEO_POSTER_FRAME_SETTING_ID,
  VIDEO_POSTER_FRAME_DEFAULT,
  VIDEO_POSTER_FRAME_OPTIONS,
  VIDEO_WEBM_CRF_SETTING_ID,
  VIDEO_WEBM_CRF_DEFAULT,
  VIDEO_WEBM_CRF_OPTIONS,
  FFMPEG_PATH_SETTING_ID,
  FFMPEG_PATH_DEFAULT,
  AUTO_STABILIZE_SETTING_ID,
  AUTO_STABILIZE_DEFAULT,
  SIDEBAR_BUTTON_SETTING_ID,
  SIDEBAR_BUTTON_DEFAULT,
} from "./settings.js";

export const EXPORT_DIAGNOSTICS_ACTION = "KRC.ExportDiagnostics";

export const GLOBAL_SETTING_SECTIONS = Object.freeze([
  {
    title: "Appearance",
    rows: [
      {
        id: THEME_SETTING_ID,
        kind: "combo",
        label: "Palette",
        desc: "Colour palette for every KRC node. A node can override it in its own Options.",
        options: () => PALETTES.map((palette) => [palette.id, palette.label]),
        defaultValue: DEFAULT_PALETTE_ID,
      },
      {
        id: PORTAL_THEME_SETTING_ID,
        kind: "combo",
        label: "Portal palette",
        desc: "Colour palette for the KRC Portal. Global (default) follows the palette above, using KRC Gray when that's Native.",
        options: portalPaletteOptions,
        defaultValue: PORTAL_THEME_DEFAULT,
      },
      {
        id: SIDEBAR_BUTTON_SETTING_ID,
        kind: "switch",
        label: "KRC button in the sidebar",
        desc: "A green KRC button under Templates in ComfyUI's left toolbar that opens the KRC Portal.",
        defaultValue: SIDEBAR_BUTTON_DEFAULT,
      },
    ],
  },
  {
    title: "Content",
    rows: [
      {
        id: NSFW_DISPLAY_MODE_SETTING_ID,
        kind: "combo",
        label: "NSFW behavior",
        desc: "Hide NSFW browser items, or keep them visible with blurred thumbnails until unblurred in each node.",
        options: [["hide", "Hide items"], ["blur", "Blur thumbnails"]],
        defaultValue: NSFW_DISPLAY_MODE_DEFAULT,
      },
      {
        id: SHOW_NSFW_SETTING_ID,
        kind: "switch",
        label: "Show NSFW by default",
        desc: "New KRC nodes start with NSFW content shown or unblurred, depending on the behavior above. Each node's own NSFW button decides after that.",
        defaultValue: SHOW_NSFW_DEFAULT,
      },
    ],
  },
  {
    title: "Identity",
    rows: [
      {
        id: AUTO_STABILIZE_SETTING_ID,
        kind: "switch",
        label: "Auto-stabilize models",
        desc: "Create a stable SHA256 ID when a model is selected in the Model Library. Reads the whole file, so large models take a while.",
        defaultValue: AUTO_STABILIZE_DEFAULT,
      },
    ],
  },
  {
    title: "Media",
    rows: [
      {
        id: THUMBNAIL_PREVIEW_SETTING_ID,
        kind: "switch",
        label: "Hold thumbnail to preview",
        desc: "Hold left-click on a card thumbnail for a larger preview. Release to close. Applies to browser and external cards.",
        defaultValue: THUMBNAIL_PREVIEW_DEFAULT,
      },
      {
        id: THUMBNAIL_FRAMING_SETTING_ID,
        kind: "combo",
        label: "Thumbnail framing",
        desc: "How all card thumbnails fit their square frames. Updates immediately without changing files. Info Panels always show the full image.",
        options: THUMBNAIL_FRAMING_OPTIONS,
        defaultValue: THUMBNAIL_FRAMING_DEFAULT,
      },
      {
        id: ENABLE_WEBM_THUMBNAILS_SETTING_ID,
        kind: "switch",
        label: "Animated thumbnails",
        desc: "Play paired WebM thumbnails in info panels and hold previews. Resting browser cards use the static poster.",
        defaultValue: ENABLE_WEBM_THUMBNAILS_DEFAULT,
      },
      {
        id: WEBM_AUTOPLAY_SETTING_ID,
        kind: "switch",
        label: "Autoplay once",
        desc: "Play one muted loop when an info panel shows an animated thumbnail. Hovering keeps it looping.",
        defaultValue: WEBM_AUTOPLAY_DEFAULT,
      },
      {
        id: VIDEO_IMPORT_MODE_SETTING_ID,
        kind: "combo",
        label: "Video import mode",
        desc: "How an imported video becomes a thumbnail: a static poster, or an animated WebM plus poster (needs ffmpeg with VP9).",
        options: VIDEO_IMPORT_MODE_OPTIONS,
        defaultValue: VIDEO_IMPORT_MODE_DEFAULT,
      },
      {
        id: VIDEO_POSTER_FRAME_SETTING_ID,
        kind: "combo",
        label: "Poster frame",
        desc: "Which video frame becomes the static poster.",
        options: VIDEO_POSTER_FRAME_OPTIONS,
        defaultValue: VIDEO_POSTER_FRAME_DEFAULT,
      },
      {
        id: VIDEO_WEBM_CRF_SETTING_ID,
        kind: "combo",
        label: "WebM quality",
        desc: "Quality of generated WebM thumbnails. Higher quality means larger files.",
        options: VIDEO_WEBM_CRF_OPTIONS,
        defaultValue: VIDEO_WEBM_CRF_DEFAULT,
      },
      {
        id: FFMPEG_PATH_SETTING_ID,
        kind: "text",
        label: "ffmpeg location",
        desc: "Leave empty: KRC finds ffmpeg by itself. Only set this if it can't, with the path to ffmpeg or its folder.",
        placeholder: "Automatic",
        defaultValue: FFMPEG_PATH_DEFAULT,
      },
    ],
  },
  {
    title: "Network",
    rows: [
      {
        id: NETWORK_CONSENT_SETTING_ID,
        kind: "switch",
        label: "Allow internet access",
        desc: "Used for Civitai metadata fetches and HuggingFace imports (and any lookups a KRC pack lists below). Off: KRC and its packs make no external calls.",
        defaultValue: NETWORK_CONSENT_DEFAULT,
      },
    ],
  },
  {
    title: "Support",
    rows: [
      {
        id: EXPORT_DIAGNOSTICS_ACTION,
        kind: "action",
        label: "Diagnostics",
        desc: "Download a privacy-safe JSON report: KRC node counts, DOM and cache summaries, rough memory estimates.",
        actionLabel: "Export",
      },
      {
        id: LOG_LORA_NAMES_SETTING_ID,
        kind: "switch",
        label: "Log loaded LoRA names",
        desc: "The LoRA Loadout Loader logs loaded LoRA names and strengths. Off logs counts only.",
        defaultValue: LOG_LORA_NAMES_DEFAULT,
      },
    ],
  },
]);

export function settingOptions(row) {
  return typeof row.options === "function" ? row.options() : row.options || [];
}

export function readGlobalSetting(id, fallback) {
  const setting = app.extensionManager?.setting;
  const value = setting?.get ? setting.get(id) : app.ui?.settings?.getSettingValue?.(id, fallback);
  return value === undefined || value === null ? fallback : value;
}

// "Show NSFW by default" only sets where a NEW node's NSFW eye starts; after that the
// node's own eye decides, and changing the option leaves existing nodes alone.
export function newNodeShowsNsfw() {
  return !!readGlobalSetting(SHOW_NSFW_SETTING_ID, SHOW_NSFW_DEFAULT);
}

// Writes through ComfyUI so the setting's own onChange (krc_theme.js) runs: palette
// repaint, NSFW events, the server sync of the video settings and network consent.
export async function writeGlobalSetting(id, value) {
  const setting = app.extensionManager?.setting;
  if (setting?.set) {
    await setting.set(id, value);
  } else {
    app.ui?.settings?.setSettingValue?.(id, value);
  }
}
