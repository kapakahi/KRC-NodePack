"""KRC Media Loader (GAMEPLAN.md section 4): the node that reads media presets
(utils/preset_store.py: global stacks of exactly 6 slots, each a Media item). It loads one
slot of a preset: IMAGE, MASK, AUDIO.

It picks its preset and slot in the browser (the hidden ``loader_data`` widget); an
optional ``preset`` input (a STRING: an id, a name or "group/name") overrides the preset
("Follow": feed one preset string to several Loaders and they switch together, each keeping
its own slot). A still is a batch of 1 (MASK from alpha, else empty; AUDIO silent); a video
is its frames (MASK from alpha, else empty; AUDIO its track, else silent), decoded from the
stored WebM with PyAV (ComfyUI's own video library).

A queued run is pinned to the Media item that was in the slot when it was queued (the
browser adds it to ``loader_data`` as ``media``), so a hot swap or preset edit after
queueing doesn't change runs already in the queue, as with ComfyUI's Load Image. With
Follow (or without a pin) the run reads the preset when it starts.
"""

import hashlib
import json
import os

import numpy as np
import torch
from PIL import Image, ImageSequence

from ..utils.media import media_store as store
from ..utils.media import preset_store as presets
from ..utils.media.process_video import VideoProcessError, decoded_frames, frame_time, open_video, pyav, timeline_origin

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


def _video_frames(path, alpha):
    """Every frame as a uint8 array (RGBA when the stored WebM has alpha, else RGB)."""
    with open_video(path) as container:
        frames, alpha = decoded_frames(container, container.streams.video[0], alpha)
        return [frame.to_ndarray(format="rgba" if alpha else "rgb24") for frame in frames], alpha


def _audio_track(path):
    """The first audio track as float32 [2, samples] at SILENT_RATE, or None. It's placed on
    the video's timeline: audio that starts after the first frame gets leading silence
    (sample 0 = the first frame), audio that starts before it is cut there."""
    av = pyav()
    with open_video(path) as container:
        stream = next((stream for stream in container.streams if stream.type == "audio"), None)
        if stream is None:
            return None
        origin = timeline_origin(container.streams.video[0])
        resampler = av.AudioResampler(format="fltp", layout="stereo", rate=SILENT_RATE)
        chunks, lead = [], None
        for frame in container.decode(stream):
            if lead is None:
                when = frame_time(frame, stream, origin)
                lead = round(when * SILENT_RATE) if when is not None else 0
            chunks += [out.to_ndarray() for out in resampler.resample(frame)]
        chunks += [out.to_ndarray() for out in resampler.resample(None)]
    if not chunks:
        return None
    samples = np.concatenate(chunks, axis=1).astype(np.float32)
    if lead and lead > 0:
        samples = np.concatenate([np.zeros((samples.shape[0], lead), dtype=np.float32), samples], axis=1)
    elif lead and lead < 0:
        samples = samples[:, -lead:]
    return samples


def load_video(record, path):
    """(IMAGE [N,H,W,3], MASK [N,H,W], AUDIO) from a stored WebM, decoded with PyAV
    (ComfyUI's own video library); audio is 44.1 kHz stereo float."""
    try:
        decoded, alpha = _video_frames(path, bool(record.get("alpha")))
        pcm = _audio_track(path) if record.get("audio") else None
    except VideoProcessError as err:
        raise ValueError(str(err)) from err
    except Exception as err:  # noqa: BLE001 - PyAV's errors vary by version
        raise ValueError(f"Couldn't decode the video ({err}).") from err
    if not decoded:
        raise ValueError("The stored video has no frames.")
    frames = np.stack(decoded)
    image = frames[..., :3].astype(np.float32) / 255.0
    if alpha:
        mask = 1.0 - frames[..., 3].astype(np.float32) / 255.0
    else:
        mask = np.zeros(frames.shape[:3], dtype=np.float32)
    audio = _silent_audio()
    if pcm is not None and pcm.shape[1]:
        audio = {"waveform": torch.from_numpy(np.ascontiguousarray(pcm))[None], "sample_rate": SILENT_RATE}
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
    """{"preset", "slot" (0-5), "media" (the item pinned at queue time, or "")} from a
    Media Loader's widget."""
    raw = _json(loader_data, {})
    try:
        slot = int(raw.get("slot") or 0)
    except (TypeError, ValueError):
        slot = 0
    return {"preset": str(raw.get("preset") or ""), "slot": min(max(slot, 0), SLOTS - 1),
            "media": str(raw.get("media") or "")}


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
        if pick["media"] and preset is None:
            return f"pinned|{media_identity(pick['media'])}"
        return f"{pick['slot']}|{_preset_identity(pick['preset'])}|{_follow_identity(preset)}"

    def load(self, loader_data, preset=None):
        pick = parse_loader(loader_data)
        if pick["media"] and preset is None:
            # Pinned at queue time: the item the slot held then, wherever the preset is now.
            label = f"Slot {pick['slot'] + 1} (as queued)"
            item, path = slot_media(pick["media"], label)
            return load_media(item, path, label)
        record = pick_preset(pick["preset"], preset, "KRC Media Loader")
        slots = record["payload"]["slots"]
        index = pick["slot"]   # Follow: the same slot number in the arriving preset
        slot = slots[index]
        label = f'Preset "{record["name"]}" slot {index + 1}'
        item, path = slot_media(slot["id"], label)
        return load_media(item, path, label)


NODE_CLASS_MAPPINGS = {"KRC Media Loader": KRCMediaLoader}
NODE_DISPLAY_NAME_MAPPINGS = {"KRC Media Loader": "KRC Media Loader"}
