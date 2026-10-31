"""Shared Civitai mapping plumbing (generic, node-agnostic).

The node-specific field mapping (Civitai blob -> LoRA sidecar vs -> generic model
record) stays in each node's own civitai_map. What's identical is the media-cache
location, the preview-object helpers, and the model->version graft that reshapes a
public by-hash response into the fuller shape the mappers expect.

See BACKEND_SHARED_EXTRACTION_GAMEPLAN.md (stage B6).
"""

import os
from pathlib import Path
from urllib.parse import urlparse

CIVITAI_MEDIA_SUBDIR = "civitai_media"
_VIDEO_PREVIEW_EXTS = (".mp4", ".webm")


def civitai_media_dir():
    """Where downloaded Civitai preview media (for thumbnail generation) is cached.

    Intentionally under the LoRA Loadout node dir (shared content location, same as the
    by-hash cache) so both nodes share one media cache; the path is a stable contract."""
    from ..krc_paths import get_krc_node_dir

    fallback = Path(__file__).resolve().parents[2] / ".krc_user" / "default"
    return get_krc_node_dir("lora_loadout", fallback=fallback) / CIVITAI_MEDIA_SUBDIR


def first_preview(response):
    """The first usable preview image object in a Civitai response, or None."""
    images = response.get("images") if isinstance(response, dict) else None
    if isinstance(images, list):
        for img in images:
            if isinstance(img, dict) and img.get("url"):
                return img
    return None


def preview_video_ext(img):
    """If the preview is a video, return its extension (e.g. '.mp4'); else None."""
    if not isinstance(img, dict):
        return None
    url = img.get("url") or ""
    ext = os.path.splitext(urlparse(url).path)[1].lower()
    if img.get("type") == "video" or ext in _VIDEO_PREVIEW_EXTS:
        return ext if ext in _VIDEO_PREVIEW_EXTS else ".mp4"
    return None


# Civitai's own site asks its media server for a video's poster with exactly these
# settings (civitai/civitai src/components/EdgeMedia/EdgeVideo.tsx → getEdgeUrl) and gets
# the first frame as a JPEG. Other combinations silently return the MP4, so a caller
# must still check the bytes (is_image_bytes). The server ignores the width here — the
# frame comes back at the video's own size.
_VIDEO_STILL_PARAMS = "anim=false,transcode=true,width=450,original=false,optimized=true"
_CIVITAI_MEDIA_HOST = "image.civitai.com"


def video_still_url(url):
    """The first-frame JPEG URL for a Civitai video preview URL
    (https://image.civitai.com/<key>/<uuid>/<params>/<name>.mp4), or "" when the URL
    isn't in that shape. Pure — no network."""
    parsed = urlparse(url or "")
    if parsed.scheme not in ("http", "https") or parsed.netloc.lower() != _CIVITAI_MEDIA_HOST:
        return ""
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) == 4:
        key, uuid, _params, name = parts
    elif len(parts) == 3:
        key, uuid, name = parts
    else:
        return ""
    stem = os.path.splitext(name)[0] or uuid
    return f"https://{_CIVITAI_MEDIA_HOST}/{key}/{uuid}/{_VIDEO_STILL_PARAMS}/{stem}.jpeg"


def first_still_image(response):
    """The first preview in a Civitai response that is a still image (not a video), or
    None. The no-ffmpeg fallback when the lead preview is a video."""
    images = response.get("images") if isinstance(response, dict) else None
    if isinstance(images, list):
        for img in images:
            if isinstance(img, dict) and img.get("url") and not preview_video_ext(img):
                return img
    return None


def is_image_bytes(data):
    """True for JPEG / PNG / WebP / GIF bytes — guards against a CDN answering an image
    request with the original video."""
    if not data or len(data) < 12:
        return False
    return (
        data[:3] == b"\xff\xd8\xff"
        or data[:8] == b"\x89PNG\r\n\x1a\n"
        or (data[:4] == b"RIFF" and data[8:12] == b"WEBP")
        or data[:6] in (b"GIF87a", b"GIF89a")
    )


def graft_model_into_version(version, model):
    """Fold model-level fields into a by-hash model-VERSION blob.

    The public by-hash endpoint returns only the model-version; its embedded `model`
    is just {name,type,nsfw,poi}. Creator, description, tags and the license/allow*
    fields live on GET /models/{id}. Grafting them in gives the mappers one response
    shape, so they fill creator / description / tags / license from it.

    Best-effort: a missing/failed model fetch just leaves the version blob as-is
    (name, trained words, images, base model, nsfwLevel still populate).
    """
    if not isinstance(version, dict) or not isinstance(model, dict):
        return version
    merged = dict(version)
    version_model = merged.get("model") if isinstance(merged.get("model"), dict) else {}
    # Drop the heavy nested version list; keep every model-level scalar/list we map.
    model_fields = {key: value for key, value in model.items() if key != "modelVersions"}
    # Model-endpoint values win (fuller), but keep version-only keys like `poi`.
    merged["model"] = {**version_model, **model_fields}
    # The mapper reads creator at the version top level; the model endpoint carries it.
    if model.get("creator") and not merged.get("creator"):
        merged["creator"] = model.get("creator")
    return merged


def civitai_model_url(model_id, version_id=None):
    """The Civitai model page for a by-hash hit, deep-linked to the version when known."""
    if not model_id:
        return ""
    url = f"https://civitai.com/models/{model_id}"
    if version_id:
        url = f"{url}?modelVersionId={version_id}"
    return url


def _civitai_files(response):
    files = response.get("files") if isinstance(response, dict) else None
    return files if isinstance(files, list) else []


def civitai_scanned_at(response):
    """Civitai's own scan date (files[].scannedAt, ISO-8601) of the response's primary
    (else first) file — a by-hash response's primary file IS the match; "" when absent.
    Distinct from our by-hash check time."""
    files = _civitai_files(response)
    file = (
        next((f for f in files if isinstance(f, dict) and f.get("primary")), None)
        or next((f for f in files if isinstance(f, dict)), None)
    )
    if not isinstance(file, dict):
        return ""
    return str(file.get("scannedAt") or "")


def civitai_verification(sha, model_id, version_id, checked_at, scanned_at=""):
    """The verification stamp for a successful Civitai by-hash match: the provider
    confirmed this exact file hash, so status is 'verified'. `scanned_at` is Civitai's
    own file scan date (see civitai_scanned_at). Shared by the LoRA and generic-model
    merge paths (utils/*/civitai_map.py)."""
    return {
        "status": "verified",
        "provider": "civitai",
        "hash": str(sha or ""),
        "checkedAt": checked_at,
        "scannedAt": str(scanned_at or ""),
        "resultUrl": civitai_model_url(model_id, version_id),
        "notes": "",
    }
