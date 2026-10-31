"""How much KRC accepts in one upload (import security, stage B).

ComfyUI's own request-size limit (--max-upload-size) only covers bodies read whole; KRC's
imports and video uploads stream multipart parts to disk, which nothing capped, so one
request could fill the disk. Every streamed upload goes through save_upload / copy_part /
read_part with a limit, and a request that says it's bigger (Content-Length) is refused
before anything is read. Over the limit -> UploadTooLarge (the route answers 413) and
the partial temp file is removed.
"""
import tempfile
from pathlib import Path

MIB = 1024 * 1024
BUNDLE_UPLOAD_MAX = 2048 * MIB  # an import .zip (the archive guard caps what it unpacks to)
VIDEO_UPLOAD_MAX = 512 * MIB    # a video thumbnail source
TEXT_UPLOAD_MAX = 16 * MIB      # one Word Bank .txt


class UploadTooLarge(ValueError):
    def __init__(self, limit):
        super().__init__(f"That file is too large (the limit is {limit // MIB} MB).")
        self.limit = limit


def check_declared_size(request, limit):
    """Refuse a request whose declared length is already over the limit."""
    length = getattr(request, "content_length", None)
    if length is not None and length > limit:
        raise UploadTooLarge(limit)


async def copy_part(part, handle, limit, written=0):
    """Stream one multipart part into ``handle``. -> bytes written so far (``written`` +
    this part). Raises UploadTooLarge past ``limit``."""
    while True:
        chunk = await part.read_chunk()
        if not chunk:
            return written
        written += len(chunk)
        if written > limit:
            raise UploadTooLarge(limit)
        handle.write(chunk)


async def read_part(part, limit):
    """One multipart part's bytes, at most ``limit`` of them."""
    data = bytearray()
    while True:
        chunk = await part.read_chunk()
        if not chunk:
            return bytes(data)
        data += chunk
        if len(data) > limit:
            raise UploadTooLarge(limit)


async def save_upload(request, limit, suffix=".upload"):
    """Save the request's first multipart part (or, when it isn't multipart, the raw body)
    to a temp file. -> its Path, or None when the request has no part. The caller removes
    the file. Raises UploadTooLarge, with nothing left on disk."""
    check_declared_size(request, limit)
    multipart = str(request.content_type or "").startswith("multipart/")
    field = None
    if multipart:
        reader = await request.multipart()
        field = await reader.next()
        if field is None:
            return None
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        path = Path(handle.name)
    try:
        with path.open("wb") as handle:
            if multipart:
                await copy_part(field, handle, limit)
            else:
                written = 0
                async for chunk in request.content.iter_chunked(1024 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise UploadTooLarge(limit)
                    handle.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path
