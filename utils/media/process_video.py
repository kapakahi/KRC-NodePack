"""Videos at upload (GAMEPLAN.md section 3): the stored file is final.

ffmpeg (NodePack's detected one, ``ffmpeg_info()``) converts the upload to WebM: VP9 (with
alpha when the source has it), Opus audio when kept (Vorbis if this ffmpeg has no Opus),
trimmed, at the chosen FPS and max size. ffmpeg applies a phone video's rotation flag while
decoding, so the stored frames are upright. A frame becomes the WebP card thumbnail
(through Pillow). Animated GIFs come here too. Conversion reports progress and can be
cancelled (the job owns the process).

Every path ffmpeg reads or writes is one of Media's own (an upload saved under a uuid
name in the Media folder); ffmpeg is also limited to the ``file`` protocol.
"""

import json
import re
import subprocess

from PIL import Image

from .krc import api
from .process_image import megapixel_size

CRF = 32                    # VP9 constant quality for stored media (lower = better / larger)
THUMB_MAX = 384
FPS_CHOICES = (0, 30, 24, 16, 12, 8)          # the buttons (0 = the source's)
MAX_LENGTHS = (0, 5, 10, 30, 60)              # the buttons: seconds kept at most (0 = all)
CUSTOM_FPS = (1.0, 60.0)                      # a custom value's range (inclusive; decimals allowed)
CUSTOM_LENGTH = (1.0, 600.0)


def _in_range(value, bounds, digits=3):
    """A setting as a float within ``bounds`` (inclusive), else 0 (= none / the source's)."""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(number, digits) if bounds[0] <= number <= bounds[1] else 0.0
PROBE_TIMEOUT = 60


class VideoProcessError(ValueError):
    """An upload that can't be converted; the message is shown to the user."""


class Cancelled(Exception):
    """The job was cancelled while ffmpeg ran."""


def ffmpeg(*, require_vp9=True):
    """(ffmpeg path, ffprobe path) from NodePack; VideoProcessError when video can't work."""
    info = api().ffmpeg_info()
    if not info.get("available") or not info.get("path"):
        raise VideoProcessError("Video needs ffmpeg on the server (KRC Portal ▸ Options ▸ ffmpeg).")
    if require_vp9 and not info.get("vp9"):
        raise VideoProcessError("This server's ffmpeg can't encode WebM (VP9).")
    return info["path"], info.get("ffprobe") or ""


def _ratio(text):
    try:
        num, _, den = str(text or "0/1").partition("/")
        value = float(num) / float(den or 1)
        return value if value > 0 else 0.0
    except (TypeError, ValueError, ZeroDivisionError):
        return 0.0


def _banner_probe(ffmpeg_bin, path):
    """probe() without ffprobe (e.g. imageio-ffmpeg ships only ffmpeg): ffmpeg's own banner
    for ``-i path`` (it exits non-zero with no output; the banner is on stderr)."""
    try:
        done = subprocess.run([ffmpeg_bin, "-hide_banner", "-protocol_whitelist", "file", "-i", str(path)],
                              capture_output=True, text=True, timeout=PROBE_TIMEOUT)
    except (OSError, subprocess.SubprocessError) as err:
        raise VideoProcessError("That file couldn't be read as a video.") from err
    banner = done.stderr or ""
    video_line = next((line for line in banner.splitlines() if re.search(r"Stream #\S+.*: Video:", line)), "")
    if not video_line:
        raise VideoProcessError("That file has no video stream.")
    size = re.search(r"[ ,](\d{2,5})x(\d{2,5})(?=[ ,\[]|$)", video_line)
    width, height = (int(size.group(1)), int(size.group(2))) if size else (0, 0)
    rate = re.search(r"([\d.]+) fps", video_line) or re.search(r"([\d.]+) tbr", video_line)
    fps = float(rate.group(1)) if rate else 0.0
    clock = re.search(r"Duration: (\d+):(\d+):([\d.]+)", banner)
    duration = int(clock.group(1)) * 3600 + int(clock.group(2)) * 60 + float(clock.group(3)) if clock else 0.0
    turn = re.search(r"rotation of (-?[\d.]+) degrees", banner, re.IGNORECASE) or re.search(r"rotate\s*:\s*(-?\d+)", banner)
    if turn and abs(int(float(turn.group(1)))) % 180 == 90:
        width, height = height, width
    pix_fmt = re.search(r"Video: [^,]+, ([a-z0-9]+)", video_line)
    alpha = bool(pix_fmt and "a" in pix_fmt.group(1).replace("gray", "")) or bool(re.search(r"alpha_mode\s*:\s*1", banner))
    return {
        "width": width, "height": height, "fps": round(fps, 3), "duration": round(duration, 3),
        "frames": round(duration * fps) if fps and duration else 0,
        "audio": bool(re.search(r"Stream #\S+.*: Audio:", banner)), "alpha": alpha,
    }


def probe(path):
    """{"width", "height", "fps", "duration", "frames", "audio", "alpha"} for a video file
    (dimensions as displayed: a 90° rotation flag swaps them). ffprobe when NodePack found
    one, else ffmpeg's banner (imageio-ffmpeg ships only ffmpeg). Reading needs no VP9 encoder."""
    ffmpeg_bin, ffprobe = ffmpeg(require_vp9=False)
    if not ffprobe:
        return _banner_probe(ffmpeg_bin, path)
    try:
        done = subprocess.run(
            [ffprobe, "-v", "error", "-protocol_whitelist", "file", "-print_format", "json",
             "-show_streams", "-show_format", str(path)],
            capture_output=True, text=True, timeout=PROBE_TIMEOUT,
        )
        data = json.loads(done.stdout or "{}")
    except (OSError, subprocess.SubprocessError, ValueError) as err:
        raise VideoProcessError("That file couldn't be read as a video.") from err
    streams = data.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    if not video:
        raise VideoProcessError("That file has no video stream.")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = 0
    for side in video.get("side_data_list") or []:
        if "rotation" in side:
            rotation = int(float(side.get("rotation") or 0))
    rotation = rotation or int(float((video.get("tags") or {}).get("rotate") or 0))
    if abs(rotation) % 180 == 90:
        width, height = height, width
    fps = _ratio(video.get("avg_frame_rate")) or _ratio(video.get("r_frame_rate"))
    duration = float(video.get("duration") or (data.get("format") or {}).get("duration") or 0)
    frames = int(video.get("nb_frames") or 0) or (round(duration * fps) if fps and duration else 0)
    alpha = "a" in str(video.get("pix_fmt") or "").replace("gray", "") or bool((video.get("tags") or {}).get("alpha_mode"))
    return {
        "width": width, "height": height, "fps": round(fps, 3), "duration": round(duration, 3),
        "frames": frames, "audio": any(stream.get("codec_type") == "audio" for stream in streams), "alpha": alpha,
    }


def _scale_filter(width, height, megapixels):
    """scale=W:H so W x H (the displayed size) is at most ``megapixels`` million, the aspect
    kept, both even (VP9 4:2:0); "" when no scaling is needed. Computed here: an expression's
    commas would split the filter graph."""
    scaled = megapixel_size(width, height, megapixels, even=True)
    return "" if scaled == (width, height) else f"scale={scaled[0]}:{scaled[1]}"


def _command(ffmpeg_bin, source, dest, *, start, length, fps, scale, audio, alpha, audio_codec):
    filters = [part for part in (f"fps={fps}" if fps else "", scale) if part]
    command = [ffmpeg_bin, "-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file", "-y"]
    if start:
        command += ["-ss", f"{start:.3f}"]
    command += ["-i", str(source)]
    if length:
        command += ["-t", f"{length:.3f}"]
    if filters:
        command += ["-vf", ",".join(filters)]
    command += ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", str(CRF), "-row-mt", "1",
                "-deadline", "good", "-cpu-used", "4",
                "-pix_fmt", "yuva420p" if alpha else "yuv420p"]
    if audio:
        command += ["-c:a", audio_codec, "-b:a", "128k"]
    else:
        command += ["-an"]
    command += ["-progress", "pipe:1", "-nostats", str(dest)]
    return command


def _run(command, total_seconds, on_progress, is_cancelled):
    """Run ffmpeg, reporting 0..1 from its -progress output; Cancelled kills it."""
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    except OSError as err:
        raise VideoProcessError(f"ffmpeg couldn't start ({err}).") from err
    try:
        for line in process.stdout:
            if is_cancelled():
                process.kill()
                raise Cancelled()
            key, _, value = line.strip().partition("=")
            if key == "out_time_us" and total_seconds and value.isdigit():
                on_progress(min(0.99, int(value) / 1_000_000 / total_seconds))
        process.wait()
        if is_cancelled():
            raise Cancelled()
        return process.returncode, (process.stderr.read() if process.stderr else "")
    finally:
        if process.poll() is None:
            process.kill()


def thumbnail(ffmpeg_bin, video, thumb, at_seconds):
    """A WebP card thumbnail from one frame (ffmpeg -> PNG -> Pillow, so no libwebp needed)."""
    frame = thumb.with_suffix(".frame.png")
    thumb.parent.mkdir(parents=True, exist_ok=True)   # ffmpeg writes the frame there first
    try:
        done = subprocess.run(
            [ffmpeg_bin, "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file", "-y",
             "-ss", f"{max(0.0, at_seconds):.3f}", "-i", str(video), "-frames:v", "1", str(frame)],
            capture_output=True, timeout=PROBE_TIMEOUT,
        )
        if done.returncode != 0 or not frame.is_file():
            raise VideoProcessError("Couldn't make the thumbnail.")
        with Image.open(frame) as image:
            image = image.convert("RGBA" if "A" in image.mode else "RGB")
            image.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
            image.save(thumb, "WEBP", quality=80, method=4)
    except (OSError, subprocess.SubprocessError) as err:
        raise VideoProcessError("Couldn't make the thumbnail.") from err
    finally:
        frame.unlink(missing_ok=True)


def process(source, dest, thumb, *, trim_in=0.0, trim_out=0.0, fps=0, max_megapixels=0, max_length=0,
            audio=True, on_progress=lambda _value: None, is_cancelled=lambda: False):
    """Convert ``source`` to WebM at ``dest`` (+ a thumbnail). ``trim_out`` 0 = to the end;
    ``max_length`` (seconds, 0 = none) cuts the kept part after that long; ``max_megapixels``
    scales it down (0 = as is).
    -> the stored file's {"width", "height", "fps", "duration", "frames", "audio", "alpha",
    "bytes"}."""
    ffmpeg_bin, _ = ffmpeg()
    info = probe(source)
    start = max(0.0, float(trim_in or 0))
    end = float(trim_out or 0)
    if info["duration"] and (end <= 0 or end > info["duration"]):
        end = info["duration"]
    if end and end <= start:
        raise VideoProcessError("Trim: the end must come after the start.")
    max_length = _in_range(max_length, CUSTOM_LENGTH)
    if max_length and (not end or end - start > max_length):
        end = start + max_length
    length = (end - start) if end else 0.0
    fps = _in_range(fps, CUSTOM_FPS)
    keep_audio = bool(audio) and info["audio"]
    dest.parent.mkdir(parents=True, exist_ok=True)
    total = length or info["duration"] or 0
    for codec in ("libopus", "libvorbis"):
        command = _command(ffmpeg_bin, source, dest, start=start, length=length, fps=fps,
                           scale=_scale_filter(info["width"], info["height"], max_megapixels),
                           audio=keep_audio, alpha=info["alpha"], audio_codec=codec)
        code, errors = _run(command, total, on_progress, is_cancelled)
        if code == 0:
            break
        if keep_audio and codec == "libopus" and "libopus" in errors:
            continue  # no Opus in this build: Vorbis is WebM's other audio codec
        raise VideoProcessError(f"ffmpeg couldn't convert that video ({(errors.strip().splitlines() or ['unknown error'])[-1][:200]}).")
    stored = probe(dest)
    thumbnail(ffmpeg_bin, dest, thumb, min(1.0, (stored["duration"] or 0) / 2))
    on_progress(1.0)
    return {**stored, "bytes": dest.stat().st_size}


def is_animated_image(path):
    """An animated GIF (several frames): converted as a video."""
    try:
        with Image.open(path) as image:
            return image.format == "GIF" and getattr(image, "n_frames", 1) > 1
    except OSError:
        return False
