"""Authenticated file delivery for ext/v1 (2026-11-09; KRC_EXTERNAL_API.md "Files").

The node's own file routes (/krc/media/file|thumb|download, the Prompt Vault, LoRA Loadout
and Model Library thumbnail routes) check no key: KRC Portal needs them. A client restricted
by an API profile gets its files here instead, where the same policy as the listings applies:

- **With the key** (``Authorization: Bearer``; for a server-side proxy such as KRC LC's):
  ``GET /krc/ext/v1/media/{id}/file`` (Range requests answered: video seeking works),
  ``/media/{id}/thumb[?w=]``, ``/media/{id}/download``, ``/prompts/{id}/thumbnail[?w=&kind=]``,
  ``/models/{id}/thumbnail[?w=&kind=]``.
- **With a file link** (``<img>`` / ``<video>`` elements can't send a header):
  ``POST /krc/ext/v1/files/links`` turns up to 100 of those into
  ``/krc/ext/v1/files/{token}`` links. A token names one file of one resource for one API
  profile and key, expires after LINK_SECONDS, and is checked again on every request:
  regenerating the key, disabling or deleting the profile, or any change to its policy (or
  the global switches) invalidates every link at once. A link never carries the API key.

What isn't readable answers 404, the same as a missing file.
"""
import base64
import hashlib
import hmac
import json
import secrets
import time

from . import ext_api, ext_api_policy as policy, ext_api_profiles as profiles
from .db import connection as db

SECRET_KEY = "ext_api.file_link_secret"
LINK_SECONDS = 15 * 60
MAX_LINKS = 100
KINDS = {"media": ("file", "thumb", "download"), "prompt": ("thumb",), "model": ("thumb",)}
LINK_PREFIX = "/krc/ext/v1/files/"
PRIVATE_CACHE = "private, max-age=600"


class FileDenied(Exception):
    """Not found / not readable: 404, the same either way."""


def _secret():
    """A random server secret for signing file links (made once, never sent anywhere)."""
    value = db.get_setting(db.connection(), SECRET_KEY, "")
    if isinstance(value, str) and len(value) >= 32:
        return value.encode("utf-8")
    with db.write() as conn:
        value = db.get_setting(conn, SECRET_KEY, "")
        if not (isinstance(value, str) and len(value) >= 32):
            value = secrets.token_hex(32)
            db.set_setting(conn, SECRET_KEY, value)
    return value.encode("utf-8")


def _b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def make_token(principal, kind, resource_id, variant, now=None):
    claims = {"p": principal.profile_id, "k": principal.key_id, "r": kind, "i": resource_id, "v": variant,
              "e": int((now if now is not None else time.time()) + LINK_SECONDS), "pr": principal.revision()}
    body = _b64(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signature = _b64(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
    return f"{body}.{signature}", claims["e"]


def read_token(token, now=None):
    """A link's token -> (Principal, kind, id, variant), or None when it's malformed,
    forged, expired, or its key / profile / policy changed since it was made."""
    try:
        body, signature = str(token or "").split(".", 1)
        expected = _b64(hmac.new(_secret(), body.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        claims = json.loads(_unb64(body))
    except (ValueError, TypeError):
        return None
    if not isinstance(claims, dict) or int(claims.get("e") or 0) < (now if now is not None else time.time()):
        return None
    if not ext_api.enabled():
        return None
    profile = next((p for p in profiles.load()["profiles"] if p.get("id") == claims.get("p")), None)
    key = (profile or {}).get("key")
    key = key if key and key.get("id") == claims.get("k") else None   # a regenerated key ends its links
    if profile is None or key is None or not profile.get("enabled"):
        return None
    principal = policy.Principal(profile, key)
    if principal.revision() != claims.get("pr") or claims.get("r") not in KINDS or claims.get("v") not in KINDS[claims["r"]]:
        return None
    return principal, claims["r"], str(claims.get("i") or ""), claims["v"]


# ---- what may be served (with the caller bound: ext_api_policy.current()) -------------------

def media_record(item_id):
    from .media import media_store as store

    try:
        record = store.get(item_id)
    except store.MediaError:
        record = None
    if record is None or not policy.media_item_readable(record):
        raise FileDenied()
    return record


def prompt_readable(record_id):
    if policy.unrestricted("prompts"):
        from .prompt_vault_store import prompt_owners
        if not prompt_owners([record_id]).get(record_id):
            raise FileDenied()
        return
    if not policy.readable_prompt_matches([record_id]).get(record_id):
        raise FileDenied()


async def model_readable(library_id):
    from .ext_api_models import _detail_rows, _indexes, _read

    index, lora_index = await _indexes()
    row = (await _read(lambda: _detail_rows(index, lora_index, [library_id]))).get(library_id)
    if row is None or not policy.model_row_readable(row):
        raise FileDenied()


KIND_CAPABILITY = {"media": "media.detail", "prompt": "prompts.byId", "model": "models.detail"}


def parse_links(payload):
    """POST /krc/ext/v1/files/links {items: [{kind, id, variant?}]} -> the entries (checked
    shape; whether each may be read is the route's job)."""
    if not isinstance(payload, dict) or not isinstance(payload.get("items"), list):
        raise ValueError('The body is {"items": [{"kind": "media" | "prompt" | "model", "id", "variant"}]}')
    items = payload["items"]
    if len(items) > MAX_LINKS:
        raise ValueError(f"At most {MAX_LINKS} items per call")
    out = []
    for entry in items:
        if not isinstance(entry, dict) or entry.get("kind") not in KINDS or not isinstance(entry.get("id"), str):
            raise ValueError("Each item is {kind: media | prompt | model, id, variant}")
        kind, resource_id = entry["kind"], entry["id"].strip()
        variant = entry.get("variant") or KINDS[kind][0]
        if variant not in KINDS[kind]:
            raise ValueError(f"variant for {kind}: one of {', '.join(KINDS[kind])}")
        out.append({"kind": kind, "id": resource_id, "variant": variant, "url": None})
    return out


async def readable(kind, resource_id):
    """Whether the bound caller may read this resource's files."""
    import asyncio

    p = policy.current()
    if p is not None and not p.capability_allowed(KIND_CAPABILITY[kind]):
        return False
    try:
        if kind == "media":
            await asyncio.to_thread(media_record, resource_id)
        elif kind == "prompt":
            await asyncio.to_thread(prompt_readable, resource_id)
        else:
            await model_readable(resource_id)
    except FileDenied:
        return False
    return True


def sign(entries, principal, now=None):
    """Signs the readable entries (``url`` set); the others keep ``url: null``."""
    expires = int((now if now is not None else time.time()) + LINK_SECONDS)
    for entry in entries:
        if entry.get("readable"):
            token, expires = make_token(principal, entry["kind"], entry["id"], entry["variant"], now)
            entry["url"] = LINK_PREFIX + token
        entry.pop("readable", None)
    return {"links": entries, "expires": expires, "seconds": LINK_SECONDS}


async def serve(web, kind, resource_id, variant, query):
    """The file itself, for the bound caller; FileDenied when it can't have it."""
    import asyncio
    from pathlib import Path

    from .library.thumbnail_sizes import parse_width, thumbnail_to_serve

    if not await readable(kind, resource_id):
        raise FileDenied()
    try:
        sized = parse_width(query) is not None
    except ValueError:
        sized = False
    if kind == "media":
        from .media import media_store as store
        from .media.media_routes import download_response

        record = await asyncio.to_thread(media_record, resource_id)
        if variant == "thumb":
            path = store.thumb_path(record["id"])
            if not path.is_file():
                raise FileDenied()
            return web.FileResponse(await thumbnail_to_serve(path, query),
                                    headers={"Content-Type": "image/webp", "Cache-Control": PRIVATE_CACHE})
        path = store.media_path(record)
        if not path or not path.is_file():
            raise FileDenied()
        if variant == "download":
            return await download_response(web, record, path)
        import mimetypes
        content_type = mimetypes.guess_type(path.name)[0] or ("video/webm" if record.get("kind") == "video" else "image/webp")
        # FileResponse answers Range requests itself (video seeking) and HEAD.
        return web.FileResponse(path, headers={"Content-Type": content_type, "Cache-Control": PRIVATE_CACHE})
    wanted = "poster" if sized else str(query.get("kind", "") or "")
    if kind == "prompt":
        from .prompt_vault_thumbnails import find_thumbnail_variant
        path = find_thumbnail_variant(resource_id, wanted)
    else:
        from .lora_loadout.library_index import LoraLibraryIndex
        from .lora_loadout.thumbnails import find_thumbnail_variant as find_lora_thumbnail_variant
        from .model_library.routes import _model_type_for_library_id, find_model_thumbnail_variant
        path = find_model_thumbnail_variant(resource_id, wanted or "default", _model_type_for_library_id(resource_id))
        if not path:
            lora = (await LoraLibraryIndex.loaded()).get(resource_id)
            if lora:
                path = find_lora_thumbnail_variant(lora.get("library_id"), wanted or "default")
    if not path:
        raise FileDenied()
    path = str(await thumbnail_to_serve(path, query))
    content_type = "video/webm" if Path(path).suffix.lower() == ".webm" else "image/webp"
    return web.FileResponse(path, headers={"Content-Type": content_type, "Cache-Control": PRIVATE_CACHE})
