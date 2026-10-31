"""
KRC shared — Civitai metadata egress boundary.

THE ONLY FILE IN THE PACK THAT MAKES AN OUTBOUND NETWORK REQUEST (besides
hf_client.py). Keep it that way: no auth, guard-first, offline-safe. If this file
were deleted nothing else would break — the rest of the pack works with metadata
absent. Shared by LoRA Loadout and Model Library (a content hash is a hash
regardless of which node fetched it).

Two public Civitai endpoints, no API key (metadata needs none):
  GET /api/v1/model-versions/by-hash/{sha256}  — identity: version, trained words, images.
  GET /api/v1/models/{modelId}                 — model-level: creator, description, tags,
                                                 license. The by-hash `model` sub-object
                                                 is only {name,type,nsfw,poi}, so this
                                                 second call is what fills those fields.
The network-consent master switch is checked FIRST, before any socket opens — a disabled
switch means zero egress. Every request then goes through egress.get: https to Civitai /
Hugging Face hosts only, every redirect hop checked (preview URLs come from Civitai's answers).
"""
import asyncio
from pathlib import Path

try:
    import aiohttp
except ImportError:  # aiohttp ships with ComfyUI, but never assume
    aiohttp = None

from ..krc_network import network_enabled
from . import egress

CIVITAI_BY_HASH_URL = "https://civitai.com/api/v1/model-versions/by-hash/{}"
CIVITAI_MODEL_URL = "https://civitai.com/api/v1/models/{}"
_TIMEOUT_SECONDS = 10  # total, seconds — NOT rgthree's 5000ms-as-seconds bug
_CONNECT_TIMEOUT_SECONDS = 5  # fail fast when Civitai is unreachable
_MEDIA_TIMEOUT_SECONDS = 30  # preview media; give up rather than hang on a slow CDN
_MEDIA_CONNECT_TIMEOUT_SECONDS = 8


async def fetch_by_hash(sha256):
    """Fetch the Civitai model-version for a file's SHA-256.

    Returns a small status dict (never raises):
      {"status": "disabled"}                            consent off — no request made
      {"status": "unavailable"}                         no aiohttp / no hash
      {"status": "not_found", "url": ...}               404 — not on Civitai (or gated)
      {"status": "error", "detail": ..., "url": ...}    network/HTTP/parse failure
      {"status": "hit", "response": {...}, "url": ...}  success
    """
    # Guard FIRST — the server-side backstop to the UI's consent gate. A disabled
    # switch returns before a socket is ever opened.
    if not network_enabled():
        return {"status": "disabled"}
    if not sha256 or aiohttp is None:
        return {"status": "unavailable"}

    return await _get_json(CIVITAI_BY_HASH_URL.format(str(sha256).strip().lower()))


async def fetch_model(model_id):
    """Fetch a Civitai model object by id.

    The by-hash route returns only the model-*version*; its embedded `model` is just
    {name,type,nsfw,poi}. The model-level fields (creator, description, tags, and the
    license/allow* fields) live here on GET /models/{id}. Called as a second step
    after a by-hash hit to enrich the version blob to the shape the mapper expects.

    Same status-dict contract and guards as fetch_by_hash (never raises).
    """
    if not network_enabled():
        return {"status": "disabled"}
    if not model_id or aiohttp is None:
        return {"status": "unavailable"}
    return await _get_json(CIVITAI_MODEL_URL.format(str(model_id).strip()))


async def _get_json(url):
    """Shared GET→JSON with the boundary's timeout + status-dict contract.

    Callers must have already checked the guards (network_enabled, aiohttp present).
    Never raises — every failure becomes a status dict.
    """
    timeout = aiohttp.ClientTimeout(total=_TIMEOUT_SECONDS, sock_connect=_CONNECT_TIMEOUT_SECONDS)
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with await egress.get(session, url) as resp:
                if resp.status == 404:
                    return {"status": "not_found", "url": url}
                if resp.status != 200:
                    return {"status": "error", "detail": f"HTTP {resp.status}", "url": url}
                try:
                    data = await resp.json()
                except (aiohttp.ContentTypeError, ValueError) as err:
                    return {"status": "error", "detail": f"bad JSON: {err}", "url": url}
                return {"status": "hit", "response": data, "url": url}
    except asyncio.TimeoutError:
        return {"status": "error", "detail": "timeout", "url": url}
    except aiohttp.ClientError as err:
        return {"status": "error", "detail": str(err), "url": url}
    except Exception as err:  # never let the boundary crash a request handler
        return {"status": "error", "detail": str(err), "url": url}


async def download_media(url, dest_path):
    """Download a remote media URL (a Civitai preview image/video) to dest_path.

    Guard-first and offline-safe, same as fetch_by_hash — this is still egress, so it
    lives in the one boundary file. Streams to a .part temp then atomically renames.
    Returns True on success, False otherwise (never raises).
    """
    if not network_enabled() or not url or aiohttp is None:
        return False

    dest = Path(dest_path)
    tmp = dest.with_suffix(dest.suffix + ".part")
    timeout = aiohttp.ClientTimeout(total=_MEDIA_TIMEOUT_SECONDS, sock_connect=_MEDIA_CONNECT_TIMEOUT_SECONDS)
    try:
        dest.parent.mkdir(parents=True, exist_ok=True)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with await egress.get(session, url) as resp:
                if resp.status != 200:
                    return False
                with tmp.open("wb") as handle:
                    async for chunk in resp.content.iter_chunked(1 << 16):
                        handle.write(chunk)
        tmp.replace(dest)
        return True
    except Exception:
        try:
            tmp.unlink()
        except OSError:
            pass
        return False
