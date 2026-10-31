"""
KRC shared — a still thumbnail for a Civitai video preview WITHOUT PyAV.

When this server can't cut a poster from a video (no PyAV / no Pillow), the
thumbnail comes from Civitai instead, in order:
  A. Civitai's own first-frame JPEG of the preview video (video_still_url);
  B. the first still image in the version's preview list.
If neither works the caller keeps its old path (save the video, poster pending).

The result is FINAL: a normal static thumbnail. Force Refresh on a server that has
PyAV re-runs the video pipeline and replaces it with a poster / loop.
"""
from .civitai_client import download_media
from .civitai_map import civitai_media_dir, first_still_image, is_image_bytes, video_still_url


async def _download_image(url, dest):
    if not url or not await download_media(url, dest):
        return None
    try:
        data = dest.read_bytes()
    except OSError:
        return None
    if is_image_bytes(data):
        return data
    try:
        dest.unlink()  # the CDN answered with something else (e.g. the video itself)
    except OSError:
        pass
    return None


async def fetch_video_still(preview, response, stem):
    """→ (image bytes, saved path, "frame" | "image") or None. `stem` names the file
    in the shared Civitai media cache (the library id)."""
    media_dir = civitai_media_dir()
    frame_url = video_still_url((preview or {}).get("url") or "")
    if frame_url:
        dest = media_dir / f"{stem}.frame.jpeg"
        data = await _download_image(frame_url, dest)
        if data is not None:
            return data, dest, "frame"
    still = first_still_image(response)
    if still:
        from pathlib import Path
        from urllib.parse import urlparse

        ext = Path(urlparse(still["url"]).path).suffix.lower() or ".jpg"
        dest = media_dir / f"{stem}.still{ext}"
        data = await _download_image(still["url"], dest)
        if data is not None:
            return data, dest, "image"
    return None
