"""
Video → thumbnail for KRC NodePack's cards (LoRA Loadout, Model Library, Prompt Vault).

Everything runs on PyAV, the video library ComfyUI itself requires (its VIDEO type is built
on it), shared with Media (utils/media/process_video.py): nothing is pip-installed and no
ffmpeg program runs, so `dependencies = []` stays literally true.

Two outputs, two capabilities (do NOT collapse them to one bool):
    POSTER_SUPPORT -> PyAV + Pillow: a static WebP poster from one frame
    WEBM_SUPPORT   -> PyAV with the VP9 encoder (libvpx-vp9): the animated loop
capability() returns UI-facing reason codes, never bare bools.

Thumbnail framing shares the pack's proportional image bounds (at most 300x300). The loop
is VP9, muted, capped at 5 s and 24 fps, plus the WebP poster. A phone video's rotation
flag is applied, so both come out upright.

Untrusted input (uploads, paths that came from metadata): only a regular local file whose
container KRC recognised by its own bytes (mp4/mov, mkv/webm, gif) is opened, with that
demuxer forced and only the file protocol allowed, so a crafted "video" (an HLS / concat
playlist, a URL) can't make PyAV read the network or guess another format. See
sniff_container().
"""
from __future__ import annotations

import os
import stat
from fractions import Fraction
from pathlib import Path

from .library.thumbnails import THUMBNAIL_SIZE, thumbnail_video_size

THUMB_W, THUMB_H = THUMBNAIL_SIZE
WEBP_QUALITY = 82                    # matches the pack's static-thumbnail quality
WEBM_MAX_DURATION = 5.0              # seconds — hard cap on clip length
WEBM_FPS = 24                       # frames/sec of the loop
WEBM_CRF = 42                       # VP9 constant-quality default (MEDIUM)
WEBM_CRF_CLAMP = (30, 52)           # accepted range; UI quality tiers live inside this
FRAME_POSITIONS = ("first", "middle", "last")

# The one "can't do video" wording — same text as NO_VIDEO_MESSAGE in
# web/js/shared/video_status.js (the client shows it; routes return it).
NO_VIDEO_MESSAGE = "Video thumbnails need PyAV (av), which this ComfyUI is missing. Update ComfyUI."


def pyav_module():
    """The av module, or None. (The frame helpers come from Media's process_video, imported
    where they're used so this module stays light at the pack's import.)"""
    try:
        import av  # noqa: PLC0415 - ComfyUI's own video library
    except ImportError:
        return None
    return av


def _pyav_version() -> str:
    av = pyav_module()
    return str(getattr(av, "__version__", "")) if av else ""


def _have_pil() -> bool:
    try:
        import PIL  # noqa: F401, PLC0415
        return True
    except ImportError:
        return False


PYAV_VERSION = _pyav_version()
VIDEO_SUPPORT = bool(PYAV_VERSION)
try:
    WEBM_SUPPORT = VIDEO_SUPPORT and "libvpx-vp9" in pyav_module().codecs_available
except Exception:  # noqa: BLE001 - checking must never break the pack's import
    WEBM_SUPPORT = False
POSTER_SUPPORT = VIDEO_SUPPORT and _have_pil()


def capability() -> dict:
    """What the frontend reads to gate the video-thumbnail options.
      webm  : animated loop available (PyAV + VP9)
      poster: static webp available   (PyAV + Pillow)  <- default mode
    Reason codes (worst-blocking first): "no_pyav" | "webm_unavailable" (PyAV without
    VP9) | "no_pillow" | "" (all good)."""
    if not VIDEO_SUPPORT:
        webm_reason = poster_reason = "no_pyav"
    else:
        webm_reason = "" if WEBM_SUPPORT else "webm_unavailable"
        poster_reason = "" if POSTER_SUPPORT else "no_pillow"
    return {
        "video": VIDEO_SUPPORT,
        "webm": WEBM_SUPPORT,
        "poster": POSTER_SUPPORT,
        "webmReason": webm_reason,
        "posterReason": poster_reason,
        "pyav": PYAV_VERSION,
    }


# --- Input hardening -----------------------------------------------------------
UNSUPPORTED_VIDEO_MESSAGE = "That isn't a supported video. Use MP4, MOV, MKV, WebM or GIF."


def sniff_container(src) -> str:
    """The demuxer for a regular local file, from its first bytes: "mov" (mp4 / mov /
    m4v), "matroska" (mkv / webm) or "gif". "" for anything else, a missing file, or a
    non-regular one (a FIFO or device would block or never end)."""
    try:
        info = os.stat(src)
        if not stat.S_ISREG(info.st_mode) or info.st_size < 12:
            return ""
        with open(src, "rb") as handle:
            head = handle.read(12)
    except OSError:
        return ""
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return "matroska"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if head[4:8] in (b"ftyp", b"moov", b"mdat", b"wide", b"free", b"skip"):
        return "mov"
    return ""


def _duration(container, stream) -> float:
    if stream.duration is not None and stream.time_base:
        return float(stream.duration * stream.time_base)
    return (container.duration or 0) / 1_000_000   # av.time_base: microseconds


def _seek_for_frame(duration: float, frame: str) -> float:
    """Seek offset (seconds) for a coarse frame pick — first / middle / last. `last` backs
    off slightly so the pick lands on a real frame; 0.5 s for middle when the duration is
    unknown."""
    frame = frame if frame in FRAME_POSITIONS else "middle"
    if frame == "first":
        return 0.0
    if frame == "last":
        return max(0.0, duration - 0.1) if duration > 0 else 0.0
    return duration / 2 if duration > 0 else 0.5


def _sar(stream) -> float:
    ratio = getattr(stream.codec_context, "sample_aspect_ratio", None)
    return float(ratio) if ratio else 1.0


# --- Poster (static webp) -----------------------------------------------------
def video_to_webp(src, out_path: Path, seek: float | None = None,
                  frame: str = "first") -> bool:
    """One frame as a proportionally downscaled WebP poster (Pillow). `frame` picks a
    coarse position (first/middle/last); an explicit `seek` overrides it. Guarded — no
    PyAV or Pillow, or not a recognised video -> False. (Default 'first': the pack's
    default poster.)"""
    demuxer = sniff_container(src) if POSTER_SUPPORT else ""
    if not demuxer:
        return False
    from PIL import Image  # noqa: PLC0415
    from .media.process_video import (  # noqa: PLC0415
        exact, frame_rotation, frame_time, open_video, seek_to, timeline_origin, upright)
    out_path = Path(out_path)
    try:
        with open_video(src, container_format=demuxer) as container:
            stream = container.streams.video[0]
            if seek is None:
                seek = _seek_for_frame(_duration(container, stream), frame)
            origin, seek = timeline_origin(stream), exact(seek)
            seek_to(container, stream, seek)
            picked = None   # the frame on screen at `seek`: decode forward from the keyframe
            for decoded in container.decode(stream):
                when = frame_time(decoded, stream, origin)
                if picked is not None and when is not None and when > seek:
                    break
                picked = decoded
            if picked is None:
                return False
            turn = frame_rotation(picked, stream)
            image = Image.fromarray(upright(picked.to_ndarray(format="rgb24"), turn))
            size = thumbnail_video_size(image.width, image.height, 1.0 if turn % 180 else _sar(stream))
        out_path.parent.mkdir(parents=True, exist_ok=True)
        image.resize(size, Image.Resampling.LANCZOS).save(out_path, "WEBP", quality=WEBP_QUALITY, method=6)
    except Exception:  # noqa: BLE001 - PyAV's errors vary by version; a poster is best-effort
        return False
    return out_path.exists() and out_path.stat().st_size > 0


# --- Animated (looping webm) --------------------------------------------------
def video_to_webm(src, out_path: Path, crf: int | None = None) -> bool:
    """A short, low-res, looping WebM thumbnail: VP9, muted, proportionally bounded to
    300x300, 24 fps, the first 5 seconds at most. Guarded — no VP9 -> False."""
    demuxer = sniff_container(src) if WEBM_SUPPORT else ""
    if not demuxer:
        return False
    lo, hi = WEBM_CRF_CLAMP
    try:
        crf = WEBM_CRF if crf is None else max(lo, min(hi, int(crf)))
    except (TypeError, ValueError):
        crf = WEBM_CRF
    from .media.process_video import frame_slots, open_video, output_frame, probe  # noqa: PLC0415
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    rate = Fraction(WEBM_FPS)
    try:
        info = probe(src, container_format=demuxer)
        with open_video(src, container_format=demuxer) as container:
            stream = container.streams.video[0]
            sar = _sar(stream) if (info["width"], info["height"]) == (stream.codec_context.width, stream.codec_context.height) else 1.0
            width, height = thumbnail_video_size(info["width"], info["height"], sar)
            # A clip shorter than the cap runs to its own end (its last frame decides).
            length = WEBM_MAX_DURATION if not info["duration"] or info["duration"] > WEBM_MAX_DURATION else 0
            with open_video(out_path, "w") as output:
                video_out = output.add_stream("libvpx-vp9", rate=rate)
                video_out.width, video_out.height, video_out.pix_fmt = width, height, "yuv420p"
                video_out.options = {"crf": str(crf), "b": "0", "deadline": "good", "cpu-used": "4"}
                slots = frame_slots(container.decode(stream), stream, start=0, length=length, rate=rate)
                for index, (decoded, turn) in enumerate(slots):
                    output.mux(video_out.encode(output_frame(decoded, turn, width=width, height=height,
                                                             pix_fmt="yuv420p", alpha=False, index=index, rate=rate)))
                output.mux(video_out.encode(None))
    except Exception:  # noqa: BLE001 - PyAV's errors vary by version; a loop is best-effort
        out_path.unlink(missing_ok=True)
        return False
    return out_path.exists() and out_path.stat().st_size > 0


def transcode_upload(src, poster_out: Path, webm_out: Path, *,
                     want_animated: bool = True, frame: str = "first",
                     crf: int | None = None) -> dict:
    """Transcode a user-UPLOADED video file into the KRC constrained thumbnail set,
    node-agnostic: the caller passes the two output paths (LoRA Loadout and Prompt
    Vault use different thumbnail dirs) and this writes into them.

    Always writes the webp poster (the static fallback every card needs). Writes the
    animated webm loop too when `want_animated` and VP9 is available; otherwise it
    REMOVES any stale webm at `webm_out` so a static poster is never shadowed by an
    old loop. The upload itself is transient — the caller discards the source after
    this returns, so there is nothing to re-pull from later.

    Returns {"poster": bool, "animated": bool, "reason": str}. `reason` is a UI code:
    "no_pyav" (can't read a frame at all), "convert_failed" (poster couldn't be written —
    treat as a hard failure), or "webm_unavailable" (poster ok but the requested loop
    needs VP9; degraded to poster-only)."""
    result = {"poster": False, "animated": False, "reason": ""}
    if not VIDEO_SUPPORT:
        result["reason"] = "no_pyav"
        return result

    result["poster"] = video_to_webp(src, poster_out, frame=frame)
    if want_animated and WEBM_SUPPORT:
        result["animated"] = video_to_webm(src, webm_out, crf=crf)

    if not result["animated"]:
        # Static (or the loop failed): drop any pre-existing webm so the poster
        # isn't overlaid by a stale animation.
        try:
            webm_path = Path(webm_out)
            if webm_path.exists():
                webm_path.unlink()
        except OSError:
            pass

    if not result["poster"]:
        result["reason"] = "convert_failed"
    elif want_animated and not result["animated"]:
        result["reason"] = "webm_unavailable"
    return result
