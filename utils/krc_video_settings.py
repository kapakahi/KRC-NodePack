"""
Shared video-thumbnail GENERATION settings (LoRA Loadout + Prompt Vault).

These drive server-side transcoding, so they live in one shared place — krc.db's
settings (key SETTINGS_KEY, KRC_SQLITE_GAMEPLAN.md stage 4) — and both nodes read the
same value. The UI for them is the KRC Portal's
Options page (hidden ComfyUI settings registered in web/js/krc_theme.js); the client
POSTs changes here so the server stays in sync for headless/lazy generation.

Only GENERATION knobs live here:
  videoImportMode : 'animated' (DEFAULT) webm + poster | 'static' webp poster only.
                    Animated falls back to the poster when ffmpeg lacks VP9.
  posterFrame     : 'first' (DEFAULT) | 'middle' | 'last' — the poster still.
  webmCrf         : VP9 quality, default 42.
  ffmpegPath      : where ffmpeg lives, "" = automatic (krc_video.detect(); see
                    FFMPEG_DETECTION_GAMEPLAN.md). Stored as typed, trimmed.

DISPLAY prefs (enable animated thumbnails, autoplay-once) are separate client-side
ComfyUI settings (KRC.EnableWebMThumbnails / KRC.AutoplayWebMThumbnailsOnce) and are
deliberately NOT stored here. Grid cards never animate (static poster wall), so
there is no card-playback knob.
"""
from pathlib import Path

from .db import library as library_db
from .krc_paths import get_krc_nodes_dir

SETTINGS_FILENAME = "video_settings.json"  # pre-database file (stage-4 import)
SETTINGS_KEY = "video.settings"
_FALLBACK_USER_DIR = Path(__file__).resolve().parents[1] / ".krc_user" / "default"

DEFAULTS = {
    "videoImportMode": "animated",
    "posterFrame": "first",
    "webmCrf": 42,
    "ffmpegPath": "",
}
_FFMPEG_PATH_MAX = 1024

_ENUMS = {
    "videoImportMode": ("static", "animated"),
    "posterFrame": ("first", "middle", "last"),
}
_WEBM_CRF_CLAMP = (30, 52)


def legacy_settings_path():
    """The pre-database settings file, read once by the stage-4 import."""
    return get_krc_nodes_dir(fallback=_FALLBACK_USER_DIR) / SETTINGS_FILENAME


def _coerce(settings):
    """Clean dict: every key present, values validated/clamped, unknown keys dropped.
    Invalid values fall back to the default rather than raising."""
    out = dict(DEFAULTS)
    if isinstance(settings, dict):
        for key, allowed in _ENUMS.items():
            if settings.get(key) in allowed:
                out[key] = settings[key]
        if isinstance(settings.get("ffmpegPath"), str):
            out["ffmpegPath"] = settings["ffmpegPath"].strip()[:_FFMPEG_PATH_MAX]
        if "webmCrf" in settings:
            try:
                lo, hi = _WEBM_CRF_CLAMP
                out["webmCrf"] = max(lo, min(hi, int(settings["webmCrf"])))
            except (TypeError, ValueError):
                pass
    return out


def load_settings():
    try:
        raw = library_db.document_get(SETTINGS_KEY, {})
    except Exception:  # noqa: BLE001 - the defaults always work
        raw = {}
    return _coerce(raw)


def save_settings(updates):
    """Merge `updates` over current settings, validate, persist, return the stored
    result. Partial updates are fine — unspecified keys keep their value."""
    merged = load_settings()
    if isinstance(updates, dict):
        merged.update({
            k: v for k, v in updates.items()
            if k in DEFAULTS and not (k == "ffmpegPath" and not isinstance(v, str))  # junk never wipes a location
        })
    clean = _coerce(merged)
    library_db.document_put(SETTINGS_KEY, clean)
    return clean
