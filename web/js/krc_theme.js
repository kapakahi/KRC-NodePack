import { installThumbnailPreview, setThumbnailPreviewEnabled, setThumbnailPreviewAnimated } from "./shared/thumbnail_preview.js";
/*
 * KRC global settings — registration and what each one does when it changes.
 *
 * Every KRC setting is a hidden ComfyUI setting (stored by ComfyUI, not listed in its
 * Settings dialog), registered from shared/global_settings.js; the KRC Portal's
 * Options page changes them. GLOBAL_OPTIONS_PAGE_GAMEPLAN.md.
 *
 * Palette: the default purple palette lives in shared/design_tokens.css (:root);
 * alternate palettes live in shared/themes.css, each scoped by
 * data-krc-theme="<id>". Selecting a palette just sets that attribute on the
 * document root — all KRC node UIs recolor because every color resolves through
 * the --krc-* tokens. Individual nodes can override this per-node via
 * shared/node_palette.js.
 *
 * The palette list (PALETTES) lives in shared/palettes.js, shared with the
 * per-node switcher. To add a palette: define its block in shared/themes.css,
 * then add an { id, label } entry there.
 */
import { app } from "../../scripts/app.js";
import { NETWORK_CONSENT_SETTING_ID, NETWORK_CONSENT_DEFAULT } from "./shared/network_consent.js";
import { api } from "../../scripts/api.js";
import { DEFAULT_ID, DEFAULT_PALETTE_ID, setGlobalPalette } from "./shared/palettes.js";
import { refreshAllNodeCanvasColors } from "./shared/node_palette.js";
import { ensureStylesheets, SHARED_STYLE_VERSION } from "./shared/stylesheets.js";
import {
  THEME_SETTING_ID,
  PORTAL_THEME_SETTING_ID,
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
  VIDEO_IMPORT_MODE_SETTING_ID,
  VIDEO_IMPORT_MODE_DEFAULT,
  VIDEO_POSTER_FRAME_SETTING_ID,
  VIDEO_POSTER_FRAME_DEFAULT,
  VIDEO_WEBM_CRF_SETTING_ID,
  VIDEO_WEBM_CRF_DEFAULT,
  AUTO_STABILIZE_SETTING_ID,
  SIDEBAR_BUTTON_SETTING_ID,
  SIDEBAR_BUTTON_CHANGED_EVENT,
} from "./shared/settings.js";
import { applyThumbnailFraming } from "./shared/thumbnail_presentation.js";
import { GLOBAL_SETTING_SECTIONS } from "./shared/global_settings.js";
import { installKrcStatsAggregator } from "./shared/memory_stats.js";

const SETTING_ID = THEME_SETTING_ID;
const NSFW_SETTING_ID = SHOW_NSFW_SETTING_ID;
const NSFW_DISPLAY_MODE_SETTING = NSFW_DISPLAY_MODE_SETTING_ID;
const LORA_LOG_SETTING_ID = LOG_LORA_NAMES_SETTING_ID;
const WEBM_THUMBNAILS_SETTING_ID = ENABLE_WEBM_THUMBNAILS_SETTING_ID;

// Server-side video-thumbnail GENERATION settings mirror into the shared store the
// node backends read (utils/krc_video_settings.py) — changing one POSTs the new value
// so headless/lazy generation stays in sync. Distinct from the two display toggles
// (purely client-side). Applies to LoRA Loadout and Prompt Vault alike. IDs + option
// lists live in shared/settings.js.

function postVideoSettings(patch) {
  // Best-effort: the ComfyUI setting is the source of truth; if the POST fails the
  // server keeps its last value and re-syncs on the next change / startup.
  // → the server's reply ({settings, capability?}) or null.
  try {
    return api.fetchApi("/krc/lora-loadout/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  } catch (_err) {
    return Promise.resolve(null);
  }
}

function postNetworkConsent(value) {
  // Sync the master switch to the server so the egress guard can read it. Best-effort:
  // the ComfyUI setting is the source of truth; a failed POST re-syncs on next change/startup.
  try {
    api.fetchApi("/krc/network/consent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allowInternet: !!value }),
    });
  } catch (_err) { /* ignore */ }
}

function injectThemeStyles() {
  // Both are :root-level and idempotent; loading here means the palette works
  // even on pages where no token-consuming node has mounted yet.
  ensureStylesheets([
    { id: "krc-shared-tokens", path: "./shared/design_tokens.css", version: SHARED_STYLE_VERSION },
    { id: "krc-shared-themes", path: "./shared/themes.css", version: SHARED_STYLE_VERSION },
  ], import.meta.url);
}

function applyPalette(id) {
  const effective = !id || id === DEFAULT_ID ? DEFAULT_ID : id;
  setGlobalPalette(effective);
  const root = document.documentElement;
  if (effective === DEFAULT_ID) {
    delete root.dataset.krcTheme;
  } else {
    root.dataset.krcTheme = effective;
  }
  // The DOM recolors from CSS automatically. The canvas chrome is fixed dark for
  // every palette except Native — repaint each KRC node so it flips in/out of
  // Native's leave-the-canvas-alone behavior when the global palette changes.
  refreshAllNodeCanvasColors(app.graph);
  // The Portal, when it follows the global palette, swaps Native for Gray.
  window.dispatchEvent(new CustomEvent("krc-global-palette-changed", { detail: { id: effective } }));
}

// The KRC Portal's own palette (shared/library_modal.js listens).
function applyPortalPalette(value) {
  window.dispatchEvent(new CustomEvent("krc-portal-palette-changed", { detail: { id: String(value || "") } }));
}

function applyNsfwDefault(value) {
  window.dispatchEvent(new CustomEvent("krc-global-nsfw-default-changed", {
    detail: {
      showNsfw: !!value,
      displayMode: getSettingValue(NSFW_DISPLAY_MODE_SETTING, NSFW_DISPLAY_MODE_DEFAULT),
    },
  }));
}

function applyNsfwDisplayMode(value) {
  window.dispatchEvent(new CustomEvent("krc-global-nsfw-default-changed", {
    detail: {
      showNsfw: !!getSettingValue(NSFW_SETTING_ID, SHOW_NSFW_DEFAULT),
      displayMode: value === "blur" ? "blur" : "hide",
    },
  }));
}

// The loaders read this option on the server (utils/krc_log_settings.py). Best-effort:
// the ComfyUI setting is the source of truth and re-syncs on the next change / startup.
function applyLoraNameLogging(value) {
  try {
    api.fetchApi("/krc/lora-loadout/log-names", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !!value }),
    });
  } catch (_err) { /* ignore */ }
}

function applyWebmThumbnails(value) {
  setThumbnailPreviewAnimated(value);
  window.dispatchEvent(new CustomEvent("krc-webm-thumbnails-changed", {
    detail: { enabled: !!value },
  }));
}

// Model Library panels listen: on stabilizes the current selection, off cancels a
// pending one. Only a real change counts: ComfyUI may report the stored value at load
// (no previous value), and that must not start hashing a large model by itself.
function applyAutoStabilize(value, previous) {
  if (previous === undefined || !!value === !!previous) return;
  window.dispatchEvent(new CustomEvent("krc-auto-stabilize-changed", {
    detail: { enabled: !!value },
  }));
}

// krc_sidebar_button.js adds or removes its button.
function applySidebarButton(value) {
  window.dispatchEvent(new CustomEvent(SIDEBAR_BUTTON_CHANGED_EVENT, { detail: { enabled: !!value } }));
}

function applyWebmAutoplay(value) {
  window.dispatchEvent(new CustomEvent("krc-webm-thumbnail-autoplay-changed", {
    detail: { enabled: !!value },
  }));
}

function getSettingValue(id, fallback) {
  const setting = app.extensionManager?.setting;
  if (setting?.get) {
    return setting.get(id);
  }
  return app.ui?.settings?.getSettingValue?.(id, fallback);
}

// Guard against the recurring footgun: ComfyUI keys settings groups by the full
// category path AND by id, so two entries colliding on either are silently merged —
// the later registration wins and the earlier setting vanishes with no error. This has bitten us multiple times when adding new settings. Fail loudly here
// (dev console) the instant a collision is introduced, instead of discovering it by a
// setting mysteriously not showing up.
function validateKrcSettings(settings) {
  const seenId = new Map();
  const seenPath = new Map();
  for (const s of settings) {
    if (!s || !s.id) {
      console.error("[KRC Theme] Setting is missing an id (it will not register):", s);
      continue;
    }
    if (seenId.has(s.id)) {
      console.error(`[KRC Theme] Duplicate setting id "${s.id}": "${s.name}" collides with "${seenId.get(s.id)}". One will be hidden.`);
    } else {
      seenId.set(s.id, s.name);
    }
    const path = Array.isArray(s.category) ? s.category.join(" / ") : String(s.category);
    if (seenPath.has(path)) {
      console.error(`[KRC Theme] Duplicate setting category path "${path}": "${s.name}" collides with "${seenPath.get(path)}". One will be hidden; give it a unique last segment.`);
    } else {
      seenPath.set(path, s.name);
    }
  }
  return settings;
}

// What each setting does when it changes (the page, or a value restored at load).
const SETTING_HANDLERS = {
  [THUMBNAIL_PREVIEW_SETTING_ID]: setThumbnailPreviewEnabled,
  [SETTING_ID]: (value) => applyPalette(value),
  [PORTAL_THEME_SETTING_ID]: (value) => applyPortalPalette(value),
  [NSFW_DISPLAY_MODE_SETTING]: (value) => applyNsfwDisplayMode(value),
  [NSFW_SETTING_ID]: (value) => applyNsfwDefault(value),
  [NETWORK_CONSENT_SETTING_ID]: (value) => postNetworkConsent(value),
  [LORA_LOG_SETTING_ID]: (value) => applyLoraNameLogging(value),
  [WEBM_THUMBNAILS_SETTING_ID]: (value) => applyWebmThumbnails(value),
  [WEBM_AUTOPLAY_SETTING_ID]: (value) => applyWebmAutoplay(value),
  [THUMBNAIL_FRAMING_SETTING_ID]: (value) => applyThumbnailFraming(value),
  [VIDEO_IMPORT_MODE_SETTING_ID]: (value) => postVideoSettings({ videoImportMode: value }),
  [VIDEO_POSTER_FRAME_SETTING_ID]: (value) => postVideoSettings({ posterFrame: value }),
  [VIDEO_WEBM_CRF_SETTING_ID]: (value) => postVideoSettings({ webmCrf: Number(value) }),
  [AUTO_STABILIZE_SETTING_ID]: (value, previous) => applyAutoStabilize(value, previous),
  [SIDEBAR_BUTTON_SETTING_ID]: (value) => applySidebarButton(value),
};

// Every KRC setting, from the Portal Options page's descriptors (shared/global_settings.js).
// Registered as hidden: ComfyUI stores the values and runs onChange, but its Settings
// dialog lists none of them — the KRC Portal's Options page is where they're changed
// (GLOBAL_OPTIONS_PAGE_GAMEPLAN.md). Action rows (Export diagnostics) aren't settings.
const KRC_SETTINGS = GLOBAL_SETTING_SECTIONS.flatMap((section) => section.rows
  .filter((row) => row.kind !== "action")
  .map((row) => ({
    id: row.id,
    category: ["KRC NodePack", section.title, row.label],
    name: row.label,
    tooltip: row.desc,
    type: "hidden",
    defaultValue: row.defaultValue,
    ...(SETTING_HANDLERS[row.id] ? { onChange: SETTING_HANDLERS[row.id] } : {}),
  })));

app.registerExtension({
  name: "KRC.Theme",
  settings: validateKrcSettings(KRC_SETTINGS),

  setup() {
    injectThemeStyles();
    installThumbnailPreview();
    setThumbnailPreviewEnabled(getSettingValue(THUMBNAIL_PREVIEW_SETTING_ID, THUMBNAIL_PREVIEW_DEFAULT));
    applyThumbnailFraming(getSettingValue(THUMBNAIL_FRAMING_SETTING_ID, THUMBNAIL_FRAMING_DEFAULT));
    installKrcStatsAggregator();
    applyPalette(getSettingValue(SETTING_ID, DEFAULT_PALETTE_ID));
    applyNsfwDisplayMode(getSettingValue(NSFW_DISPLAY_MODE_SETTING, NSFW_DISPLAY_MODE_DEFAULT));
    applyNsfwDefault(getSettingValue(NSFW_SETTING_ID, SHOW_NSFW_DEFAULT));
    applyLoraNameLogging(getSettingValue(LORA_LOG_SETTING_ID, LOG_LORA_NAMES_DEFAULT));
    applyWebmThumbnails(getSettingValue(WEBM_THUMBNAILS_SETTING_ID, ENABLE_WEBM_THUMBNAILS_DEFAULT));
    applyWebmAutoplay(getSettingValue(WEBM_AUTOPLAY_SETTING_ID, WEBM_AUTOPLAY_DEFAULT));
    // Push the generation settings to the server once at startup so its shared
    // store matches the ComfyUI settings even if one was changed while no node was
    // mounted (the endpoint is registered at node-module import, so it's ready).
    postVideoSettings({
      videoImportMode: getSettingValue(VIDEO_IMPORT_MODE_SETTING_ID, VIDEO_IMPORT_MODE_DEFAULT),
      posterFrame: getSettingValue(VIDEO_POSTER_FRAME_SETTING_ID, VIDEO_POSTER_FRAME_DEFAULT),
      webmCrf: Number(getSettingValue(VIDEO_WEBM_CRF_SETTING_ID, VIDEO_WEBM_CRF_DEFAULT)),
    });
    // Sync the network-consent master switch too, so the server guard matches the UI
    // even if it was toggled while no node was mounted.
    postNetworkConsent(getSettingValue(NETWORK_CONSENT_SETTING_ID, NETWORK_CONSENT_DEFAULT));
  },
});
