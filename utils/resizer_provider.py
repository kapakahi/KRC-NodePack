"""KRC Resizer's part of the external API (ext_api_resizer.py calls PROVIDER directly; it
keeps the public API's provider interface 1 shape). The routes own the switch and key, the
sources and their staleness; this owns what is the Resizer's:

- a preview: every frame of a source as a JPEG (fit inside PREVIEW_MAX_EDGE, never
  enlarged), and the node's own fingerprint of it (resizer_state.media_signature), kept in
  memory under the handle NodePack gives;
- settings: structured settings <-> the node's inputs (resizer_state.build_inputs /
  read_settings), the same parser and stale rule the node runs with.

Previews live in memory only (none survive a restart), at most MAX_PREVIEWS of them and
MAX_BYTES of JPEG in all (least recently used dropped first), each for IDLE_S after its last
use. The node's own preview cache (nodes/krc_resizer.py, by node id) is separate and unchanged.
"""
import io
import threading
import time
from collections import OrderedDict

from . import resizer_state

PREVIEW_MAX_EDGE = 1280
JPEG_QUALITY = 85
MAX_PREVIEWS = 16
MAX_BYTES = 256 * 1024 * 1024
IDLE_S = 30 * 60


def _jpeg(frame, size):
    from PIL import Image

    image = Image.fromarray(frame)
    if image.size != size:
        image = image.resize(size, Image.Resampling.BILINEAR)
    buffer = io.BytesIO()
    image.save(buffer, format="JPEG", quality=JPEG_QUALITY)
    return buffer.getvalue()


def preview_size(width, height, limit=PREVIEW_MAX_EDGE):
    """The preview frames' size: the source fit inside ``limit``, never enlarged."""
    scale = min(1.0, limit / max(width, height))
    return max(1, round(width * scale)), max(1, round(height * scale))


class ResizerProvider:
    PROVIDER_API = 1
    VERSION = "1.0"
    PACK = "krc-nodepack"
    CAPABILITIES = ("resizer.previews", "resizer.settings")

    def __init__(self):
        self._previews = OrderedDict()   # handle -> {"meta", "frames", "used"}
        self._lock = threading.Lock()

    # ---- previews -----------------------------------------------------------------

    def prepare(self, source):
        """Read every frame of ``source`` (NodePack's Source: frames() yields (H, W, 3) uint8)
        once: fingerprint it as the node will, keep it as JPEG previews. -> the preview."""
        size = preview_size(source.width, source.height)
        frames, first, last, count = [], None, None, 0
        for frame in source.frames():
            if frame.shape[0] != source.height or frame.shape[1] != source.width:
                raise ValueError("The source's frames don't all have the same size")
            if first is None:
                first = frame
            last = frame
            frames.append(_jpeg(frame, size))
            count += 1
        if not count:
            raise ValueError("The source has no frames")
        if source.width < 32 or source.height < 32:
            raise ValueError(f"The source ({source.width} x {source.height}) is too small for KRC Resizer (at least 32 x 32)")
        signature = resizer_state.media_signature(count, source.height, source.width,
                                                  lambda index: first if index == 0 else last)
        now = time.time()
        meta = {
            "handle": source.handle, "source": dict(source.spec), "identity": source.identity,
            "width": source.width, "height": source.height, "frameCount": count, "mediaSig": signature,
            "fps": source.fps, "previewWidth": size[0], "previewHeight": size[1],
            "bytes": sum(len(data) for data in frames), "createdMs": int(now * 1000),
        }
        with self._lock:
            self._previews.pop(source.handle, None)
            self._previews[source.handle] = {"meta": meta, "frames": frames, "used": now}
            self._evict(now)
        return self._answer(meta, now)

    def get(self, handle):
        now = time.time()
        with self._lock:
            self._evict(now)
            entry = self._previews.get(handle)
            if entry is None:
                return None
            entry["used"] = now
            self._previews.move_to_end(handle)
            return self._answer(entry["meta"], now)

    def frame(self, handle, index):
        now = time.time()
        with self._lock:
            entry = self._previews.get(handle)
            if entry is None or not 0 <= index < len(entry["frames"]):
                return None
            entry["used"] = now
            self._previews.move_to_end(handle)
            return entry["frames"][index]

    def drop(self, handle):
        with self._lock:
            self._previews.pop(handle, None)

    @staticmethod
    def _answer(meta, used):
        return {**meta, "expiresMs": int((used + IDLE_S) * 1000)}

    def _evict(self, now):
        for handle in [h for h, entry in self._previews.items() if now - entry["used"] > IDLE_S]:
            self._previews.pop(handle, None)
        total = sum(entry["meta"]["bytes"] for entry in self._previews.values())
        while len(self._previews) > 1 and (len(self._previews) > MAX_PREVIEWS or total > MAX_BYTES):
            _handle, entry = self._previews.popitem(last=False)
            total -= entry["meta"]["bytes"]

    # ---- settings -----------------------------------------------------------------

    def build_inputs(self, identity, settings):
        inputs, normalized = resizer_state.build_inputs(identity, settings)
        return {"inputs": inputs, "settings": normalized}

    def read_settings(self, inputs, identity):
        return resizer_state.read_settings(inputs, identity)


PROVIDER = ResizerProvider()
