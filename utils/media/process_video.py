"""Videos at upload (GAMEPLAN.md section 3): the stored file is final.

Everything here uses PyAV, the video library ComfyUI itself requires (its VIDEO type is
built on it); NodePack runs no ffmpeg program. An upload converts to WebM: VP9 (with alpha
when the source has it), Opus audio when kept (Vorbis when this PyAV has no Opus), trimmed,
at the chosen FPS (constant) and max size. A phone video's rotation flag is applied to the
frames, so the stored file is upright. Animated GIFs come here too. Conversion reports
progress and can be cancelled (the job runs it in its own thread). Reading a video (probe,
the WebP card thumbnail through Pillow, Media Loader's decode) is PyAV too.
"""

import math
from collections import deque
from fractions import Fraction

from PIL import Image

from .process_image import megapixel_size

CRF = 32                    # VP9 constant quality for stored media (lower = better / larger)
THUMB_MAX = 384
FPS_CHOICES = (0, 30, 24, 16, 12, 8)          # the buttons (0 = the source's)
MAX_LENGTHS = (0, 5, 10, 30, 60)              # the buttons: seconds kept at most (0 = all)
CUSTOM_FPS = (1.0, 60.0)                      # a custom value's range (inclusive; decimals allowed)
CUSTOM_LENGTH = (1.0, 600.0)
AUDIO_RATE = 48000          # Opus only takes 48 kHz; Vorbis is fine with it too
AUDIO_BITRATE = 128_000
VP9_OPTIONS = {"crf": str(CRF), "b": "0", "row-mt": "1", "deadline": "good", "cpu-used": "4"}


def _in_range(value, bounds, digits=3):
    """A setting as a float within ``bounds`` (inclusive), else 0 (= none / the source's)."""
    try:
        number = float(value or 0)
    except (TypeError, ValueError):
        return 0.0
    return round(number, digits) if bounds[0] <= number <= bounds[1] else 0.0


class VideoProcessError(ValueError):
    """An upload that can't be converted; the message is shown to the user."""


class Cancelled(Exception):
    """The job was cancelled during the conversion."""


def pyav():
    """The av module, with the clear message when this ComfyUI has no PyAV."""
    try:
        import av  # noqa: PLC0415 - ComfyUI's own video library
    except ImportError as err:
        raise VideoProcessError("This ComfyUI has no PyAV (av), which video needs.") from err
    return av


def open_video(path, mode="r", container_format=None):
    """av.open: reading is limited to local files (an HLS / concat playlist posing as a video
    can't reach the network); ``container_format`` forces the demuxer (no guessing)."""
    if mode == "w":
        return pyav().open(str(path), "w")
    return pyav().open(str(path), "r", format=container_format, options={"protocol_whitelist": "file"})


def audio_codec():
    """The WebM audio encoder this PyAV has (Opus, else Vorbis), or ""."""
    available = pyav().codecs_available
    return next((codec for codec in ("libopus", "libvorbis") if codec in available), "")


def require_encoder():
    """VideoProcessError unless this PyAV can write WebM video (VP9)."""
    if "libvpx-vp9" not in pyav().codecs_available:
        raise VideoProcessError("This ComfyUI's PyAV can't encode WebM (VP9).")


def target_size(width, height, megapixels):
    """The stored size: at most ``megapixels`` million (0 = as is), the aspect kept, both even
    (VP9 4:2:0) whenever it's scaled."""
    return megapixel_size(width, height, megapixels, even=True) if megapixels else (width, height)


def frame_rotation(frame, video):
    """A frame's display rotation in degrees counter-clockwise (a phone's flag), else the
    stream's old "rotate" tag (clockwise)."""
    turn = getattr(frame, "rotation", None) if frame is not None else None
    if turn:
        return int(round(float(turn)))
    tag = (video.metadata or {}).get("rotate")
    return -int(float(tag)) if tag else 0


def upright(array, turn):
    """``array`` (H, W, C) turned so it displays as the source's rotation flag says."""
    import numpy as np  # noqa: PLC0415 - ComfyUI's; only needed for video
    quarter = (int(round(turn / 90.0)) % 4)
    return np.ascontiguousarray(np.rot90(array, quarter)) if quarter else array


def decoded_frames(container, stream, alpha):
    """The stream's frames. VP9 alpha sits in WebM BlockAdditional side data, which only the
    libvpx decoder reads, so a VP9 stream with alpha decodes with it; a PyAV without libvpx
    gives the colour only (the caller's alpha flag says which). -> (frames, alpha)."""
    av = pyav()
    stream.thread_type = "AUTO"
    if alpha and stream.codec_context.name in ("vp9", "libvpx-vp9"):
        try:
            decoder = av.CodecContext.create("libvpx-vp9", "r")
        except Exception:  # noqa: BLE001 - this PyAV's FFmpeg has no libvpx
            print("[KRC Media] this PyAV has no libvpx decoder: the video's alpha is dropped")
            return container.decode(stream), False
        return (frame for packet in container.demux(stream) for frame in decoder.decode(packet)), True
    return container.decode(stream), alpha


def probe(path, container_format=None):
    """{"width", "height", "fps", "duration", "frames", "audio", "alpha"} for a video file
    (dimensions as displayed: a 90° rotation flag swaps them)."""
    try:
        with open_video(path, container_format=container_format) as container:
            video = next((stream for stream in container.streams if stream.type == "video"), None)
            if video is None:
                raise VideoProcessError("That file has no video stream.")
            width, height = int(video.codec_context.width or 0), int(video.codec_context.height or 0)
            fps = float(video.average_rate or video.guessed_rate or 0)
            pix_fmt = str(video.codec_context.pix_fmt or "")
            alpha = "a" in pix_fmt.replace("gray", "") or bool((video.metadata or {}).get("alpha_mode"))
            audio = any(stream.type == "audio" for stream in container.streams)
            try:
                first = next(container.decode(video), None)
            except Exception:  # noqa: BLE001 - an unreadable first frame: no rotation
                first = None
            if abs(frame_rotation(first, video)) % 180 == 90:
                width, height = height, width
            duration = float(video_span(container, video))   # after the first frame: it may read to the end
            frames = int(video.frames or 0) or (round(duration * fps) if fps and duration else 0)
    except VideoProcessError:
        raise
    except Exception as err:  # noqa: BLE001 - PyAV's errors vary by version
        raise VideoProcessError("That file couldn't be read as a video.") from err
    return {"width": width, "height": height, "fps": round(fps, 3), "duration": round(duration, 3),
            "frames": frames, "audio": audio, "alpha": alpha}


def timeline_origin(stream):
    """The stream's own first timestamp, exact (seconds, a Fraction). Trims, seeks and frame
    times are measured from it, so a video whose timestamps start at 5 s behaves like one
    that starts at 0."""
    if stream.start_time is not None and stream.time_base:
        return stream.start_time * stream.time_base
    return Fraction(0)


def video_span(container, stream):
    """How long the video stream itself runs, exact (seconds from its origin). The stream's
    recorded duration when the file has one (MP4 does); else (MKV / WebM often don't) the
    end of its last packet, read from the packets without decoding: never the container's
    length, which a longer audio track stretches. 0 when unknown."""
    if stream.duration and stream.time_base:
        return stream.duration * stream.time_base
    origin, end = timeline_origin(stream), None
    container.seek(0, stream=stream, backward=True)
    for packet in container.demux(stream):
        if packet.pts is None or not packet.time_base:
            continue
        ticks = packet.duration or 0
        packet_end = (packet.pts + ticks) * packet.time_base if ticks else packet.pts * packet.time_base + 1 / Fraction(source_frame_rate(stream) or 30)
        end = packet_end if end is None or packet_end > end else end
    return max(Fraction(0), end - origin) if end is not None else Fraction(0)


def exact(seconds):
    """Seconds as an exact Fraction (a float setting, to the microsecond)."""
    return seconds if isinstance(seconds, Fraction) else Fraction(seconds).limit_denominator(1_000_000)


def frame_time(frame, stream, origin):
    """``frame``'s time from ``origin``, exact, or None when it has no timestamp. (A frame
    from a hand-made decoder has no time base: its packet's, the stream's, applies.)"""
    if frame.pts is None:
        return None
    return frame.pts * (frame.time_base or stream.time_base) - origin


def seek_to(container, stream, start, origin=None):
    """Jump to the keyframe at or before ``start`` seconds from ``origin`` (the video's, by
    default this stream's own). The frames before ``start`` still decode; callers skip them."""
    if start > 0 and stream.time_base:
        target = (timeline_origin(stream) if origin is None else origin) + exact(start)
        container.seek(int(target / stream.time_base), stream=stream, backward=True)


def thumbnail(video, thumb, at_seconds):
    """A WebP card thumbnail (Pillow) of the frame on screen at ``at_seconds``: seek to the
    keyframe before it, then decode forward. Only ever made from a stored or saved video,
    which is upright."""
    try:
        with open_video(video) as container:
            stream = container.streams.video[0]
            origin, at = timeline_origin(stream), exact(max(0.0, at_seconds))
            seek_to(container, stream, at)
            picked = None
            for frame in container.decode(stream):
                when = frame_time(frame, stream, origin)
                if picked is not None and when is not None and when > at:
                    break
                picked = frame
            if picked is None:
                raise VideoProcessError("Couldn't make the thumbnail.")
            image = picked.to_image()
        thumb.parent.mkdir(parents=True, exist_ok=True)
        image = image.convert("RGBA" if "A" in image.mode else "RGB")
        image.thumbnail((THUMB_MAX, THUMB_MAX), Image.Resampling.LANCZOS)
        image.save(thumb, "WEBP", quality=80, method=4)
    except VideoProcessError:
        raise
    except Exception as err:  # noqa: BLE001 - PyAV's errors vary by version
        raise VideoProcessError("Couldn't make the thumbnail.") from err


def frame_slots(frames, stream, *, start, length, rate):
    """(source frame, rotation) for every output frame of a constant-``rate`` video. Output
    frame i is the source frame on screen at ``start`` + i / ``rate`` (exact: integer slots,
    Fraction times from the stream's origin), so frames drop or repeat only when the rate
    changes. ``length`` 0 = to the source's end: its last frame stays up for its own display
    duration (a GIF's frames each have their own)."""
    origin, start = timeline_origin(stream), exact(start)
    length = exact(length) if length else 0
    source_rate = source_frame_rate(stream) or rate
    previous, turn, index, last = None, 0, 0, Fraction(0)
    for frame in frames:
        when = frame_time(frame, stream, origin)
        at = (last if when is None else when - start)   # no timestamp: keep decode order
        if previous is None:
            turn = frame_rotation(frame, stream)
        if at <= 0:                 # on screen at the start (the latest one before it wins)
            previous, last = frame, at
            continue
        if length and at >= length:
            break
        while previous is not None and Fraction(index) / rate < at:
            yield previous, turn
            index += 1
        previous, last = frame, at
    if previous is None:
        raise VideoProcessError("That video has no frames to keep.")
    stop = length or (last + display_duration(previous, stream, source_rate))
    while Fraction(index) / rate < stop:
        yield previous, turn
        index += 1


def source_frame_rate(stream):
    """The rate that shows every source frame: the stream's base rate (ffmpeg's r_frame_rate:
    10 fps for a GIF of 100 / 100 / 800 ms frames, whose average is 3), unless that's an
    odd timing tick above 60 fps (a phone's variable-rate video), then the average."""
    base = getattr(stream, "base_rate", None) or stream.guessed_rate
    average = stream.average_rate or base
    return base if base and base <= 60 else average


def display_duration(frame, stream, fallback_rate):
    """How long ``frame`` stays on screen (exact): its own duration when the file gives one
    (every GIF frame does), else one frame at ``fallback_rate``."""
    ticks = getattr(frame, "duration", None)
    base = frame.time_base or stream.time_base
    if ticks and base:
        return ticks * base
    return 1 / Fraction(fallback_rate)


def output_frame(frame, turn, *, width, height, pix_fmt, alpha, index, rate):
    """``frame`` upright, at ``width`` x ``height`` in ``pix_fmt``, stamped as output frame
    ``index`` at ``rate``. reformat() can hand back the decoded frame itself, still in the
    source's time base, so the time base is set too (the encoder would rescale from it)."""
    av = pyav()
    pixel = "rgba" if alpha else "rgb24"
    if turn % 360:
        frame = av.VideoFrame.from_ndarray(upright(frame.to_ndarray(format=pixel), turn), format=pixel)
    out = frame.reformat(width=width, height=height, format=pix_fmt)
    out.pts, out.time_base = index, 1 / rate
    return out


def _audio_packets(source, audio_out, start, length, is_cancelled):
    """The kept span's audio, encoded by ``audio_out`` (48 kHz stereo) -> [packets]. Times
    are the video's (from its origin), so audio that starts late stays late: its first
    packet's timestamp keeps the gap. The encoder converts the sample format and frame size
    itself (Opus takes packed floats)."""
    import numpy as np  # noqa: PLC0415 - ComfyUI's; only needed for video
    av = pyav()
    rate = Fraction(AUDIO_RATE)
    start = exact(start)
    end = start + exact(length) if length else None
    resampler = av.AudioResampler(format="fltp", layout="stereo", rate=AUDIO_RATE)
    packets, written = [], None

    def keep(out, at):
        """Encode the part of resampled ``out`` (starting ``at``) inside [start, end)."""
        nonlocal written
        samples = out.to_ndarray()
        low = max(0, math.ceil((start - at) * rate))
        high = samples.shape[1] if end is None else min(samples.shape[1], math.floor((end - at) * rate))
        if high > low:
            if written is None:     # the first kept sample's place on the trimmed timeline
                written = round((at + Fraction(low) / rate - start) * rate)
            part = av.AudioFrame.from_ndarray(np.ascontiguousarray(samples[:, low:high]), format="fltp", layout="stereo")
            part.sample_rate, part.pts, part.time_base = AUDIO_RATE, written, Fraction(1, AUDIO_RATE)
            written += high - low
            packets.extend(audio_out.encode(part))

    with open_video(source) as container:
        origin = timeline_origin(container.streams.video[0])
        stream = next(item for item in container.streams if item.type == "audio")
        seek_to(container, stream, start, origin)
        position = None
        for frame in container.decode(stream):
            if is_cancelled():
                raise Cancelled()
            when = frame_time(frame, stream, origin)
            if when is not None and (position is None or abs(when - position) > Fraction(1, 10)):
                position = when         # the first frame, or a jump in the track
            elif position is None:
                position = Fraction(0)
            for out in resampler.resample(frame):
                keep(out, position)
                position += Fraction(out.samples) / rate
            if end is not None and position >= end:
                break
        for out in resampler.resample(None):
            if position is not None:
                keep(out, position)
                position += Fraction(out.samples) / rate
    packets.extend(audio_out.encode(None))
    return packets


def process(source, dest, thumb, *, trim_in=0.0, trim_out=0.0, fps=0, max_megapixels=0, max_length=0,
            audio=True, on_progress=lambda _value: None, is_cancelled=lambda: False):
    """Convert ``source`` to WebM at ``dest`` (+ a thumbnail). ``trim_out`` 0 = to the end;
    ``max_length`` (seconds, 0 = none) cuts the kept part after that long; ``max_megapixels``
    scales it down (0 = as is).
    -> the stored file's {"width", "height", "fps", "duration", "frames", "audio", "alpha",
    "bytes"}."""
    require_encoder()
    info = probe(source)
    duration = exact(info["duration"] or 0)
    start = exact(max(0.0, float(trim_in or 0)))
    end = exact(float(trim_out or 0))
    if duration and (end <= 0 or end >= duration):
        end = 0                      # to the source's end (its own last frame decides)
    if end and end <= start:
        raise VideoProcessError("Trim: the end must come after the start.")
    if not end and duration and start >= duration:
        raise VideoProcessError("Trim: the start is past the end of the video.")
    max_length = exact(_in_range(max_length, CUSTOM_LENGTH))
    if max_length and ((end or duration) - start > max_length or not (end or duration)):
        end = start + max_length
    length = (end - start) if end else 0   # 0 = to the source's end
    fps = _in_range(fps, CUSTOM_FPS)
    with open_video(source) as container:
        stream = container.streams.video[0]
        source_rate = source_frame_rate(stream)
        # The video's own end, exact: the kept audio stops there too, even on a longer track.
        video_end = video_span(container, stream) or duration
    rate = exact(fps) if fps else Fraction(source_rate or 30)
    codec = audio_codec() if audio and info["audio"] else ""
    width, height = target_size(info["width"], info["height"], max_megapixels)
    alpha = info["alpha"]
    total = math.ceil((length or max(0, duration - start)) * rate)
    dest.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open_video(dest, "w") as output:
            video_out = output.add_stream("libvpx-vp9", rate=rate)
            video_out.width, video_out.height = width, height
            video_out.pix_fmt = "yuva420p" if alpha else "yuv420p"
            video_out.options = dict(VP9_OPTIONS)
            audio_out = None
            if codec:
                audio_out = output.add_stream(codec, rate=AUDIO_RATE, layout="stereo")
                audio_out.bit_rate = AUDIO_BITRATE
            # The audio is encoded first (it's small), then muxed between the video frames.
            audio_length = length or max(Fraction(0), video_end - start)
            pending = deque(_audio_packets(source, audio_out, start, audio_length, is_cancelled) if audio_out is not None else [])
            count = 0

            def emit(frame, turn):
                """One output frame, then the audio that plays up to it (the file stays
                interleaved)."""
                nonlocal count
                if is_cancelled():
                    raise Cancelled()
                output.mux(video_out.encode(output_frame(frame, turn, width=width, height=height,
                                                         pix_fmt=video_out.pix_fmt, alpha=alpha, index=count, rate=rate)))
                count += 1
                while pending and pending[0].pts * pending[0].time_base <= Fraction(count) / rate:
                    output.mux(pending.popleft())
                if total:
                    on_progress(min(0.99, count / total))

            with open_video(source) as container:
                stream = container.streams.video[0]
                seek_to(container, stream, start)
                frames, alpha_read = decoded_frames(container, stream, alpha)
                if alpha and not alpha_read:
                    raise VideoProcessError("This ComfyUI's PyAV can't read that video's transparency (no libvpx).")
                for frame, turn in frame_slots(frames, stream, start=start, length=length, rate=rate):
                    emit(frame, turn)
            output.mux(video_out.encode(None))
            output.mux(list(pending))
    except (VideoProcessError, Cancelled):
        dest.unlink(missing_ok=True)
        raise
    except Exception as err:  # noqa: BLE001 - PyAV's errors vary by version
        dest.unlink(missing_ok=True)
        raise VideoProcessError(f"Couldn't convert that video ({str(err)[:200]}).") from err
    stored = probe(dest)
    thumbnail(dest, thumb, min(1.0, (stored["duration"] or 0) / 2))
    on_progress(1.0)
    return {**stored, "bytes": dest.stat().st_size}


def is_animated_image(path):
    """An animated GIF (several frames): converted as a video."""
    try:
        with Image.open(path) as image:
            return image.format == "GIF" and getattr(image, "n_frames", 1) > 1
    except OSError:
        return False
