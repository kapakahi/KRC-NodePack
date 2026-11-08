"""Sources for the external API's previews (KRC_EXTERNAL_API.md "KRC Resizer"): the frames a
loader node would hand the next node, read the way that node reads them, so a provider can
fingerprint them exactly as the node it serves will. Nothing is executed, written or
changed: the source file is only read.

    {"kind": "media", "id": "<Media id>"}     what KRC Media Loader outputs for that item
                                              (nodes/krc_media_loader.load_media: stills,
                                              animated GIFs, WebM videos with their alpha)
    {"kind": "image", "image": "<name>"}      what ComfyUI's Load Image outputs for that
                                              value of its ``image`` input ("photo.png",
                                              "sub/photo.png", "x.png [output]")

Anything else (an upstream node's output) needs a run: not supported here, by design.

``identity(spec)`` is cheap (a stat): the file's id, size and modification time. A preview
remembers it; when it no longer matches, the preview is stale. ``loading(spec)`` decodes,
under one lock (one preparation at a time) and within MAX_PIXELS (frames x width x height).
"""
import os
import threading
from dataclasses import dataclass, field
from typing import Callable, Optional

MAX_PIXELS = 400_000_000          # e.g. 1080p x 190 frames; larger sources answer 413
LOAD_WAIT_S = 60                  # one preparation at a time; a waiting one gives up after this
_load_lock = threading.BoundedSemaphore(1)


class SourceError(ValueError):
    """A source the external API can't read: ``code`` is bad_request, not_found,
    unsupported, too_large or busy."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass
class Source:
    kind: str
    spec: dict
    identity: str
    label: str
    width: int
    height: int
    frame_count: int     # as known before reading (a video's from its record); a preview counts what it reads
    fps: Optional[float]
    _frames: Callable = field(repr=False, default=None)
    handle: str = ""     # the preview handle to store it under (handle_for(identity))

    def frames(self):
        """Every frame, in order, as a (height, width, 3) uint8 array: exactly the values
        the loader node's float tensor holds, times 255."""
        return self._frames()


def normalize(spec):
    """A request's source -> its canonical spec. SourceError("bad_request" / "unsupported")."""
    if not isinstance(spec, dict):
        raise SourceError("bad_request", "source must be an object: {kind: media, id} or {kind: image, image}")
    kind = spec.get("kind")
    if kind == "media":
        media_id = spec.get("id")
        if not isinstance(media_id, str) or not media_id.strip():
            raise SourceError("bad_request", "source.id must be a Media item id")
        return {"kind": "media", "id": media_id.strip()}
    if kind == "image":
        name = spec.get("image")
        if not isinstance(name, str) or not name.strip() or "\x00" in name:
            raise SourceError("bad_request", "source.image must be a Load Image file name")
        return {"kind": "image", "image": name.strip()}
    raise SourceError("unsupported", "Only Media items (kind media) and Load Image files (kind image) can be previewed "
                                     "without running the workflow")


# ---- Media (KRC Media Loader) ---------------------------------------------------------

def _media(spec):
    from .media import media_store as store

    try:
        record = store.get(spec["id"])
    except store.MediaError:
        record = None
    path = store.media_path(record) if record else None
    if not record or not path or not path.is_file():
        raise SourceError("not_found", "No Media item has that id, or its file is gone")
    return record, path


def _media_identity(spec):
    from ..nodes.krc_media_loader import media_identity

    _media(spec)
    return f"media:{media_identity(spec['id'])}"


def _load_media(spec):
    import numpy as np

    from ..nodes import krc_media_loader as loader

    record, path = _media(spec)
    width, height = int(record.get("width") or 0), int(record.get("height") or 0)
    frames_hint = int(record.get("frames") or 1)
    if width * height * max(1, frames_hint) > MAX_PIXELS:
        raise SourceError("too_large", f"That Media item is too large to preview here ({frames_hint} frames of {width} x {height})")
    label = f"Media {record.get('name') or spec['id']}"
    if record.get("kind") == "video":
        # The node's decode (krc_media_loader._video_frames), streamed: decoded_frames yields
        # one frame at a time, each converted the way the node converts it (rgba when the
        # stored video has alpha, else rgb24), so the values match.
        import itertools

        from .media.process_video import decoded_frames, open_video

        alpha = bool(record.get("alpha"))
        container = open_video(path)
        try:
            decoded, alpha = decoded_frames(container, container.streams.video[0], alpha)
            decoded = iter(decoded)
            first = next(decoded, None)
        except Exception as err:  # noqa: BLE001 - PyAV's errors vary by version
            container.close()
            raise SourceError("unsupported", f"Couldn't decode the video ({err})") from err
        if first is None:
            container.close()
            raise SourceError("unsupported", "The stored video has no frames")
        h, w = first.height, first.width

        def frames():
            try:
                for frame in itertools.chain((first,), decoded):
                    yield np.ascontiguousarray(frame.to_ndarray(format="rgba" if alpha else "rgb24")[..., :3])
            finally:
                container.close()

        fps = float(record.get("fps") or 0) or None
        return Source("media", spec, _media_identity(spec), label, w, h, frames_hint, fps, frames)
    image, _mask, _audio = loader.load_media(record, path, label)
    return _from_tensor("media", spec, _media_identity(spec), label, image, None)


# ---- Load Image (ComfyUI) -------------------------------------------------------------

def _image_path(spec):
    import folder_paths

    name = spec["image"]
    try:
        path = folder_paths.get_annotated_filepath(name)
    except Exception:  # noqa: BLE001
        path = None
    if not path or not os.path.isfile(path):
        raise SourceError("not_found", "No Load Image file has that name")
    # Only files inside ComfyUI's input / output / temp folders (what Load Image reads).
    real = os.path.realpath(path)
    bases = [folder_paths.get_input_directory(), folder_paths.get_output_directory(), folder_paths.get_temp_directory()]
    if not any(real == os.path.realpath(base) or real.startswith(os.path.realpath(base) + os.sep) for base in bases if base):
        raise SourceError("not_found", "No Load Image file has that name")
    return path


def _image_identity(spec):
    stat = os.stat(_image_path(spec))
    return f"image:{spec['image']}:{stat.st_mtime_ns}:{stat.st_size}"


def _load_image(spec):
    import nodes

    _image_path(spec)
    identity = _image_identity(spec)
    try:
        image = nodes.LoadImage().load_image(spec["image"])[0]
    except Exception as err:  # noqa: BLE001 - Pillow's errors vary
        raise SourceError("unsupported", f"Load Image can't read that file ({err})") from err
    return _from_tensor("image", spec, identity, f"Load Image {spec['image']}", image, None)


def _from_tensor(kind, spec, identity, label, image, fps):
    import numpy as np

    n, h, w = int(image.shape[0]), int(image.shape[1]), int(image.shape[2])
    if n * h * w > MAX_PIXELS:
        raise SourceError("too_large", f"That source is too large to preview here ({n} frames of {w} x {h})")

    def frames():
        for index in range(n):
            # v / 255 in float32, times 255, rounds back to v exactly.
            yield np.round(image[index].detach().cpu().numpy() * 255.0).clip(0, 255).astype(np.uint8)

    return Source(kind, spec, identity, label, w, h, n, fps, frames)


# ---- the two entry points -------------------------------------------------------------

def identity(spec):
    """The source's current identity (cheap). SourceError("not_found") when it's gone."""
    spec = normalize(spec)
    return _media_identity(spec) if spec["kind"] == "media" else _image_identity(spec)


class loading:   # noqa: N801 - a context manager named for how it reads
    """``with loading(spec) as source:`` -> a loaded Source (slow: off the event loop). One
    preparation at a time: the lock is held until the block ends (frames() consumed); another
    waits up to LOAD_WAIT_S, then SourceError("busy")."""

    def __init__(self, spec):
        self.spec = normalize(spec)

    def __enter__(self):
        if not _load_lock.acquire(timeout=LOAD_WAIT_S):
            raise SourceError("busy", "Another preview is being prepared; try again in a moment")
        try:
            return _load_media(self.spec) if self.spec["kind"] == "media" else _load_image(self.spec)
        except BaseException:
            _load_lock.release()
            raise

    def __exit__(self, *_exc):
        _load_lock.release()
        return False


def handle_for(identity_text):
    """A preview's handle: derived from the source identity, so the same unchanged source
    always gets the same handle and a changed one a new handle."""
    import hashlib
    return hashlib.sha256(identity_text.encode("utf-8")).hexdigest()[:32]
