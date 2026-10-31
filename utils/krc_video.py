"""
Tier-3 video → thumbnail transcode for KRC NodePack.

Pure-stdlib. The ONLY optional capability is an `ffmpeg` binary (with the
`libvpx-vp9` encoder for WebM); nothing is pip-installed, so `dependencies = []`
stays literally true. When ffmpeg/VP9 is absent every function degrades to a clean
False and the caller shows a placeholder — the pack works normally without it.

Which ffmpeg (FFMPEG_DETECTION_GAMEPLAN.md) — resolved by detect(), never guessed:
    1. KRC_FFMPEG env var          explicit — wins when it works
    2. Settings "ffmpeg location"  explicit (the video settings' ffmpegPath, krc.db)
    3. PATH                        automatic ┐ both probed; the more capable wins
    4. imageio-ffmpeg, if installed automatic ┘ (vp9, webp); PATH wins ties
KRC never searches the disk for installs and never downloads ffmpeg. Every ffmpeg /
ffprobe call below runs FFMPEG_BIN / FFPROBE_BIN — never a bare name.

Thumbnail framing shares the pack's proportional image bounds (at most 300x300). Encoding
remains VP9, muted, capped at 5s/24fps, plus a WebP poster. The separate editor
may still generate legacy portrait thumbnails; importing those remains supported.

Distinct capabilities — do NOT collapse them to one bool:
    have_ffmpeg()  -> a working ffmpeg was found     (needed to decode any frame)
    have_webm()    -> that binary exposes VP9        (required for the animated loop)
    poster support -> ffmpeg + a webp encoder: libwebp in ffmpeg, OR Pillow as a
                      fallback (many minimal ffmpeg builds ship VP9 but not libwebp,
                      so the DEFAULT static-poster path must not hinge on libwebp)

capability() returns UI-facing reason codes, never bare bools.

Untrusted input (uploads, paths that came from metadata): ffmpeg only ever reads a
regular local file whose container KRC recognised by its own bytes (mp4/mov, mkv/webm,
gif), with that demuxer forced and `-protocol_whitelist file`, so a crafted "video"
(an HLS / concat playlist, a URL) can't make ffmpeg read other files or the network.
See input_args().
"""
from __future__ import annotations

import os
import re
import shutil
import stat
import subprocess
import threading
from pathlib import Path

# --- Shared thumbnail geometry and transcode defaults ------------------------
from .library.thumbnails import THUMBNAIL_SIZE, thumbnail_scale_filter

THUMB_W, THUMB_H = THUMBNAIL_SIZE
WEBP_QUALITY = 82                    # matches the pack's static-thumbnail quality
WEBM_MAX_DURATION = 5.0              # seconds — hard cap on clip length
WEBM_FPS = 24                       # frames/sec cap
WEBM_CRF = 42                       # VP9 constant-quality default (MEDIUM)
WEBM_CRF_CLAMP = (30, 52)           # accepted range; UI quality tiers live inside this
FRAME_POSITIONS = ("first", "middle", "last")


# --- Which ffmpeg (detection) --------------------------------------------------
ENV_VAR = "KRC_FFMPEG"
_EXE = ".exe" if os.name == "nt" else ""
_PROBE_TIMEOUT = 15

SOURCE_ENV = "KRC_FFMPEG"
SOURCE_SETTING = "Settings"
SOURCE_PATH = "PATH"
SOURCE_IMAGEIO = "imageio-ffmpeg"

# The one "not found" wording — same text as FFMPEG_NOT_FOUND_MESSAGE in
# web/js/shared/ffmpeg_status.js (the client shows it; routes return it).
NOT_FOUND_MESSAGE = ("ffmpeg not found. Install it (it must be on PATH), or set its location "
                     "in KRC Portal ▸ Options ▸ Media.")


def parse_version(first_line: str):
    """Display version from `ffmpeg -version`'s first line, or None.
    "ffmpeg version 7.1-essentials_build-www.gyan.dev …" → "7.1";
    "ffmpeg version n6.1.1" → "6.1.1"; git/nightly "N-118123-gabc…" → "dev build"."""
    match = re.match(r"\S+ version (\S+)", (first_line or "").strip())
    if not match:
        return None
    token = match.group(1)
    if re.match(r"N-\d", token):
        return "dev build"
    number = re.match(r"n?(\d+(?:\.\d+)*)", token)
    return number.group(1) if number else token


def normalize_location(value) -> str:
    """A user-given ffmpeg location → the ffmpeg binary path, or "" if there's none.
    Accepts the binary itself (the .exe may be left off on Windows), the folder that
    holds it, or an unzipped build's root (its bin/ folder)."""
    raw = str(value or "").strip().strip('"').strip()
    if not raw:
        return ""
    path = Path(os.path.expandvars(os.path.expanduser(raw)))
    if path.is_file():
        return str(path)
    if _EXE and not path.suffix and Path(f"{path}{_EXE}").is_file():
        return f"{path}{_EXE}"
    if path.is_dir():
        for candidate in (path / f"ffmpeg{_EXE}", path / "bin" / f"ffmpeg{_EXE}"):
            if candidate.is_file():
                return str(candidate)
    return ""


def probe(binary: str, run=subprocess.run) -> dict:
    """Does this ffmpeg run, and what can it encode? Two short processes."""
    info = {"ok": False, "version": None, "vp9": False, "webp": False, "error": ""}
    try:
        out = run([binary, "-hide_banner", "-version"], capture_output=True, text=True, timeout=_PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as err:
        info["error"] = str(err) or type(err).__name__
        return info
    if out.returncode != 0:
        info["error"] = f"exited with code {out.returncode}"
        return info
    info["ok"] = True
    info["version"] = parse_version((out.stdout or "").split("\n", 1)[0])
    try:
        enc = run([binary, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=_PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError):
        return info
    if enc.returncode == 0:
        info["vp9"] = "libvpx-vp9" in enc.stdout
        info["webp"] = "libwebp" in enc.stdout
    return info


def _imageio_exe() -> str:
    """The ffmpeg an already-installed imageio-ffmpeg (e.g. VideoHelperSuite's) points
    at, or "". Never installs anything; absent package → ""."""
    try:
        import imageio_ffmpeg  # noqa: PLC0415 — optional, only if the user has it
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001 — ImportError, RuntimeError (no binary), anything
        return ""
    exe = str(exe or "")
    if exe and os.sep not in exe and "/" not in exe:
        exe = shutil.which(exe) or ""  # it fell back to a bare "ffmpeg" name
    return exe


def _same_binary(a: str, b: str) -> bool:
    try:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))
    except OSError:
        return a == b


def choose(*, env_value="", setting_value="", path_exe="", imageio_exe="", probe_fn=probe) -> dict:
    """Pick the ffmpeg to use. Pure apart from probe_fn (injectable for tests).
    → {"chosen": record|None, "candidates": [record…], "warning": str, "note": str};
    record = {"source", "path", "ok", "version", "vp9", "webp", "error"}."""
    candidates = []
    failed_explicit = []
    for source, raw in ((SOURCE_ENV, env_value), (SOURCE_SETTING, setting_value)):
        if not str(raw or "").strip():
            continue
        exe = normalize_location(raw)
        if not exe:
            candidates.append({"source": source, "path": str(raw).strip(), "ok": False, "version": None,
                               "vp9": False, "webp": False, "error": "no ffmpeg at this location"})
            failed_explicit.append(source)
            continue
        record = {"source": source, "path": exe, **probe_fn(exe)}
        candidates.append(record)
        if record["ok"]:
            return {"chosen": record, "candidates": candidates, "warning": _explicit_warning(failed_explicit, record), "note": ""}
        failed_explicit.append(source)

    automatic = []
    for source, exe in ((SOURCE_PATH, path_exe), (SOURCE_IMAGEIO, imageio_exe)):
        if not exe or any(_same_binary(exe, c["path"]) for c in candidates if c["source"] in (SOURCE_PATH, SOURCE_IMAGEIO)):
            continue
        record = {"source": source, "path": exe, **probe_fn(exe)}
        candidates.append(record)
        if record["ok"]:
            automatic.append(record)
    # max() keeps the first of equals, so PATH wins a tie.
    chosen = max(automatic, key=lambda r: (r["vp9"], r["webp"]), default=None)
    note = ""
    if chosen:
        for other in automatic:
            # Explain only a real downgrade avoided (a tie just goes to PATH).
            if other is not chosen and (other["vp9"], other["webp"]) < (chosen["vp9"], chosen["webp"]):
                missing = "VP9" if not other["vp9"] else "libwebp"
                note = f"{other['source']} ffmpeg lacks {missing} — using {chosen['source']}"
    return {"chosen": chosen, "candidates": candidates, "warning": _explicit_warning(failed_explicit, chosen), "note": note}


def _explicit_warning(failed_sources, chosen) -> str:
    if not failed_sources:
        return ""
    where = " and ".join("KRC_FFMPEG" if s == SOURCE_ENV else "Settings" for s in failed_sources)
    tail = f" — using {chosen['source']}." if chosen else "."
    return f"No working ffmpeg at the location set in {where}{tail}"


def find_ffprobe(ffmpeg_exe: str) -> str:
    """ffprobe beside the chosen ffmpeg, else on PATH, else "" (imageio-ffmpeg ships
    none — _probe_duration then reads the length from ffmpeg itself)."""
    if not ffmpeg_exe:
        return ""
    sibling = Path(ffmpeg_exe).with_name(f"ffprobe{_EXE}")
    if sibling.is_file():
        return str(sibling)
    return shutil.which("ffprobe") or ""


def _saved_location() -> str:
    try:
        from .krc_video_settings import load_settings
        return str(load_settings().get("ffmpegPath") or "")
    except Exception:  # noqa: BLE001 — settings unreadable → automatic
        return ""


# Module state, re-bound by detect(). Consumers read these as module attributes
# (krc_video.FFMPEG_SUPPORT), so a re-detect is seen everywhere.
FFMPEG_BIN = ""
FFPROBE_BIN = ""
FFMPEG_SUPPORT = False
WEBM_SUPPORT = False
LIBWEBP_SUPPORT = False
POSTER_SUPPORT = False
DETECTION: dict = {}
_DETECT_LOCK = threading.Lock()


def detect(*, setting_value=None, env_value=None, which=shutil.which, imageio=_imageio_exe, probe_fn=probe) -> dict:
    """Resolve ffmpeg and re-bind the module state. Runs at import, and again when the
    Settings location changes or on "Detect again" (call off the event loop — it
    spawns processes). Returns DETECTION."""
    global FFMPEG_BIN, FFPROBE_BIN, FFMPEG_SUPPORT, WEBM_SUPPORT, LIBWEBP_SUPPORT, POSTER_SUPPORT, DETECTION
    with _DETECT_LOCK:
        result = choose(
            env_value=os.environ.get(ENV_VAR, "") if env_value is None else env_value,
            setting_value=_saved_location() if setting_value is None else setting_value,
            path_exe=which("ffmpeg") or "",
            imageio_exe=imageio(),
            probe_fn=probe_fn,
        )
        chosen = result["chosen"]
        FFMPEG_BIN = chosen["path"] if chosen else ""
        FFPROBE_BIN = find_ffprobe(FFMPEG_BIN)
        FFMPEG_SUPPORT = bool(chosen)
        WEBM_SUPPORT = bool(chosen and chosen["vp9"])
        LIBWEBP_SUPPORT = bool(chosen and chosen["webp"])
        # Static poster needs ffmpeg (to decode a frame) AND a webp encoder from
        # EITHER source. VP9 and libwebp are independent ffmpeg build options.
        POSTER_SUPPORT = FFMPEG_SUPPORT and (LIBWEBP_SUPPORT or have_pil())
        DETECTION = {
            "source": chosen["source"] if chosen else "",
            "path": FFMPEG_BIN,
            "version": chosen["version"] if chosen else None,
            "vp9": WEBM_SUPPORT,
            "webp": LIBWEBP_SUPPORT,
            "ffprobe": FFPROBE_BIN,
            "warning": result["warning"],
            "note": result["note"],
            "candidates": result["candidates"],
        }
        return DETECTION


async def redetect() -> dict:
    """detect() off the event loop (it spawns ffmpeg), for routes: the Settings
    location changed, or "Detect again". Returns the fresh capability()."""
    import asyncio

    await asyncio.get_running_loop().run_in_executor(None, detect)
    return capability()


def have_ffmpeg() -> bool:
    return bool(FFMPEG_BIN)


def ffmpeg_version():
    """Display version of the chosen ffmpeg (e.g. '7.1', 'dev build'), or None."""
    return DETECTION.get("version") if FFMPEG_BIN else None


def have_webm() -> bool:
    """WebM (animated) thumbnail generation needs the VP9 encoder."""
    return WEBM_SUPPORT


def have_libwebp() -> bool:
    """Whether ffmpeg can encode webp directly (fast poster path)."""
    return LIBWEBP_SUPPORT


def have_pil() -> bool:
    """Pillow — the poster fallback's webp encoder when ffmpeg lacks libwebp."""
    try:
        import PIL  # noqa: F401
        return True
    except ImportError:
        return False


# Probed once at import; re-detected on demand (no ComfyUI restart needed).
try:
    detect()
except Exception:  # noqa: BLE001 — detection must never break the pack's import
    pass


def capability() -> dict:
    """What the frontend reads to gate the video-thumbnail options.
      webm  : animated loop available (ffmpeg + VP9)
      poster: static webp available   (ffmpeg + libwebp-or-Pillow)  <- default mode
    Reason codes (worst-blocking first): "no_ffmpeg" | "webm_unavailable"
    (ffmpeg present, no VP9) | "no_webp_encoder" (ffmpeg present, no libwebp/Pillow)
    | "" (all good). `detection`: which ffmpeg, from where, and why (UI status)."""
    if not FFMPEG_SUPPORT:
        webm_reason = poster_reason = "no_ffmpeg"
    else:
        webm_reason = "" if WEBM_SUPPORT else "webm_unavailable"
        poster_reason = "" if POSTER_SUPPORT else "no_webp_encoder"
    return {
        "ffmpeg": FFMPEG_SUPPORT,
        "webm": WEBM_SUPPORT,
        "poster": POSTER_SUPPORT,
        "webmReason": webm_reason,
        "posterReason": poster_reason,
        "detection": DETECTION,
    }


_DURATION_RE = re.compile(r"Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)")


def parse_duration(text: str) -> float:
    """Seconds from ffmpeg's "Duration: HH:MM:SS.xx" banner line, or 0.0."""
    match = _DURATION_RE.search(text or "")
    if not match:
        return 0.0
    hours, minutes, seconds = match.groups()
    return int(hours) * 3600 + int(minutes) * 60 + float(seconds)


# --- Input hardening -----------------------------------------------------------
UNSUPPORTED_VIDEO_MESSAGE = "That isn't a supported video. Use MP4, MOV, MKV, WebM or GIF."


def sniff_container(src) -> str:
    """The ffmpeg demuxer for a regular local file, from its first bytes: "mov"
    (mp4 / mov / m4v), "matroska" (mkv / webm) or "gif". "" for anything else, a
    missing file, or a non-regular one (a FIFO or device would block or never end)."""
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


def input_args(src) -> list | None:
    """The input half of an ffmpeg / ffprobe command for `src`: the sniffed demuxer
    forced and only the file protocol allowed. None when `src` isn't a recognised
    local video (the caller then refuses it)."""
    demuxer = sniff_container(src)
    if not demuxer:
        return None
    return ["-protocol_whitelist", "file", "-f", demuxer, "-i", str(src)]


# --- Poster (static webp) -----------------------------------------------------
def _probe_duration(src: str) -> float:
    """Media duration in seconds: ffprobe when there is one, else ffmpeg's own
    "Duration:" banner (imageio-ffmpeg ships no ffprobe). 0.0 if unknown."""
    source = input_args(src)
    if source is None:
        return 0.0
    if FFPROBE_BIN:
        try:
            out = subprocess.run(
                [FFPROBE_BIN, "-v", "error", "-show_entries", "format=duration",
                 "-of", "default=noprint_wrappers=1:nokey=1", *source],
                capture_output=True, text=True, timeout=30,
            )
            duration = float(out.stdout.strip())
            if duration > 0:
                return duration
        except (OSError, subprocess.SubprocessError, ValueError):
            pass
    if not FFMPEG_BIN:
        return 0.0
    try:
        # No output file → ffmpeg exits non-zero after printing the input banner.
        out = subprocess.run([FFMPEG_BIN, "-hide_banner", *source],
                             capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return 0.0
    return parse_duration(out.stderr)


def _seek_for_frame(src: str, frame: str) -> float:
    """Seek offset (seconds) for a coarse frame pick — first / middle / last. No
    precise frame indexing; `last` backs off slightly so the seek lands on a real
    frame rather than past the end. Falls back to 0.5s when duration is unknown."""
    frame = frame if frame in FRAME_POSITIONS else "middle"
    if frame == "first":
        return 0.0
    duration = _probe_duration(src)
    if frame == "last":
        return max(0.0, duration - 0.1) if duration > 0 else 0.0
    return duration / 2 if duration > 0 else 0.5


def video_to_webp(src, out_path: Path, seek: float | None = None,
                  frame: str = "first") -> bool:
    """Extract one frame and write it as a proportionally downscaled WebP poster. `frame` picks a
    coarse position (first/middle/last); an explicit `seek` overrides it. Uses
    ffmpeg's libwebp when available (fast); else
    decodes the (already downscaled) frame as PNG and encodes webp with Pillow. Guarded
    — no ffmpeg -> False. (Default frame is 'first' — the pack's default poster.)"""
    if not have_ffmpeg():
        return False
    src = str(src)
    if input_args(src) is None:
        return False
    if seek is None:
        seek = _seek_for_frame(src, frame)
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if have_libwebp():
        try:
            result = subprocess.run(
                [FFMPEG_BIN, "-nostdin", "-loglevel", "error", "-ss", f"{seek:.3f}",
                 *input_args(src), "-frames:v", "1", "-vf", thumbnail_scale_filter(),
                 "-c:v", "libwebp", "-quality", str(WEBP_QUALITY), "-y", str(out_path)],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0:
                return True
        except (OSError, subprocess.SubprocessError):
            pass  # fall through to the Pillow path

    return _video_to_webp_via_pillow(src, out_path, seek)


def _video_to_webp_via_pillow(src: str, out_path: Path, seek: float) -> bool:
    """Fallback poster path for ffmpeg builds without libwebp: decode one already
    downscaled frame to PNG on stdout (native encoder, always present) and let
    Pillow write the webp. Same geometry as the libwebp path (shared thumbnail_scale_filter)."""
    try:
        from PIL import Image
    except ImportError:
        return False
    source = input_args(src)
    if source is None:
        return False
    try:
        result = subprocess.run(
            [FFMPEG_BIN, "-nostdin", "-loglevel", "error", "-ss", f"{seek:.3f}",
             *source, "-frames:v", "1", "-vf", thumbnail_scale_filter(),
             "-c:v", "png", "-f", "image2pipe", "-"],
            capture_output=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0 or not result.stdout:
        return False
    try:
        from io import BytesIO
        with Image.open(BytesIO(result.stdout)) as img:
            img.convert("RGB").save(out_path, "WEBP", quality=WEBP_QUALITY, method=6)
    except (OSError, ValueError):
        return False
    return out_path.exists() and out_path.stat().st_size > 0


# --- Animated (looping webm) --------------------------------------------------
def video_to_webm(src, out_path: Path, crf: int | None = None) -> bool:
    """Transcode a video into a short, low-res, looping WebM thumbnail: VP9, muted,
    proportionally bounded to 300x300, <=24fps, capped at 5s. `-t` before `-i`
    limits decoding to the first 5 seconds (fast). Guarded — no ffmpeg/VP9 -> False."""
    if not have_webm():
        return False
    src = str(src)
    source = input_args(src)
    if source is None:
        return False
    lo, hi = WEBM_CRF_CLAMP
    try:
        crf = WEBM_CRF if crf is None else max(lo, min(hi, int(crf)))
    except (TypeError, ValueError):
        crf = WEBM_CRF
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        result = subprocess.run(
            [FFMPEG_BIN, "-nostdin", "-loglevel", "error",
             "-t", f"{WEBM_MAX_DURATION:.3f}", *source,
             "-an",  # muted — a thumbnail carries no audio
             "-vf", f"fps={WEBM_FPS},{thumbnail_scale_filter()}",
             "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(crf),
             "-pix_fmt", "yuv420p", "-deadline", "good", "-cpu-used", "4",
             "-y", str(out_path)],
            capture_output=True, text=True, timeout=300,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0 and out_path.exists() and out_path.stat().st_size > 0


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
    "no_ffmpeg" (can't decode a frame at all), "convert_failed" (poster couldn't be
    written — treat as a hard failure), or "webm_unavailable" (poster ok but the
    requested loop needs a VP9-enabled ffmpeg; degraded to poster-only)."""
    result = {"poster": False, "animated": False, "reason": ""}
    if not FFMPEG_SUPPORT:
        result["reason"] = "no_ffmpeg"
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
