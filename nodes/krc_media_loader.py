"""KRC Media Loader (GAMEPLAN.md section 4): the node that reads media presets
(utils/preset_store.py: global stacks of exactly 6 slots, each a Media item). It loads one
slot of a preset: IMAGE, MASK, AUDIO.

It picks its preset and slot in the browser (the hidden ``loader_data`` widget); an
optional ``preset`` input (a STRING: an id, a name or "group/name") overrides the preset
("Follow": feed one preset string to several Loaders and they switch together, each keeping
its own slot). A still is a batch of 1 (MASK from alpha, else empty; AUDIO silent); a video
is its frames (MASK from alpha, else empty; AUDIO its track, else silent), decoded from the
stored WebM with NodePack's ffmpeg. The run reads the preset file, so it always loads what
the Media shows.
"""

import hashlib
import json
import os
import subprocess

import numpy as np
import torch
from PIL import Image, ImageSequence

from ..utils.media import media_store as store
from ..utils.media import preset_store as presets
from ..utils.media.process_video import VideoProcessError, ffmpeg

CATEGORY = "KRC NodePack"
SLOTS = presets.SLOT_COUNT
SILENT_RATE = 44100
FOLLOW_TOOLTIP = ("Follow: a preset's id or name (\"group/name\" too), e.g. from a preset output; "
                  "when connected it replaces the preset picked on the node.")


def _silent_audio():
    return {"waveform": torch.zeros((1, 1, 1), dtype=torch.float32), "sample_rate": SILENT_RATE}


def load_still(path):
    """(IMAGE [1,H,W,3], MASK [1,H,W]) from a stored WebP. The mask follows ComfyUI's
    LoadImage: 1 - alpha where transparent, all zeros without alpha."""
    with Image.open(path) as image:
        image.load()
        rgb = np.asarray(image.convert("RGB"), dtype=np.float32) / 255.0
        if image.mode == "RGBA":
            mask = 1.0 - np.asarray(image.getchannel("A"), dtype=np.float32) / 255.0
        else:
            mask = np.zeros(rgb.shape[:2], dtype=np.float32)
    return torch.from_numpy(rgb)[None], torch.from_numpy(mask)[None]


def _decode(command, what):
    try:
        done = subprocess.run(command, capture_output=True, timeout=3600)
    except (OSError, subprocess.SubprocessError) as err:
        raise ValueError(f"Couldn't decode the {what} ({err}).") from err
    if done.returncode != 0:
        reason = (done.stderr.decode("utf-8", "replace").strip().splitlines() or ["unknown error"])[-1]
        raise ValueError(f"Couldn't decode the {what} ({reason[:200]}).")
    return done.stdout


def load_video(record, path):
    """(IMAGE [N,H,W,3], MASK [N,H,W], AUDIO) from a stored WebM. VP9 alpha needs the libvpx
    decoder (ffmpeg's own drops it); audio is 44.1 kHz stereo float."""
    try:
        ffmpeg_bin, _ = ffmpeg(require_vp9=False)
    except VideoProcessError as err:
        raise ValueError(str(err)) from err
    width, height = int(record.get("width") or 0), int(record.get("height") or 0)
    if not width or not height:
        raise ValueError("The stored video has no size recorded.")
    alpha = bool(record.get("alpha"))
    base = [ffmpeg_bin, "-nostdin", "-loglevel", "error", "-protocol_whitelist", "file"]
    raw = _decode(base + (["-c:v", "libvpx-vp9"] if alpha else []) + ["-i", str(path), "-an", "-f", "rawvideo",
                                                                     "-pix_fmt", "rgba" if alpha else "rgb24", "pipe:1"], "video")
    channels = 4 if alpha else 3
    frame_bytes = width * height * channels
    count = len(raw) // frame_bytes
    if not count:
        raise ValueError("The stored video has no frames.")
    frames = np.frombuffer(raw[: count * frame_bytes], dtype=np.uint8).reshape(count, height, width, channels)
    image = frames[..., :3].astype(np.float32) / 255.0
    if alpha:
        mask = 1.0 - frames[..., 3].astype(np.float32) / 255.0
    else:
        mask = np.zeros((count, height, width), dtype=np.float32)
    audio = _silent_audio()
    if record.get("audio"):
        pcm = _decode(base + ["-i", str(path), "-vn", "-f", "f32le", "-ac", "2", "-ar", str(SILENT_RATE), "pipe:1"], "audio")
        samples = np.frombuffer(pcm, dtype=np.float32)
        if samples.size >= 2:
            stereo = samples[: samples.size - samples.size % 2].reshape(-1, 2).T.copy()
            audio = {"waveform": torch.from_numpy(stereo)[None], "sample_rate": SILENT_RATE}
    return torch.from_numpy(np.ascontiguousarray(image)), torch.from_numpy(np.ascontiguousarray(mask)), audio


def slot_media(media_id, label):
    """The (record, path) a slot loads; ValueError with a clear message otherwise."""
    if not media_id:
        raise ValueError(f"{label} is empty: send it a card in the KRC Portal's Media tab.")
    try:
        record = store.get(media_id)
    except store.MediaError:
        record = None
    path = store.media_path(record) if record else None
    if not record or not path.is_file():
        raise ValueError(f"{label}: its file is missing from Media (deleted or purged).")
    return record, path


def load_media(record, path, label):
    """(IMAGE, MASK, AUDIO) of one Media item; a decoding error names the slot."""
    if record.get("kind") == "video":
        try:
            return load_video(record, path)
        except ValueError as err:
            raise ValueError(f"{label}: {err}") from err
    if record.get("ext") == ".gif" and record.get("frames", 1) > 1:
        with Image.open(path) as image:
            frames = np.stack([np.asarray(frame.convert("RGBA")) for frame in ImageSequence.Iterator(image)])
        rgb = frames[..., :3].astype(np.float32) / 255.0
        mask = 1.0 - frames[..., 3].astype(np.float32) / 255.0
        return torch.from_numpy(rgb), torch.from_numpy(mask), _silent_audio()
    image, mask = load_still(path)
    return image, mask, _silent_audio()


def media_identity(media_id):
    """An item's id plus its stored file's identity, for IS_CHANGED."""
    try:
        record = store.get(media_id) if media_id else None
        path = store.media_path(record) if record else None
        stat = os.stat(path) if path else None
        return f"{media_id}:{stat.st_mtime_ns}:{stat.st_size}" if stat else f"{media_id}:-"
    except (OSError, store.MediaError):
        return f"{media_id}:-"


def _json(text, default):
    try:
        value = json.loads(text or "")
    except (TypeError, ValueError):
        return default
    return value if isinstance(value, type(default)) else default


def parse_loader(loader_data):
    """{"preset", "slot" (0-5)} from a Media Loader's widget."""
    raw = _json(loader_data, {})
    try:
        slot = int(raw.get("slot") or 0)
    except (TypeError, ValueError):
        slot = 0
    return {"preset": str(raw.get("preset") or ""), "slot": min(max(slot, 0), SLOTS - 1)}


def pick_preset(picked, follow, who):
    """The preset a node loads: the Follow input's when connected, else the picked one."""
    if follow is not None and str(follow).strip():
        found = presets.resolve(follow)
        if not found:
            raise ValueError(f'{who}: no media preset called "{str(follow).strip()[:60]}" (the preset input).')
        return found
    if not picked:
        raise ValueError(f"{who}: pick a media preset on the node.")
    try:
        found = presets.get(picked)
    except presets.PresetError:
        found = None
    if not found:
        raise ValueError(f"{who}: its media preset was deleted; pick another on the node.")
    return found


def _follow_identity(follow):
    # With Follow, the preset is only known at run time: any preset change re-runs.
    if follow is None:
        return ""
    data = json.dumps(presets.presets(), sort_keys=True)
    return f"follow:{follow}:{hashlib.sha1(data.encode('utf-8')).hexdigest()}"


def _preset_identity(preset_id):
    try:
        found = presets.get(preset_id) if preset_id else None
    except presets.PresetError:
        found = None
    if not found:
        return f"{preset_id}:-"
    slots = found["payload"]["slots"]
    return "|".join([preset_id] + [media_identity(slot["id"]) for slot in slots])


class KRCMediaLoader:
    """One slot of a media preset: the image / video loader."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "loader_data": ("STRING", {
                    "default": "{}",
                    "tooltip": "Managed by the node: the media preset and slot it loads.",
                }),
            },
            "optional": {
                "preset": ("STRING", {"forceInput": True, "tooltip": FOLLOW_TOOLTIP}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "AUDIO")
    RETURN_NAMES = ("image", "mask", "audio")
    FUNCTION = "load"
    CATEGORY = CATEGORY
    DESCRIPTION = ("Loads an image or video from the KRC Portal's Media tab: one slot of a media preset "
                   "(pick the preset and slot on the node; Upload puts a file straight into the slot). Feed the same preset "
                   "string into several Loaders' preset input to switch them together.")

    @classmethod
    def IS_CHANGED(cls, loader_data, preset=None):
        pick = parse_loader(loader_data)
        return f"{pick['slot']}|{_preset_identity(pick['preset'])}|{_follow_identity(preset)}"

    def load(self, loader_data, preset=None):
        pick = parse_loader(loader_data)
        record = pick_preset(pick["preset"], preset, "KRC Media Loader")
        slots = record["payload"]["slots"]
        index = pick["slot"]   # Follow: the same slot number in the arriving preset
        slot = slots[index]
        label = f'Preset "{record["name"]}" slot {index + 1}'
        item, path = slot_media(slot["id"], label)
        return load_media(item, path, label)


NODE_CLASS_MAPPINGS = {"KRC Media Loader": KRCMediaLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"KRC Media Loader": "KRC Media Loader"}
