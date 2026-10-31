/*
 * Shared identifiers + defaults for the ComfyUI `app.ui.settings` entries that
 * KRC NodePack registers. These strings are the contract between the code that
 * REGISTERS a setting (krc_theme.js) and every node that READS it (LoRA Loadout,
 * Prompt Vault). A mismatch fails silently — getSettingValue just returns the
 * default — so both sides must import from here rather than hardcode the literal.
 */
export const THEME_SETTING_ID = "KRC.Theme";
// The KRC Portal's own palette. "" follows the global palette (Gray when that's Native).
export const PORTAL_THEME_SETTING_ID = "KRC.PortalTheme";
export const PORTAL_THEME_DEFAULT = "";
export const SHOW_NSFW_SETTING_ID = "KRC.ShowNSFW";
export const NSFW_DISPLAY_MODE_SETTING_ID = "KRC.NsfwDisplayMode";
export const LOG_LORA_NAMES_SETTING_ID = "KRC.LogLoraNames";
export const ENABLE_WEBM_THUMBNAILS_SETTING_ID = "KRC.EnableWebMThumbnails";

// NSFW browser items are hidden unless the global setting is on.
export const SHOW_NSFW_DEFAULT = false;
export const NSFW_DISPLAY_MODE_DEFAULT = "hide";

// Loaded LoRA names can reveal private model libraries, so logs are count-only
// unless the user explicitly enables detailed Loadout logging.
export const LOG_LORA_NAMES_DEFAULT = false;

// Animated WebM thumbnails are opt-out; when disabled, nodes use the paired
// static WebP poster/fallback when one exists.
export const ENABLE_WEBM_THUMBNAILS_DEFAULT = true;

// Server-side video-thumbnail GENERATION settings (mirrored to
// utils/krc_video_settings.py by krc_theme.js). Shown on the Portal's Options page AND
// inline on its Civitai Fetch page — both read these option lists ([value, label]) so
// the two surfaces can never offer different choices.
export const VIDEO_IMPORT_MODE_SETTING_ID = "KRC.VideoImportMode";
export const VIDEO_IMPORT_MODE_DEFAULT = "animated";
export const VIDEO_IMPORT_MODE_OPTIONS = [
  ["static", "Static poster (webp)"],
  ["animated", "Animated (webm + poster)"],
];
export const VIDEO_POSTER_FRAME_SETTING_ID = "KRC.VideoPosterFrame";
export const VIDEO_POSTER_FRAME_DEFAULT = "first";
export const VIDEO_POSTER_FRAME_OPTIONS = [
  ["first", "First frame"],
  ["middle", "Middle frame"],
  ["last", "Last frame"],
];
export const VIDEO_WEBM_CRF_SETTING_ID = "KRC.VideoWebmCrf";
export const VIDEO_WEBM_CRF_DEFAULT = 42;
export const VIDEO_WEBM_CRF_OPTIONS = [
  [48, "Very low (CRF 48)"],
  [46, "Low (CRF 46)"],
  [42, "Medium (CRF 42)"],
  [36, "High (CRF 36)"],
];

// Where ffmpeg lives, for the rare case KRC can't find one by itself (PATH or an
// installed imageio-ffmpeg). Empty = automatic. Mirrored to the server's video settings in krc.db
// (`ffmpegPath`) like the settings above; see FFMPEG_DETECTION_GAMEPLAN.md.
export const FFMPEG_PATH_SETTING_ID = "KRC.FfmpegPath";
export const FFMPEG_PATH_DEFAULT = "";

// Model Library auto-stabilize: one global switch (GLOBAL_OPTIONS_PAGE_GAMEPLAN.md §1.2)
// instead of a per-node property. Off = IDs are created only on demand.
export const AUTO_STABILIZE_SETTING_ID = "KRC.AutoStabilizeModels";
export const AUTO_STABILIZE_DEFAULT = false;

// A green KRC button under Templates in ComfyUI's left toolbar (krc_sidebar_button.js).
// Enabled by default; users can hide it in Portal Options.
export const SIDEBAR_BUTTON_SETTING_ID = "KRC.SidebarButton";
export const SIDEBAR_BUTTON_DEFAULT = true;
export const SIDEBAR_BUTTON_CHANGED_EVENT = "krc-sidebar-button-changed";

export const WEBM_AUTOPLAY_SETTING_ID = "KRC.AutoplayWebMThumbnailsOnce";
export const WEBM_AUTOPLAY_DEFAULT = true;

// Global card display preference; thumbnail files retain their full composition.
export const THUMBNAIL_FRAMING_SETTING_ID = "KRC.ThumbnailFraming";
export const THUMBNAIL_FRAMING_DEFAULT = "fill-top";
export const THUMBNAIL_FRAMING_OPTIONS = [
  ["fill-top", "Fill — Top"],
  ["fill-center", "Fill — Center"],
  ["fit", "Fit — Entire Image"],
];

// Temporary enlarged preview while holding a card thumbnail.
export const THUMBNAIL_PREVIEW_SETTING_ID = "KRC.ThumbnailHoldPreview";
export const THUMBNAIL_PREVIEW_DEFAULT = true;
